import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { app, commit, git, gitConfig, workspace } from "./support/git.mjs";
import { runStep } from "./support/steps.mjs";

const monoRepo = "n3oltd/monorepo";
const clientRepo = "example-client/website";
const subtree = "src/site";
const n3o = { name: "N3O Developer", email: "developer@n3o.example" };
const dev = { name: "Client Developer", email: "developer@client.example" };

let env;

const fakeGh = `#!/bin/bash
spec=\${2##*/compare/}; base=\${spec%%...*}; head=\${spec##*...}
git cat-file -e "$base^{commit}" 2>/dev/null && git cat-file -e "$head^{commit}" 2>/dev/null || { echo "HTTP 404" >&2; exit 1; }
if [ "$base" = "$head" ]; then echo identical
elif git merge-base --is-ancestor "$base" "$head"; then echo ahead
elif git merge-base --is-ancestor "$head" "$base"; then echo behind
else echo diverged; fi
`;

beforeEach(() => {
  const root = workspace();
  const bare = join(root, "client.git");
  gitConfig(root, { [clientRepo]: bare });
  git(root, ["init", "-q", "--bare", bare]);
  const mono = join(root, "mono");
  git(root, ["init", "-q", mono]);
  commit(mono, "Start", { [`${subtree}/file.txt`]: "one\n", "other/readme.md": "other\n" }, n3o);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);
  const identity = runStep("n3o-source-sync-identity", "check repository", {
    env: { REPO: clientRepo, GITHUB_REPOSITORY: monoRepo },
  });
  assert.equal(identity.status, 0, identity.log);
  env = { root, bare, mono, bin, identity: identity.outputs };
});

function push(overrides = {}) {
  return runStep("n3o-snapshot-push", "commit and push", {
    cwd: env.mono,
    env: {
      SUBTREE_PATH: subtree,
      TARGET_REPO: clientRepo,
      MERGE_HEADS: "",
      ADOPT_HEAD: "",
      COPY_PREFIX: env.identity["copy-prefix"],
      COPY_PATTERN: env.identity["copy-pattern"],
      GH_TOKEN: "unused",
      GITHUB_REPOSITORY: monoRepo,
      PATH: `${env.bin}:${process.env.PATH}`,
      ...overrides,
    },
  });
}

const main = () => git(env.root, ["--git-dir", env.bare, "rev-parse", "refs/heads/main"]);
const show = (format, ref = "refs/heads/main") =>
  git(env.root, ["--git-dir", env.bare, "log", "-1", `--format=${format}`, ref]);

function clientCommit(subject, { parents = [main()], committer = dev } = {}) {
  const head = git(
    env.root,
    [
      "--git-dir",
      env.bare,
      "commit-tree",
      `${main()}^{tree}`,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      subject,
    ],
    {
      env: { GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email },
    },
  );
  git(env.root, ["--git-dir", env.bare, "update-ref", "refs/heads/main", head]);
  return head;
}

test("a missing main is created as one parentless commit holding the subtree's tree", () => {
  const run = push();

  assert.equal(run.status, 0, run.log);
  const source = git(env.mono, ["rev-parse", "HEAD"]);
  assert.equal(show("%P"), "");
  assert.equal(show("%T"), git(env.mono, ["rev-parse", `HEAD:${subtree}`]));
  assert.equal(show("%s"), `Sync from ${monoRepo}@${source}`);
  assert.equal(show("%ce"), app.email);
});

test("an unchanged subtree makes no commit", () => {
  push();
  const copy = main();

  const run = push();

  assert.equal(run.status, 0, run.log);
  assert.match(run.log, /main already matches/);
  assert.equal(main(), copy);
});

test("a changed subtree fast-forwards main from the previous copy", () => {
  push();
  const copy = main();
  commit(env.mono, "Change", { [`${subtree}/file.txt`]: "two\n" }, n3o);

  const run = push();

  assert.equal(run.status, 0, run.log);
  assert.equal(show("%P"), copy);
  assert.equal(git(env.root, ["--git-dir", env.bare, "show", "refs/heads/main:file.txt"]), "two");
});

