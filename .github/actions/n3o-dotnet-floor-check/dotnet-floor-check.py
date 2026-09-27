#!/usr/bin/env python3
"""Check that every .NET SDK the estate builds with satisfies every floor it declares.

An SDK version is asserted in more than one place: a repository's global.json declares the
floor it must be built with, and each build environment installs some SDK to meet it. Nothing
relates the two, and `rollForward` only ever rolls up, so an environment one patch behind a
floor is a hard failure rather than a downgrade.

The two sides are discovered rather than listed. Every repository the workload catalogue names
as a source is read whole; anything shaped like a floor or like an SDK install is picked out by
pattern, so a new one is found the day it is added. What that does not cover is stated by
--explain, and is the answer to "is this coverage or a list".
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

ORG = "n3oltd"

# A tag with three components pins an SDK; one with two follows the newest patch in its band and
# cannot fall behind a floor, so it is reported and never failed.
SDK_IMAGE = re.compile(r"^\s*FROM\s+mcr\.microsoft\.com/dotnet/sdk:(?P<tag>[\w.+-]+)", re.M)
SDK_CHANNEL = re.compile(r"--channel\s+[\"']?\$?\{?(?P<arg>[A-Z_]+)\}?[\"']?|--channel\s+[\"']?(?P<lit>[\d.]+)")
DOCKER_ARG = re.compile(r"^\s*ARG\s+(?P<name>[A-Z_]+)=(?P<value>\S+)", re.M)

DOCKERFILE_NAME = re.compile(r"(^|/)(Dockerfile([.-][\w.-]+)?|[\w.-]+\.Dockerfile)$")

# Where the shared Dockerfile catalogue lives, as n3o-dockerfile-fetch addresses it. Move the
# catalogue and this moves with it.
CATALOGUE_REPO = "actions"
CATALOGUE_DIRECTORY = "docker"
IN_CATALOGUE = re.compile(rf"^{CATALOGUE_DIRECTORY}/[^/]+$")
PRUNE = re.compile(r"(^|/)(node_modules|\.git|bin|obj)/")


def gh(path: str, raw: bool = False) -> object:
    cmd = ["gh", "api", path]
    if raw:
        cmd += ["-H", "Accept: application/vnd.github.raw"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out.stdout if raw else json.loads(out.stdout)


def version(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", text))


def source_repositories(catalogue: pathlib.Path) -> list[str]:
    """Repositories the workload catalogue names as a source, read from a checkout of it.

    Two hundred and fifty manifests over the contents API is minutes; the catalogue is cloned
    for the same reason the dashboards clone the deployment targets.
    """
    found = set()
    for manifest in [*catalogue.glob("workloads/*/*.yml"), *catalogue.glob("manifests/libraries/*.yml")]:
        match = re.search(r"^sourceRepository:\s*(\S+)", manifest.read_text(errors="replace"), re.M)
        if match:
            found.add(match.group(1).strip("'\""))
    if not found:
        raise SystemExit(f"::error::no sourceRepository found under {catalogue}; "
                         "this is not a checkout of the workload catalogue")
    return sorted(found)


def catalogue_names(checkouts: dict[str, pathlib.Path]) -> set[str]:
    """Names in the shared Dockerfile catalogue.

    n3o-dockerfile-fetch writes a catalogue image to a bare name and prefers a copy the calling
    repository has committed at that path, so the name is the only thing identifying one
    wherever it lands.
    """
    root = checkouts.get(CATALOGUE_REPO)
    if root:
        directory = root / CATALOGUE_DIRECTORY
        return {f.name for f in directory.iterdir() if f.is_file()} if directory.is_dir() else set()

    tree = gh(f"repos/{ORG}/{CATALOGUE_REPO}/git/trees/HEAD?recursive=1")["tree"]
    return {pathlib.PurePath(n["path"]).name for n in tree
            if n["type"] == "blob" and IN_CATALOGUE.match(n["path"])}


def asserts_a_version(path: str, catalogue: set[str]) -> bool:
    """A floor, a Dockerfile, or a repository's own copy of a catalogue image.

    Anything directly inside a docker/ directory counts as a Dockerfile — the shared catalogue
    names its images without an extension, and a name-only rule would miss every one of them.
    """
    if PRUNE.search("/" + path):
        return False
    return bool(path.endswith("global.json") or DOCKERFILE_NAME.search(path)
                or IN_CATALOGUE.match(path) or pathlib.PurePath(path).name in catalogue)


def source(repo: str, checkouts: dict[str, pathlib.Path], catalogue: set[str]):
    """Where a repository's contents are read from: a checkout when one is given, else HEAD.

    A pull request's own change is only visible in its checkout. Reading the caller from HEAD
    would pass every proposal and fail only once merged, which is the difference between
    preventing this and reporting it.
    """
    root = checkouts.get(repo)
    if root:
        # Tracked files only. A walk of the working tree is minutes on a monorepo and picks up
        # nested checkouts and build output, where an uncommitted global.json is not a floor.
        try:
            listing = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                                     capture_output=True, text=True, check=True)
        except subprocess.CalledProcessError as error:
            raise SystemExit(f"::error::--checkout {repo}={root} is not a git checkout, so nothing "
                             f"can be listed from it: {error.stderr.strip()}")
        paths = [p for p in listing.stdout.split("\0") if p and asserts_a_version(p, catalogue)]
        return sorted(paths), lambda p: (root / p).read_text(errors="replace")

    tree = gh(f"repos/{ORG}/{repo}/git/trees/HEAD?recursive=1")["tree"]
    paths = [n["path"] for n in tree
             if n["type"] == "blob" and asserts_a_version(n["path"], catalogue)]
    return sorted(paths), lambda p: gh(f"repos/{ORG}/{repo}/contents/{p}", raw=True)


def scan(repo: str, checkouts: dict[str, pathlib.Path],
         catalogue: set[str]) -> tuple[list[dict], list[dict]]:
    floors, installs = [], []
    paths, read = source(repo, checkouts, catalogue)
    for path in paths:
        body = read(path)

        if path.endswith("global.json"):
            try:
                declared = json.loads(body).get("sdk", {}).get("version")
            except json.JSONDecodeError:
                declared = None
            if declared:
                floors.append({"repo": repo, "path": path, "version": declared})
            continue

        args = {m.group("name"): m.group("value") for m in DOCKER_ARG.finditer(body)}
        for match in SDK_IMAGE.finditer(body):
            tag = match.group("tag")
            installs.append({"repo": repo, "path": path, "version": tag,
                             "pinned": len(re.findall(r"\d+", tag.split("-")[0])) >= 3,
                             "how": "image tag"})
        for match in SDK_CHANNEL.finditer(body):
            channel = match.group("lit") or args.get(match.group("arg"), match.group("arg"))
            installs.append({"repo": repo, "path": path, "version": channel,
                             "pinned": len(re.findall(r"\d+", channel)) >= 3,
                             "how": "install channel"})
    return floors, installs


def violations(floors: list[dict], installs: list[dict]) -> list[dict]:
    """A pinned install below the highest floor sharing its major cannot build that repository."""
    highest: dict[int, dict] = {}
    for floor in floors:
        major = version(floor["version"])[0]
        if major not in highest or version(floor["version"]) > version(highest[major]["version"]):
            highest[major] = floor

    out = []
    for install in installs:
        if not install["pinned"]:
            continue
        major = version(install["version"])[0]
        floor = highest.get(major)
        if floor and version(install["version"]) < version(floor["version"]):
            out.append({"install": install, "floor": floor})
    return out


EXPLAIN = """\
Discovered, so a new one is found the day it is added:
  * a floor written as "sdk": { "version": ... } in any global.json
  * an SDK installed as FROM mcr.microsoft.com/dotnet/sdk:<tag>
  * an SDK installed by dotnet-install --channel
  * a repository's own copy of a shared catalogue image, matched by its name wherever it sits,
    because n3o-dockerfile-fetch prefers a committed copy over the catalogue's

