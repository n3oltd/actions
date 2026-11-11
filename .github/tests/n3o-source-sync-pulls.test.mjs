import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { GitHub } from "./support/github.mjs";
import { app, as, commit, git, gitConfig, workspace, write } from "./support/git.mjs";
import { actionsDir, runStep } from "./support/steps.mjs";

const monoRepo = "n3oltd/monorepo";
const clientRepo = "example-client/website";
const subtree = "src/site";
const prefix = "client/pr-";
const reviewer = "n3o-reviewer";
const n3o = { name: "N3O Developer", email: "developer@n3o.example" };
const dev = { name: "Client Developer", email: "developer@client.example" };
const lines = (...changes) => `${["one", "two", "three", "four", "five", ...changes].join("\n")}\n`;
const fakeSendGridKey = () => `SG.${"a1B2c3D4e5".repeat(2)}aB.${"Zq9Wv8Ut7S".repeat(4)}X1y`;

let github;
let apiUrl;
let env;

before(async () => {
  assert.ok(process.env.GITLEAKS, "GITLEAKS must be the path of a gitleaks binary");
  github = new GitHub();
  apiUrl = await github.start();
});

after(() => github.stop());

beforeEach(() => {
  const root = workspace();
  const bares = { [monoRepo]: join(root, "mono.git"), [clientRepo]: join(root, "client.git") };
  gitConfig(root, bares);
  for (const bare of Object.values(bares)) git(root, ["init", "-q", "--bare", bare]);
  const mono = join(root, "mono");
  const client = join(root, "client");
  git(root, ["clone", "-q", bares[monoRepo], mono]);
  commit(mono, "Start", { [`${subtree}/file.txt`]: lines(), "other/readme.md": "other\n" }, n3o);
  git(mono, ["push", "-q", "origin", "HEAD:main"]);
  git(root, ["clone", "-q", bares[clientRepo], client]);

  github.repos.clear();
  const monoSide = github.addRepo(monoRepo, { bare: bares[monoRepo], token: "mono-token", bot: "github-actions[bot]" });
  const clientSide = github.addRepo(clientRepo, { bare: bares[clientRepo], token: "client-token", bot: app.name });
  monoSide.assignable.add(reviewer);
  clientSide.permissions.set("client-dev", "write");

  const identity = runStep("n3o-source-sync-identity", "check repository", {
    env: { REPO: clientRepo, GITHUB_REPOSITORY: monoRepo },
  });
  const scan = runStep("n3o-secret-scan", "check config", { env: { CONFIG: join(root, "absent", ".gitleaks.toml") } });
  assert.equal(identity.status, 0, identity.log);
  assert.equal(scan.status, 0, scan.log);
  env = {
    root,
    bares,
    mono,
    client,
    runs: 0,
    copyPattern: identity.outputs["copy-pattern"],
    scanConfig: scan.outputs.config,
  };
  copyToClient();
});

function copyToClient() {
  const bare = env.bares[clientRepo];
  git(env.root, ["--git-dir", bare, "fetch", "-q", env.bares[monoRepo], "+main:refs/source"]);
  const source = git(env.root, ["--git-dir", bare, "rev-parse", "refs/source"]);
  const tree = git(env.root, ["--git-dir", bare, "rev-parse", `refs/source:${subtree}`]);
  const parent = git(env.root, ["--git-dir", bare, "for-each-ref", "--format=%(objectname)", "refs/heads/main"]);
  const copy = git(env.root, [
    "--git-dir",
    bare,
    "commit-tree",
    tree,
    ...(parent ? ["-p", parent] : []),
    "-m",
    `Sync from ${monoRepo}@${source}`,
  ]);
  git(env.root, ["--git-dir", bare, "update-ref", "refs/heads/main", copy]);
  return copy;
}

function n3oChange(files) {
  git(env.mono, ["pull", "-q", "--ff-only", "origin", "main"]);
  commit(env.mono, "N3O change", files, n3o);
  git(env.mono, ["push", "-q", "origin", "HEAD:main"]);
}

function clientBranch(branch, commits) {
  git(env.client, ["fetch", "-q", "origin"]);
  git(env.client, ["checkout", "-q", "-B", branch, "origin/main"]);
  for (const [message, files] of commits) commit(env.client, message, files, dev);
  git(env.client, ["push", "-q", "-f", "origin", branch]);
  return git(env.client, ["rev-parse", "HEAD"]);
}

