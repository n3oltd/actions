#!/usr/bin/env python3
"""Check that every .NET SDK the estate builds with satisfies every floor it declares.

An SDK version is asserted in more than one place: a repository's global.json declares the
floor it must be built with, and each build environment installs some SDK to meet it. Nothing
relates the two, and rollForward only ever rolls up, so an environment one patch behind a
floor is a hard failure rather than a downgrade.

Both sides are discovered rather than listed. Every repository the workload catalogue names as
a source is read whole, and anything shaped like a floor or like an SDK install is picked out
by pattern, so a new one is found the day it is added. What that does not cover is printed by
--explain, and is the answer to "is this coverage or a list".
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ORG = "n3oltd"

# Where the shared Dockerfile catalogue lives, as n3o-dockerfile-fetch addresses it.
CATALOGUE_REPO = "actions"
CATALOGUE_DIRECTORY = "docker"
IN_CATALOGUE = re.compile(rf"^{CATALOGUE_DIRECTORY}/[^/]+$")

# FROM may carry flags before the image, and the tag may be a build argument.
SDK_IMAGE = re.compile(
    r"^\s*FROM\s+(?:--\S+\s+)*mcr\.microsoft\.com/dotnet/sdk:(?P<tag>\S+?)(?:\s|$)", re.M)
# dotnet-install --channel takes LTS, STS, A.B or A.B.Cxx. None of those name a patch.
SDK_CHANNEL = re.compile(r"--channel\s+[\"']?(?P<value>\$?\{?[\w.]+\}?)")
DOCKER_ARG = re.compile(r"^\s*ARG\s+(?P<name>\w+)=(?P<value>\S+)", re.M)
VARIABLE = re.compile(r"^\$\{?(?P<name>\w+)\}?$")

DOCKERFILE_NAME = re.compile(r"(^|/)(Dockerfile([.-][\w.-]+)?|[\w.-]+\.Dockerfile)$")
DOCKERFILE_OPENS = re.compile(r"^\s*(FROM|ARG|SYNTAX)\b", re.I)
PRUNE = re.compile(r"(^|/)(node_modules|\.git|bin|obj)/")
# A pre-release sorts below the release it precedes; a platform suffix such as -noble does not.
PRERELEASE = re.compile(r"-(?:preview|rc|alpha|beta|pre)\b", re.I)


class Unusable(Exception):
    """The check could not be carried out, which is not the same as a floor being breached."""


def git(root: pathlib.Path, *arguments: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *arguments],
                            capture_output=True, text=True)
    if result.returncode:
        raise Unusable(f"git {' '.join(arguments)} in {root}: {result.stderr.strip()}")
    return result.stdout


def version(text: str) -> tuple[int, ...]:
    """Comparable components: the leading release numbers, then 0 for a pre-release."""
    leading = re.match(r"\d+(?:\.\d+)*", text)
    if not leading:
        return ()
    numbers = tuple(int(part) for part in leading.group().split("."))
    return numbers + ((0,) if PRERELEASE.search(text) else (1,))


def working_tree(repo: str, checkouts: dict[str, pathlib.Path],
                 workdir: pathlib.Path) -> pathlib.Path:
    """A working tree for a repository: the one supplied, else a clone.

    The tree API is not used to list a repository. It truncates silently past roughly 45,000
    entries — n3oltd/backend exceeds that today — reporting it only in a field that is easy not
    to read, so a scan would announce complete coverage having seen part of the tree. A clone
    is complete or it fails.
    """
    if repo in checkouts:
        return checkouts[repo]

    target = workdir / repo
    if target.is_dir():
        return target

    result = subprocess.run(
        ["gh", "repo", "clone", f"{ORG}/{repo}", str(target),
         "--", "--depth", "1", "--filter=blob:none", "--no-checkout", "--quiet"],
        capture_output=True, text=True)
    if result.returncode:
        raise Unusable(f"cloning {ORG}/{repo}: {result.stderr.strip()}")
    return target


def tracked(root: pathlib.Path) -> list[str]:
    return [path for path in git(root, "ls-tree", "-r", "--name-only", "HEAD").split("\n") if path]


def read(root: pathlib.Path, path: str) -> str:
    return git(root, "show", f"HEAD:{path}")


def catalogue_names(root: pathlib.Path) -> set[str]:
    """Names in the shared Dockerfile catalogue.

    n3o-dockerfile-fetch writes a catalogue image to a bare name and prefers a copy the calling
    repository has committed at that path, so the name is the only thing identifying one
    wherever it lands.
    """
    return {pathlib.PurePath(path).name for path in tracked(root) if IN_CATALOGUE.match(path)}


def asserts_a_version(path: str, catalogue: set[str]) -> bool:
    """A floor, a Dockerfile, or a repository's own copy of a catalogue image."""
    if PRUNE.search("/" + path):
        return False
    return bool(path.endswith("global.json") or DOCKERFILE_NAME.search(path)
                or IN_CATALOGUE.match(path) or pathlib.PurePath(path).name in catalogue)