Not covered, and these would be missed:
  * an SDK installed by any other means — an apt package, a version baked into a base image
    this estate does not build, a devcontainer feature
  * whether a floating install is actually current. A two-component tag or channel carries the
    newest patch in its band at the time it was built, so it cannot be below a floor by
    construction; an environment that has not rebuilt for a month can be. That is staleness,
    not drift, and it is not visible from a repository's contents
  * a repository the workload catalogue does not name as a source\
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue", type=pathlib.Path, required=True,
                        help="a checkout of the repository holding the workload catalogue")
    parser.add_argument("--checkout", action="append", default=[], metavar="REPO=PATH",
                        help="read this repository from a checkout rather than from HEAD")
    parser.add_argument("--explain", action="store_true", help="print what is and is not covered")
    args = parser.parse_args()

    checkouts = {}
    for pair in args.checkout:
        name, _, path = pair.partition("=")
        resolved = pathlib.Path(path).resolve()
        if not resolved.is_dir():
            print(f"::error::--checkout {pair}: {resolved} is not a directory", file=sys.stderr)
            return 2
        checkouts[name] = resolved

    repos = sorted(set(source_repositories(args.catalogue)) | set(checkouts))
    described = [f"{r} (checkout)" if r in checkouts else r for r in repos]
    print(f"scanning {len(repos)} repositories: {', '.join(described)}", file=sys.stderr)

    floors: list[dict] = []
    installs: list[dict] = []
    catalogue = catalogue_names(checkouts)
    for repo in repos:
        found_floors, found_installs = scan(repo, checkouts, catalogue)
        floors += found_floors
        installs += found_installs

    print("\nFloors declared")
    for floor in sorted(floors, key=lambda f: (f["repo"], f["path"])):
        print(f"  {floor['version']:<16} {ORG}/{floor['repo']} {floor['path']}")

    print("\nSDKs installed")
    for install in sorted(installs, key=lambda i: (i["repo"], i["path"])):
        shape = "pinned" if install["pinned"] else "follows the band"
        print(f"  {install['version']:<16} {shape:<17} {ORG}/{install['repo']} {install['path']} ({install['how']})")

    if args.explain:
        print("\n" + EXPLAIN)

    breaches = violations(floors, installs)
    if not breaches:
        print("\nEvery pinned SDK satisfies every floor of its major version.")
        return 0

    print()
    for breach in breaches:
        install, floor = breach["install"], breach["floor"]
        print(f"::error::{ORG}/{install['repo']} {install['path']} installs {install['version']}, "
              f"below the {floor['version']} floor {ORG}/{floor['repo']} {floor['path']} declares. "
              f"rollForward does not roll back, so every build in that environment fails.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