function mergeMain(resolution) {
  git(env.client, ["fetch", "-q", "origin"]);
  try {
    git(env.client, ["merge", "-q", "--no-edit", "origin/main"], { env: as(dev) });
  } catch {
    write(env.client, resolution);
    git(env.client, ["add", "-A"]);
    git(env.client, ["commit", "-q", "--no-edit"], { env: as(dev) });
  }
  git(env.client, ["push", "-q", "origin", "HEAD"]);
  return git(env.client, ["rev-parse", "HEAD"]);
}

function openClientPull(branch, options = {}) {
  return github.openPull(clientRepo, { head: branch, user: "client-dev", ...options });
}

function draftOf(number) {
  return [...github.repos.get(monoRepo).pulls.values()].find((pull) => pull.head.ref === `${prefix}${number}`);
}

function draftFile(number, path = "file.txt") {
  return git(env.root, ["--git-dir", env.bares[monoRepo], "show", `refs/heads/${prefix}${number}:${subtree}/${path}`]);
}

async function sync(overrides = {}) {
  const run = ++env.runs;
  const checkout = join(env.root, `checkout-${run}`);
  const output = join(env.root, `output-${run}`);
  git(env.root, ["clone", "-q", "--depth=1", `file://${env.bares[monoRepo]}`, checkout]);
  writeFileSync(output, "");
  const child = spawn(process.execPath, [join(actionsDir, "n3o-source-sync-pulls", "sync.mjs")], {
    cwd: checkout,
    env: {
      ...process.env,
      SUBTREE_PATH: subtree,
      CLIENT_REPO: clientRepo,
      BRANCH_PREFIX: prefix,
      ASSIGNEES: reviewer,
      GITHUB_REPOSITORY: monoRepo,
      CLIENT_TOKEN: "client-token",
      CLIENT_BOT_NAME: app.name,
      CLIENT_BOT_EMAIL: app.email,
      COPY_PATTERN: env.copyPattern,
      MONOREPO_TOKEN: "mono-token",
      SCAN_CONFIG: env.scanConfig,
      RUNNER_TEMP: env.root,
      GITHUB_OUTPUT: output,
      GITHUB_API_URL: apiUrl,
      ...overrides,
    },
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  return { status, log, outputs };
}

test("a client pull request is imported as an assigned draft that keeps its author", async () => {
  const head = clientBranch("feature", [["Change line two", { "file.txt": lines().replace("two", "two client") }]]);
  const pull = openClientPull("feature", { body: "Thanks @someone, fixes #1" });

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  const draft = draftOf(pull.number);
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.assignees, [{ login: reviewer }]);
  assert.match(draft.body, new RegExp(`client=${head} draft=[0-9a-f]{40} -->\\n\\nno-work-issue: `));
  assert.ok(!draft.body.includes("@someone"));
  assert.equal(draftFile(pull.number).split("\n")[1], "two client");
  const [author, committer] = git(env.root, [
    "--git-dir",
    env.bares[monoRepo],
    "log",
    "-1",
    "--format=%ae%n%ce",
    `refs/heads/${prefix}${pull.number}`,
  ]).split("\n");
  assert.equal(author, dev.email);
  assert.equal(committer, app.email);
});

test("a draft whose assignee can't be assigned fails the run", async () => {
  clientBranch("feature", [["Change", { "file.txt": lines("six") }]]);
  openClientPull("feature");

  const run = await sync({ ASSIGNEES: `${reviewer},nobody-here` });

  assert.equal(run.status, 1);
  assert.match(run.log, /nobody-here could not be assigned/);
});

test("an open draft missing a configured assignee is assigned on the next run", async () => {
  clientBranch("feature", [["Change", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature");
  await sync();
  const draft = draftOf(pull.number);
  draft.assignees = [];
  github.repos.get(monoRepo).assignable.add("second-reviewer");

  const run = await sync({ ASSIGNEES: `${reviewer},second-reviewer` });
  const assigning = () =>
    github.requests.filter((request) => request.url.endsWith(`/issues/${draft.number}/assignees`));
  const before = assigning().length;
  const again = await sync({ ASSIGNEES: `${reviewer},second-reviewer` });

  assert.equal(run.status, 0, run.log);
  assert.equal(again.status, 0, again.log);
  assert.deepEqual(draft.assignees, [{ login: reviewer }, { login: "second-reviewer" }]);
  assert.equal(assigning().length, before);
});

test("the draft body keeps what N3O writes after the marker", async () => {
  clientBranch("feature", [["Change", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature", { title: "First title" });
  await sync();
  const draft = draftOf(pull.number);
  draft.body = draft.body.replace(/no-work-issue: .*$/, "re example/tracker#9");
  pull.title = "Second title";

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(draft.title, "Second title");
  assert.match(draft.body, /-->\n\nre example\/tracker#9$/);
});

test("a client's new commit is applied to the draft and dismisses its approvals", async () => {
  clientBranch("feature", [["First", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature");
  await sync();
  const approval = github.review(monoRepo, draftOf(pull.number).number, { user: reviewer, state: "APPROVED" });
  git(env.client, ["checkout", "-q", "feature"]);
  commit(env.client, "Second", { "file.txt": lines("six", "seven") }, dev);
  git(env.client, ["push", "-q", "origin", "feature"]);

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(draftFile(pull.number), lines("six", "seven").trim());
  assert.equal(approval.state, "DISMISSED");
});

test("a client branch that resolved a conflict by merging main is imported with the resolution", async () => {
  clientBranch("feature", [["Client line two", { "file.txt": lines().replace("two", "two client") }]]);
  n3oChange({ [`${subtree}/file.txt`]: lines().replace("two", "two n3o") });
  copyToClient();
  mergeMain({ "file.txt": lines().replace("two", "two client and n3o") });
  const pull = openClientPull("feature");

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(draftFile(pull.number).split("\n")[1], "two client and n3o");
  assert.ok(!github.comments(clientRepo, pull.number).some((comment) => comment.body.includes("no longer applies")));
});

test("a draft is rebuilt with the client's resolution when they merge main into their branch", async () => {
  clientBranch("feature", [["Client line four", { "file.txt": lines().replace("four", "four client") }]]);
  const pull = openClientPull("feature");
  await sync();
  const approval = github.review(monoRepo, draftOf(pull.number).number, { user: reviewer, state: "APPROVED" });
  n3oChange({ [`${subtree}/file.txt`]: lines().replace("four", "four n3o") });
  copyToClient();
  const head = mergeMain({ "file.txt": lines().replace("four", "four both") });

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(draftFile(pull.number).split("\n")[3], "four both");
  assert.match(draftOf(pull.number).body, new RegExp(`client=${head} `));
  assert.equal(approval.state, "DISMISSED");
});

test("a client symlink is not imported, and fails the run", async () => {
  git(env.client, ["fetch", "-q", "origin"]);
  git(env.client, ["checkout", "-q", "-B", "feature", "origin/main"]);
  symlinkSync("../other/readme.md", join(env.client, "link"));
  commit(env.client, "Add a link", {}, dev);
  git(env.client, ["push", "-q", "-f", "origin", "feature"]);
  const pull = openClientPull("feature");

  const run = await sync();

  assert.equal(run.status, 1);
  assert.match(run.log, /adds a symlink or submodule/);
  assert.equal(draftOf(pull.number), undefined);
});

test("a client submodule is not imported, and fails the run", async () => {
  git(env.client, ["fetch", "-q", "origin"]);
  git(env.client, ["checkout", "-q", "-B", "feature", "origin/main"]);
  git(env.client, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor`]);
  git(env.client, ["commit", "-q", "-m", "Add a submodule"], { env: as(dev) });
  git(env.client, ["push", "-q", "-f", "origin", "feature"]);
  const pull = openClientPull("feature");

  const run = await sync();

  assert.equal(run.status, 1);
  assert.match(run.log, /adds a symlink or submodule/);
  assert.equal(draftOf(pull.number), undefined);
});

test("a client workflow file is refused with a notice", async () => {
  clientBranch("feature", [["Add CI", { ".github/workflows/build.yml": "on: push\n" }]]);
  const pull = openClientPull("feature");

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(draftOf(pull.number), undefined);
  const notices = github.comments(clientRepo, pull.number);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /\.github\/workflows/);
});

test("N3O's commits on the draft reach the client's branch without the subtree prefix", async () => {
  clientBranch("feature", [["Client", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature");
  await sync();
  git(env.mono, ["fetch", "-q", "origin"]);
  git(env.mono, ["checkout", "-q", "-B", "draft", `origin/${prefix}${pull.number}`]);
  commit(
    env.mono,
    "N3O review fix",
    { [`${subtree}/file.txt`]: lines("six", "n3o"), "other/readme.md": "kept here\n" },
    n3o,
  );
  git(env.mono, ["push", "-q", "origin", `HEAD:${prefix}${pull.number}`]);

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  const bare = env.bares[clientRepo];
  assert.equal(git(env.root, ["--git-dir", bare, "show", "refs/heads/feature:file.txt"]), lines("six", "n3o").trim());
  assert.equal(
    git(env.root, ["--git-dir", bare, "log", "-1", "--format=%ae %ce", "refs/heads/feature"]),
    `${n3o.email} ${app.email}`,
  );
  assert.equal(git(env.root, ["--git-dir", bare, "ls-tree", "--name-only", "refs/heads/feature"]), "file.txt");
});

test("an N3O commit whose message holds a secret is not sent to the client", async () => {
  const head = clientBranch("feature", [["Client", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature");
  await sync();
  git(env.mono, ["fetch", "-q", "origin"]);
  git(env.mono, ["checkout", "-q", "-B", "draft", `origin/${prefix}${pull.number}`]);
  commit(env.mono, `Use key ${fakeSendGridKey()}`, { [`${subtree}/file.txt`]: lines("six", "n3o") }, n3o);
  git(env.mono, ["push", "-q", "origin", `HEAD:${prefix}${pull.number}`]);

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(git(env.root, ["--git-dir", env.bares[clientRepo], "rev-parse", "refs/heads/feature"]), head);
  assert.ok(
    github
      .comments(monoRepo, draftOf(pull.number).number)
      .some((comment) => comment.body.includes("looks like a secret")),
  );
});

test("git's errors reach the log with workflow commands broken", async () => {
  const name = "x::error title=Forged::y.txt";
  n3oChange({ [`${subtree}/${name}`]: "one\n" });
  copyToClient();
  clientBranch("feature", [["Client", { [name]: "client\n" }]]);
  n3oChange({ [`${subtree}/other.txt`]: "other\n" });
  copyToClient();
  mergeMain({});
  n3oChange({ [`${subtree}/${name}`]: "n3o\n" });
  const pull = openClientPull("feature");

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.match(run.log, /x: :error title=Forged: :y\.txt/);
  assert.ok(!run.log.includes("::error title=Forged"));
  assert.ok(github.comments(clientRepo, pull.number).some((comment) => comment.body.includes("no longer applies")));
});

test("a pull request from a fork gets one notice and is not imported", async () => {
  clientBranch("feature", [["Client", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature", { headRepo: "someone/website" });

  await sync();
  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(draftOf(pull.number), undefined);
  assert.equal(github.comments(clientRepo, pull.number).length, 1);
});

test("a commit pushed straight to the client's main fails the run", async () => {
  git(env.client, ["fetch", "-q", "origin"]);
  git(env.client, ["checkout", "-q", "-B", "main", "origin/main"]);
  commit(env.client, "Direct push", { "file.txt": lines("direct") }, dev);
  git(env.client, ["push", "-q", "origin", "main"]);

  const run = await sync();

  assert.equal(run.status, 1);
  assert.match(run.log, /::error::example-client\/website main: 1 commits the copy did not make/);
  assert.equal(run.outputs["adopt-head"], "");
});

test("a copy-looking commit without a sha after the prefix is not taken for a copy", async () => {
  const bare = env.bares[clientRepo];
  const main = git(env.root, ["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  const forged = git(env.root, [
    "--git-dir",
    bare,
    "commit-tree",
    `${main}^{tree}`,
    "-p",
    main,
    "-m",
    `Sync from ${monoRepo}@main`,
  ]);
  git(env.root, ["--git-dir", bare, "update-ref", "refs/heads/main", forged]);

  const run = await sync();

  assert.equal(run.status, 1);
  assert.match(run.log, /1 commits the copy did not make/);
});

test("a merged draft hands the client's head to the copy as a merge head", async () => {
  const head = clientBranch("feature", [["Client", { "file.txt": lines("six") }]]);
  const pull = openClientPull("feature");
  await sync();
  const draft = draftOf(pull.number);
  git(env.mono, ["fetch", "-q", "origin"]);
  git(env.mono, ["checkout", "-q", "-B", "main", "origin/main"]);
  git(env.mono, ["merge", "-q", "--no-ff", "-m", "Merge the draft", `origin/${prefix}${pull.number}`], {
    env: as(n3o),
  });
  git(env.mono, ["push", "-q", "origin", "main"]);
  github.close(monoRepo, draft.number, {
    by: reviewer,
    merged: true,
    mergeCommit: git(env.mono, ["rev-parse", "HEAD"]),
  });

  const run = await sync();

  assert.equal(run.status, 0, run.log);
  assert.equal(run.outputs["merge-heads"], head);
});