test("a head this action did not make is refused", () => {
  push();
  const head = clientCommit("Direct push");
  commit(env.mono, "Change", { [`${subtree}/file.txt`]: "two\n" }, n3o);

  const run = push();

  assert.equal(run.status, 1);
  assert.match(run.log, /refusing to push over it/);
  assert.equal(main(), head);
});

test("a copy-looking head with no sha after the prefix is refused", () => {
  push();
  const head = clientCommit(`${env.identity["copy-prefix"]}main`, { committer: app });
  commit(env.mono, "Change", { [`${subtree}/file.txt`]: "two\n" }, n3o);

  const run = push();

  assert.equal(run.status, 1);
  assert.equal(main(), head);
});

test("adopt-head is built on, even with the same tree", () => {
  push();
  const head = clientCommit("The client's own merge");

  const run = push({ ADOPT_HEAD: head });

  assert.equal(run.status, 0, run.log);
  assert.equal(show("%P"), head);
  assert.equal(show("%ce"), app.email);
});

test("merge heads become extra parents, even with the same tree", () => {
  push();
  const copy = main();
  const merged = git(
    env.root,
    ["--git-dir", env.bare, "commit-tree", `${copy}^{tree}`, "-p", copy, "-m", "Client change"],
    {
      env: { GIT_COMMITTER_NAME: dev.name, GIT_COMMITTER_EMAIL: dev.email },
    },
  );
  git(env.root, ["--git-dir", env.bare, "update-ref", "refs/heads/feature", merged]);

  const run = push({ MERGE_HEADS: merged });

  assert.equal(run.status, 0, run.log);
  assert.equal(show("%P"), `${copy} ${merged}`);
});

test("a checkout older than the last copy leaves main alone", () => {
  const older = git(env.mono, ["rev-parse", "HEAD"]);
  commit(env.mono, "Change", { [`${subtree}/file.txt`]: "two\n" }, n3o);
  push();
  const copy = main();
  git(env.mono, ["checkout", "-q", "--detach", older]);

  const run = push();

  assert.equal(run.status, 0, run.log);
  assert.match(run.log, /newer than/);
  assert.equal(main(), copy);
});

test("a rejected push reads main again and is retried, three times at most", () => {
  push();
  const hook = join(env.bare, "hooks", "pre-receive");
  writeFileSync(
    hook,
    '#!/bin/bash\nn=$(cat "$GIT_DIR/rejects")\nif [ "$n" -gt 0 ]; then echo $((n - 1)) > "$GIT_DIR/rejects"; exit 1; fi\n',
  );
  chmodSync(hook, 0o755);
  writeFileSync(join(env.bare, "rejects"), "1");
  commit(env.mono, "Change", { [`${subtree}/file.txt`]: "two\n" }, n3o);

  const retried = push();

  assert.equal(retried.status, 0, retried.log);
  assert.match(retried.log, /attempt 1 of 3/);
  const copy = main();
  writeFileSync(join(env.bare, "rejects"), "3");
  commit(env.mono, "Change", { [`${subtree}/file.txt`]: "three\n" }, n3o);

  const failed = push();

  assert.equal(failed.status, 1);
  assert.match(failed.log, /after 3 attempts/);
  assert.equal(main(), copy);
});

test("a subtree holding .github/workflows is refused before anything else", () => {
  commit(env.mono, "Add CI", { [`${subtree}/.github/workflows/build.yml`]: "on: push\n" }, n3o);

  const run = runStep("n3o-snapshot-push", "check subtree", { cwd: env.mono, env: { SUBTREE_PATH: subtree } });

  assert.equal(run.status, 1);
  assert.match(run.log, /cannot write workflow files/);
});