def is_a_dockerfile(body: str) -> bool:
    """Structure rather than extension, so prose documenting a FROM line is not read as one."""
    for line in body.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        return bool(DOCKERFILE_OPENS.match(stripped))
    return False


def floor_in(body: str) -> str | None:
    try:
        declared = json.loads(body)
    except json.JSONDecodeError:
        return None
    sdk = declared.get("sdk") if isinstance(declared, dict) else None
    return sdk.get("version") if isinstance(sdk, dict) else None


def installs_in(repo: str, path: str, body: str) -> list[dict]:
    arguments = {m.group("name"): m.group("value") for m in DOCKER_ARG.finditer(body)}

    def resolve(text: str) -> str | None:
        variable = VARIABLE.match(text)
        if not variable:
            return text
        return arguments.get(variable.group("name"))

    found = []
    for match in SDK_IMAGE.finditer(body):
        tag = resolve(match.group("tag"))
        found.append({"repo": repo, "path": path, "how": "image tag",
                      "version": tag or match.group("tag"),
                      # Three components name a patch; two follow the newest in a band.
                      "pinned": bool(tag) and len(version(tag)) >= 4,
                      "resolved": tag is not None})
    for match in SDK_CHANNEL.finditer(body):
        channel = resolve(match.group("value"))
        found.append({"repo": repo, "path": path, "how": "install channel",
                      "version": channel or match.group("value"),
                      # A channel names LTS, STS, A.B or A.B.Cxx — never a patch.
                      "pinned": False,
                      "resolved": channel is not None})
    return found


def scan(repo: str, root: pathlib.Path, catalogue: set[str]) -> tuple[list[dict], list[dict]]:
    floors, installs = [], []
    for path in sorted(p for p in tracked(root) if asserts_a_version(p, catalogue)):
        body = read(root, path)
        if path.endswith("global.json"):
            declared = floor_in(body)
            if declared:
                floors.append({"repo": repo, "path": path, "version": declared})
        elif is_a_dockerfile(body):
            installs += installs_in(repo, path, body)
    return floors, installs


def source_repositories(catalogue: pathlib.Path) -> list[str]:
    """Repositories the workload catalogue names as a source, read from a checkout of it."""
    found = set()
    for manifest in [*catalogue.glob("workloads/*/*.yml"),
                     *catalogue.glob("manifests/libraries/*.yml")]:
        match = re.search(r"^sourceRepository:\s*(\S+)", manifest.read_text(errors="replace"), re.M)
        if match:
            found.add(match.group(1).strip("'\""))
    if not found:
        raise Unusable(f"no sourceRepository found under {catalogue}; "
                       "this is not a checkout of the workload catalogue")
    return sorted(found)


def violations(floors: list[dict], installs: list[dict]) -> list[dict]:
    """A pinned install below the highest floor sharing its major cannot build that repository."""
    highest: dict[int, dict] = {}
    for floor in floors:
        components = version(floor["version"])
        if not components:
            continue
        major = components[0]
        if major not in highest or components > version(highest[major]["version"]):
            highest[major] = floor

    breaches = []
    for install in installs:
        components = version(install["version"])
        if not install["pinned"] or not components:
            continue
        floor = highest.get(components[0])
        if floor and components < version(floor["version"]):
            breaches.append({"install": install, "floor": floor})
    return breaches


