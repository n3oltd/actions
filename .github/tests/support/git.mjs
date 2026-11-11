import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const app = {
  name: "n3o-source-sync[bot]",
  email: "354428725+n3o-source-sync[bot]@users.noreply.github.com",
};

export function workspace() {
  return mkdtempSync(join(tmpdir(), "n3o-sync-test-"));
}

export function gitConfig(root, remotes) {
  const path = join(root, "gitconfig");
  const lines = [
    "[user]",
    `  name = ${app.name}`,
    `  email = ${app.email}`,
    "[init]",
    "  defaultBranch = main",
    '[protocol "file"]',
    "  allow = always",
    "[advice]",
    "  detachedHead = false",
    ...Object.entries(remotes).flatMap(([repo, bare]) => [
      `[url "file://${bare}"]`,
      `  insteadOf = https://github.com/${repo}.git`,
    ]),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  process.env.GIT_CONFIG_GLOBAL = path;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return path;
}

export function git(cwd, args, { input, env } = {}) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function as(person) {
  return {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
  };
}

export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function commit(cwd, message, files, person) {
  write(cwd, files ?? {});
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", message], { env: person && as(person) });
  return git(cwd, ["rev-parse", "HEAD"]);
}