EXPLAIN = """\
Every repository is listed from a clone, not from the trees API, which truncates silently past
roughly 45,000 entries and would have this report claim coverage of part of a tree.

Discovered, so a new one is found the day it is added:
  * a floor written as "sdk": { "version": ... } in any global.json
  * an SDK installed as FROM mcr.microsoft.com/dotnet/sdk:<tag>, including behind FROM flags
    and behind a build argument whose default is declared in the same file
  * an SDK installed by dotnet-install --channel
  * a repository's own copy of a shared catalogue image, matched by its name wherever it sits,
    because n3o-dockerfile-fetch prefers a committed copy over the catalogue's

Not covered, and these would be missed:
  * an SDK installed by any other means — an apt package, a version baked into a base image
    this estate does not build, a devcontainer feature
  * a tag whose build argument is supplied at build time rather than defaulted in the file. It
    is listed as unresolved and not compared, because its value is not in the repository
  * whether a floating install is actually current. A channel, or a tag naming a band rather
    than a patch, carries the newest patch in that band at the time it was built, so it cannot
    be below a floor by construction; an environment that has not rebuilt for a month can be.
    That is staleness, not drift, and it is not visible from a repository's contents
  * a repository the workload catalogue does not name as a source

When this runs as a pull request check it covers the repository it is called from. A floor
raised in one repository and an SDK pinned in another are two pull requests in two places; each
needs its own caller, and until both have one the other side is caught by the daily run rather
than refused at the point of change.\
"""


def report(floors: list[dict], installs: list[dict]) -> None:
    print("\nFloors declared")
    for floor in sorted(floors, key=lambda f: (f["repo"], f["path"])):
        print(f"  {floor['version']:<20} {ORG}/{floor['repo']} {floor['path']}")

    print("\nSDKs installed")
    for install in sorted(installs, key=lambda i: (i["repo"], i["path"])):
        if not install["resolved"]:
            shape = "unresolved"
        elif install["pinned"]:
            shape = "pinned"
        else:
            shape = "follows the band"
        print(f"  {install['version']:<20} {shape:<17} "
              f"{ORG}/{install['repo']} {install['path']} ({install['how']})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue", type=pathlib.Path, required=True,
                        help="a checkout of the repository holding the workload catalogue")
    parser.add_argument("--checkout", action="append", default=[], metavar="REPO=PATH",
                        help="read this repository from a checkout rather than from its clone")
    parser.add_argument("--explain", action="store_true", help="print what is and is not covered")
    args = parser.parse_args()

    checkouts = {}
    for pair in args.checkout:
        name, separator, path = pair.partition("=")
        if not separator or not name or not path:
            raise Unusable(f"--checkout {pair}: expected REPO=PATH")
        resolved = pathlib.Path(path).resolve()
        if not resolved.is_dir():
            raise Unusable(f"--checkout {pair}: {resolved} is not a directory")
        checkouts[name] = resolved

    repos = sorted(set(source_repositories(args.catalogue)) | set(checkouts))
    described = [f"{r} (checkout)" if r in checkouts else r for r in repos]
    print(f"scanning {len(repos)} repositories: {', '.join(described)}", file=sys.stderr)

    floors: list[dict] = []
    installs: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="dotnet-floor-check-") as temporary:
        workdir = pathlib.Path(temporary)
        catalogue = catalogue_names(working_tree(CATALOGUE_REPO, checkouts, workdir))
        for repo in repos:
            found_floors, found_installs = scan(
                repo, working_tree(repo, checkouts, workdir), catalogue)
            floors += found_floors
            installs += found_installs

    report(floors, installs)
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
    try:
        sys.exit(main())
    except Unusable as error:
        # Exit 2, never 1: "the check could not run" must not read as "a floor is breached".
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(2)
