import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const {
  SUBTREE_PATH: subtree,
  CLIENT_REPO,
  BRANCH_PREFIX: prefix,
  ASSIGNEES,
  GITHUB_REPOSITORY,
  CLIENT_TOKEN,
  CLIENT_BOT_NAME,
  CLIENT_BOT_EMAIL,
  COPY_PATTERN,
  MONOREPO_TOKEN,
  GITLEAKS,
  SCAN_CONFIG: gitleaksConfig,
  RUNNER_TEMP,
  GITHUB_OUTPUT,
} = process.env;
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const copyBranch = "main";
const markerTag = "n3o-source-sync";

const client = { repo: CLIENT_REPO, token: CLIENT_TOKEN, bot: CLIENT_BOT_NAME };
const monorepo = { repo: GITHUB_REPOSITORY, token: MONOREPO_TOKEN, bot: "github-actions[bot]" };

async function request(side, method, path, body) {
  const response = await fetch(`${apiUrl}/repos/${side.repo}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${side.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`${method} ${side.repo}/${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function list(side, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const pagePath = `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
    const batch = await request(side, "GET", pagePath);
    if (!batch) throw new Error(`GET ${side.repo}/${pagePath}: 404`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

// Each token reaches git through the environment, never the command line. The empty value first clears any header
// a checkout persisted, which would otherwise be sent instead.
function auth(side) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${side.token}`).toString("base64")}`;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: header,
  };
}

function git(side, args, { cwd, input, env, raw } = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd,
      input,
      encoding: raw ? "buffer" : "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...auth(side), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return raw ? output : output.trim();
  } catch (error) {
    // git's errors name the client's files; the runner reads :: or ##[ anywhere in a line as a workflow command.
    process.stdout.write(String(error.stderr ?? "").replace(/::/g, ": :").replace(/##\[/g, "## ["));
    error.message = `git ${args[0]} failed (status ${error.status})`;
    throw error;
  }
}

const url = (side) => `https://github.com/${side.repo}.git`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stateMarker = (number, marker) =>
  `<!-- ${markerTag}: ${CLIENT_REPO}#${number} client=${marker.client} draft=${marker.draft} -->`;
const statePattern = (number) =>
  new RegExp(`<!-- ${escapeRegExp(markerTag)}: ${escapeRegExp(CLIENT_REPO)}#${number} client=([0-9a-f]{40}) draft=([0-9a-f]{40}) -->`);
const copyPattern = new RegExp(`<!-- ${escapeRegExp(markerTag)}: copy of (\\S+ \\w+:\\d+) -->`, "g");

function readMarker(draft, number) {
  const match = statePattern(number).exec(draft.body ?? "");
  return match && { client: match[1], draft: match[2] };
}

// Copied text must not notify anyone, link or close an issue, or carry a marker this check would trust.
const neutralise = (text) =>
  (text ?? "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/(^|\W)@(?=[A-Za-z0-9])/g, "$1@\u2060")
    .replace(/(#|\bGH-|\/(?:issues|pull|discussions)\/)(?=\d)/gi, "$1\u2060")
    .replace(/\b(?=(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b)(\w)/gi, "$1\u2060");

// GitHub refuses a body over 65,536 characters, and neutralising lengthens the copied text.
const bodyLimit = 65536;
const truncated = "\n\n(truncated)";

function withText(before, text, after) {
  const room = bodyLimit - before.length - after.length;
  if (text.length <= room) return `${before}${text}${after}`;
  let end = room - truncated.length;
  if (/[\ud800-\udbff]/.test(text[end - 1])) end--;
  return `${before}${text.slice(0, end)}${truncated}${after}`;
}

// GitHub refuses a title over 1,024 bytes of UTF-8, and neutralising lengthens the copied title.
const titleLimit = 1024;

function draftTitle(pull) {
  let title = "";
  for (const char of neutralise(pull.title)) {
    if (Buffer.byteLength(title + char) > titleLimit) break;
    title += char;
  }
  return title;
}

function draftBody(pull, marker, draft) {
  const text = neutralise(pull.body);
  const origin = `Imported from \`${CLIENT_REPO}#${pull.number}\`, opened by \`${pull.user.login}\`.`;
  const before = text ? `${origin}\n\n` : origin;
  const found = draft && statePattern(pull.number).exec(draft.body ?? "");
  const kept = found
    ? draft.body.slice(found.index + found[0].length)
    : "\n\nno-work-issue: imported from a client pull request";
  return withText(before, text, `\n\n${stateMarker(pull.number, marker)}${kept}`);
}

async function writeDraft(draft, pull, marker) {
  await request(monorepo, "PATCH", `pulls/${draft.number}`, {
    title: draftTitle(pull),
    body: draftBody(pull, marker, draft),
  });
}

const assignees = (ASSIGNEES ?? "")
  .split(",")
  .map((login) => login.trim())
  .filter(Boolean);

const unassigned = (draft) => assignees.some((login) => !draft.assignees?.some((assignee) => assignee.login === login));

// GitHub drops an assignee who can't see the repository without an error.
async function assign(number) {
  const issue = await request(monorepo, "POST", `issues/${number}/assignees`, { assignees });
  const missing = assignees.filter((login) => !issue.assignees.some((assignee) => assignee.login === login));
  if (missing.length) throw new Error(`#${number}: ${missing.join(", ")} could not be assigned`);
}

async function dismissApprovals(draft, head) {
  for (const review of await list(monorepo, `pulls/${draft.number}/reviews`)) {
    if (review.state !== "APPROVED" || review.commit_id === head) continue;
    await request(monorepo, "PUT", `pulls/${draft.number}/reviews/${review.id}/dismissals`, {
      message: "The client pushed commits after this approval; review the new head before merging.",
      event: "DISMISS",
    });
  }
}

async function notice(side, number, key, text) {
  const noticeMarker = `<!-- ${markerTag}: notice ${key} -->`;
  const comments = await list(side, `issues/${number}/comments`);
  if (comments.some((comment) => comment.user?.login === side.bot && comment.body?.includes(noticeMarker))) return;
  await request(side, "POST", `issues/${number}/comments`, { body: `${text}\n\n${noticeMarker}` });
}

async function isAncestor(side, base, head) {
  const comparison = await request(side, "GET", `compare/${base}...${head}`);
  return comparison !== null && (comparison.status === "ahead" || comparison.status === "identical");
}

async function findDraft(number) {
  const owner = monorepo.repo.split("/")[0];
  const drafts = await list(monorepo, `pulls?state=all&head=${owner}:${encodeURIComponent(`${prefix}${number}`)}`);
  return drafts.sort((a, b) => b.number - a.number)[0];
}

function expectAt(side, ref, branch, sha, cwd) {
  if (git(side, ["rev-parse", ref], { cwd }) !== sha) {
    throw new Error(`${branch} moved during this run; it is picked up next run`);
  }
}

function fetchClientRefs(pull) {
  // GitHub may delete a merged pull request's branch, but keeps its head.
  const head = pull.merged_at ? `refs/pull/${pull.number}/head` : `refs/heads/${pull.head.ref}`;
  git(client, [
    "fetch",
    "-q",
    "--no-tags",
    url(client),
    `+refs/heads/${copyBranch}:refs/n3o-source-sync/client-base`,
    `+${head}:refs/n3o-source-sync/client-head`,
  ]);
  expectAt(monorepo, "refs/n3o-source-sync/client-head", pull.head.ref, pull.head.sha);
}

const clientForkPoint = (pull) =>
  git(monorepo, [
    "merge-base",
    pull.merged_at ? selfMerges.forkPoints.get(pull.number) : "refs/n3o-source-sync/client-base",
    "refs/n3o-source-sync/client-head",
  ]);

function fetchDraft(draft, depth) {
  git(monorepo, [
    "fetch",
    "-q",
    "--no-tags",
    `--depth=${depth}`,
    url(monorepo),
    `+refs/heads/${draft.head.ref}:refs/n3o-source-sync/draft`,
  ]);
  expectAt(monorepo, "refs/n3o-source-sync/draft", draft.head.ref, draft.head.sha);
}

async function fetchDraftSince(draft, base) {
  const comparison = await request(monorepo, "GET", `compare/${base}...${draft.head.sha}`);
  if (comparison?.status !== "ahead") return null;
  fetchDraft(draft, comparison.ahead_by + 1);
  return comparison.commits;
}

function neutraliseMessages(side, base, { cwd, env } = {}) {
  let parent = base;
  for (const line of git(side, ["log", "--reverse", "--format=%H %P", `${base}..HEAD`], { cwd }).split("\n")) {
    if (!line) continue;
    const [commit, original] = line.split(" ");
    const message = git(side, ["log", "-1", "--format=%B", commit], { cwd });
    if (neutralise(message) === message && original === parent) {
      parent = commit;
      continue;
    }
    const [name, email, date] = git(side, ["log", "-1", "--format=%an%n%ae%n%aD", commit], { cwd }).split("\n");
    parent = git(side, ["commit-tree", `${commit}^{tree}`, "-p", parent], {
      cwd,
      input: `${neutralise(message)}\n`,
      env: { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
    });
  }
  git(side, ["reset", "-q", "--soft", parent], { cwd });
}

function hasLinks(from, to) {
  const raw = [
    git(monorepo, ["log", "--raw", "--no-abbrev", "--format=", `${from}..${to}`]),
    git(monorepo, ["diff", "--raw", "--no-abbrev", from, to]),
  ].join("\n");
  return /^:\d{6} (?:120000|160000) /m.test(raw);
}

function applyClientCommits(from, to) {
  if (hasLinks(from, to)) {
    throw new Error(`${from.slice(0, 7)}..${to.slice(0, 7)} adds a symlink or submodule, which is not imported`);
  }
  if (git(monorepo, ["rev-list", "--merges", `${from}..${to}`])) return applyNetChange(from, to);
  // -k on both format-patch and am keeps a bracketed prefix on each subject, which git otherwise strips.
  const patches = git(monorepo, ["format-patch", "-k", "--stdout", `${from}..${to}`], { raw: true });

  if (!patches.length) return true;
  const base = git(monorepo, ["rev-parse", "HEAD"]);

  try {
    git(monorepo, ["am", "-q", "-k", "-3", `--directory=${subtree}`], { input: patches });
  } catch (error) {
    console.log(`::warning::git am of ${from}..${to} failed: ${error.message}`);
    git(monorepo, ["am", "--abort"]);
    return false;
  }
  neutraliseMessages(monorepo, base);
  return true;
}

function applyNetChange(from, to) {
  const diff = git(monorepo, ["diff", "--binary", "--full-index", from, to], { raw: true });

  if (!diff.length) return true;
  try {
    git(monorepo, ["apply", "-3", "--index", `--directory=${subtree}`], { input: diff });
  } catch (error) {
    console.log(`::warning::git apply of ${from}..${to} failed: ${error.message}`);
    git(monorepo, ["reset", "-q", "--hard"]);
    return false;
  }
  if (!git(monorepo, ["diff", "--cached", "--name-only"])) return true;
  const [name, email, date] = git(monorepo, ["log", "-1", "--format=%an%n%ae%n%aD", to]).split("\n");
  git(monorepo, ["commit", "-q", "-m", `Changes from ${CLIENT_REPO} up to ${to}`], {
    env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
  });
  return true;
}

async function changesGuardedFiles(pull, from) {
  const guarded = [".github/workflows", ".gitleaks.toml", ".gitleaksignore"];
  if (!git(monorepo, ["diff", "--name-only", from, pull.head.sha, "--", ...guarded])) return false;
  await notice(
    client,
    pull.number,
    `workflows-${pull.head.sha}`,
    "Changes under `.github/workflows`, or to `.gitleaks.toml` or `.gitleaksignore`, can't be taken into the copy. Please remove them from this pull request.",
  );
  return true;
}

async function addsLinks(pull, from) {
  if (!hasLinks(from, pull.head.sha)) return false;
  await notice(
    client,
    pull.number,
    `links-${pull.head.sha}`,
    "Symbolic links and submodules can't be taken into the copy. Please remove them from every commit of this pull request, for example by squashing it, and push again.",
  );
  return true;
}

// An empty lease requires the branch not to exist yet; no lease pushes without force.
function pushDraftBranch(number, lease) {
  const ref = `refs/heads/${prefix}${number}`;
  const force = lease === undefined ? [] : [`--force-with-lease=${ref}:${lease}`];
  git(monorepo, ["push", "-q", ...force, url(monorepo), `HEAD:${ref}`]);
  return git(monorepo, ["rev-parse", "HEAD"]);
}

function findsSecrets(command, args, input) {
  try {
    execFileSync(
      GITLEAKS,
      [command, "--no-banner", "--redact", "--exit-code", "2", "--config", gitleaksConfig, ...args],
      { input, env: auth(monorepo), stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"] },
    );
    return false;
  } catch (error) {
    if (error.status === 2) return true;
    throw error;
  }
}

function commitFilesHaveSecrets(range) {
  for (const commit of git(monorepo, ["rev-list", "--reverse", range, "--", subtree]).split("\n").filter(Boolean)) {
    const files = git(monorepo, [
      "diff-tree",
      "-r",
      "-z",
      "--no-commit-id",
      "--name-only",
      "--diff-filter=d",
      commit,
      "--",
      subtree,
    ])
      .split("\0")
      .filter(Boolean);
    const dir = mkdtempSync(join(RUNNER_TEMP, "n3o-source-sync-scan-"));
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), git(monorepo, ["cat-file", "blob", `${commit}:${file}`], { raw: true }));
    }
    const args = ["--max-archive-depth", "3", "--gitleaks-ignore-path", subtree, join(dir, subtree)];
    if (files.length && findsSecrets("dir", args)) return true;
  }
  return false;
}

function patchIds(side, args) {
  const log = git(side, ["log", "-p", "--no-merges", "--no-color", ...args], { raw: true });

  if (!log.length) return [];
  return git(side, ["patch-id", "--stable"], { input: log })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0])
    .sort();
}

// Resolves to { draft } for the draft now holding the client's commits, { draft: null } when main
// already holds a self-merged change, or false.
async function importPull(pull, draft) {
  fetchClientRefs(pull);
  const forkPoint = clientForkPoint(pull);

  if (await changesGuardedFiles(pull, forkPoint)) return false;
  if (await addsLinks(pull, forkPoint)) {
    throw new Error(`${CLIENT_REPO}#${pull.number} adds a symlink or submodule, which is not imported`);
  }
  if (draft) {
    // A compare lists at most 300 files, so a full list may hide one outside the subtree.
    const files = (await request(monorepo, "GET", `compare/${mainHead}...${draft.head.sha}`))?.files ?? [];
    if (files.length >= 300 || files.some((file) => !file.filename.startsWith(`${subtree}/`))) {
      return reportStuck(pull, draft, "rebuilding the draft from the client's branch would drop N3O's other changes");
    }
  }
  git(monorepo, ["checkout", "-q", "--force", "--detach", mainHead]);

  if (!applyClientCommits(forkPoint, pull.head.sha)) {
    if (pull.merged_at) {
      console.log(`::warning::${CLIENT_REPO}#${pull.number}, merged by the client, no longer applies to ${copyBranch}`);
      await notice(
        client,
        pull.number,
        "self-merged-stale",
        `This pull request was merged here, but changes reach \`${copyBranch}\` only through N3O, and this one no longer applies to N3O's copy, so N3O can't review it. \`${copyBranch}\` goes back to N3O's copy once someone at N3O has read it; please raise the change again from the latest \`${copyBranch}\`.`,
      );
      return false;
    }
    await notice(
      client,
      pull.number,
      `stale-${pull.head.sha}`,
      `This change no longer applies to the latest \`${copyBranch}\`. Please update the branch from \`${copyBranch}\` and push again.`,
    );
    return false;
  }
  if (git(monorepo, ["rev-parse", "HEAD"]) === mainHead) {
    await notice(
      client,
      pull.number,
      `empty-${pull.head.sha}`,
      `This change is already in \`${copyBranch}\`, so there is nothing to review.`,
    );
    return pull.merged_at ? { draft: null } : false;
  }
  if (draft) await dismissApprovals(draft, git(monorepo, ["rev-parse", "HEAD"]));
  const orphan = draft ? undefined : git(monorepo, ["ls-remote", url(monorepo), `refs/heads/${prefix}${pull.number}`]);
  const draftHead = pushDraftBranch(pull.number, draft?.head.sha ?? orphan.split("\t")[0]);
  const marker = { client: pull.head.sha, draft: draftHead };

  if (draft) {
    await dismissApprovals(draft, draftHead);
    await writeDraft(draft, pull, marker);
    console.log(`${CLIENT_REPO}#${pull.number}: rebuilt draft #${draft.number}`);
    return { draft: draft.number };
  }
  const created = await request(monorepo, "POST", "pulls", {
    title: draftTitle(pull),
    head: `${prefix}${pull.number}`,
    base: "main",
    body: draftBody(pull, marker),
    draft: true,
  });
  console.log(`${CLIENT_REPO}#${pull.number}: imported as draft #${created.number}`);
  await assign(created.number);
  return { draft: created.number };
}

async function applyClient(pull, draft, marker) {
  fetchClientRefs(pull);
  // A merge brings the client's copy commits into the range, so the draft is rebuilt from the fork point instead.
  if (git(monorepo, ["rev-list", "--merges", `${marker.client}..${pull.head.sha}`])) return importPull(pull, draft);
  if (await changesGuardedFiles(pull, marker.client)) return false;
  if (await addsLinks(pull, marker.client)) {
    throw new Error(`${CLIENT_REPO}#${pull.number} adds a symlink or submodule, which is not imported`);
  }
  fetchDraft(draft, 1);
  git(monorepo, ["checkout", "-q", "--force", "--detach", "refs/n3o-source-sync/draft"]);

  if (!applyClientCommits(marker.client, pull.head.sha)) {
    await reportStuck(pull, draft, "the client's new commits no longer apply to the draft");
    return false;
  }
  await dismissApprovals(draft, git(monorepo, ["rev-parse", "HEAD"]));
  const draftHead = pushDraftBranch(pull.number);
  await dismissApprovals(draft, draftHead);
  await writeDraft(draft, pull, { client: pull.head.sha, draft: draftHead });
  console.log(`${CLIENT_REPO}#${pull.number}: applied the client's new commits to draft #${draft.number}`);
  return true;
}

async function pushToClient(pull, draft, marker) {
  const commits = await fetchDraftSince(draft, marker.draft);
  if (!commits) return reportStuck(pull, draft, "the draft branch was rewritten");
  if (commits.some((commit) => commit.parents.length > 1)) {
    return reportStuck(pull, draft, "the draft has a merge commit, which can't be sent to the client's branch");
  }
  const range = `${marker.draft}..refs/n3o-source-sync/draft`;
  const messages = git(monorepo, ["log", "--format=%B", range, "--", subtree]);

  if (
    findsSecrets("git", ["--gitleaks-ignore-path", subtree, `--log-opts=${range} -- ${subtree}`, "."]) ||
    findsSecrets("stdin", ["--gitleaks-ignore-path", subtree], messages) ||
    commitFilesHaveSecrets(range)
  ) {
    await notice(
      monorepo,
      draft.number,
      `secret-${draft.head.sha}`,
      "The new commits on this draft contain something that looks like a secret, so they were not sent to the client. Someone at N3O needs to remove it from the branch and bring the two back in step by hand.",
    );
    console.log(`::error::${CLIENT_REPO}#${pull.number}: draft #${draft.number} has a possible secret; not sent`);
    return false;
  }
  const patches = git(
    monorepo,
    ["format-patch", "-k", "--stdout", `--relative=${subtree}`, range, "--", subtree],
    { raw: true },
  );

  if (!patches.length) {
    await writeDraft(draft, pull, { client: marker.client, draft: draft.head.sha });
    return true;
  }
  const work = mkdtempSync(join(RUNNER_TEMP, "n3o-source-sync-"));
  git(client, ["init", "-q", work]);
  git(client, ["fetch", "-q", "--no-tags", "--depth=1", url(client), `refs/heads/${pull.head.ref}`], { cwd: work });
  git(client, ["checkout", "-q", "--detach", "FETCH_HEAD"], { cwd: work });
  expectAt(client, "HEAD", pull.head.ref, pull.head.sha, work);
  const committer = { GIT_COMMITTER_NAME: CLIENT_BOT_NAME, GIT_COMMITTER_EMAIL: CLIENT_BOT_EMAIL };

  try {
    git(client, ["am", "-q", "-k"], { cwd: work, input: patches, env: committer });
  } catch (error) {
    console.log(`::warning::git am onto ${pull.head.ref} failed: ${error.message}`);
    return reportStuck(pull, draft, "N3O's commits don't apply to the client's branch");
  }
  neutraliseMessages(client, pull.head.sha, { cwd: work, env: committer });
  git(client, ["push", "-q", url(client), `HEAD:refs/heads/${pull.head.ref}`], { cwd: work });
  const clientHead = git(client, ["rev-parse", "HEAD"], { cwd: work });
  await writeDraft(draft, pull, { client: clientHead, draft: draft.head.sha });
  console.log(`${CLIENT_REPO}#${pull.number}: pushed N3O's commits from draft #${draft.number}`);
  return true;
}

async function recordIfInStep(pull, draft, marker) {
  fetchClientRefs(pull);
  const since = { ...marker };

  if (!(await fetchDraftSince(draft, marker.draft))) {
    const comparison = await request(monorepo, "GET", `compare/${mainHead}...${draft.head.sha}`);
    if (!comparison?.ahead_by) return false;
    fetchDraft(draft, comparison.ahead_by + 1);
    since.client = clientForkPoint(pull);
    since.draft = comparison.merge_base_commit.sha;
  } else if (!(await isAncestor(client, marker.client, pull.head.sha))) {
    return false;
  }
  const clientIds = patchIds(monorepo, [`${since.client}..refs/n3o-source-sync/client-head`]);
  const draftIds = patchIds(monorepo, [
    `--relative=${subtree}`,
    `${since.draft}..refs/n3o-source-sync/draft`,
    "--",
    subtree,
  ]);

  if (!clientIds.length || clientIds.join() !== draftIds.join()) return false;
  await writeDraft(draft, pull, { client: pull.head.sha, draft: draft.head.sha });
  console.log(`${CLIENT_REPO}#${pull.number}: both sides already have the same changes; recorded them as in step`);
  return true;
}

async function reportStuck(pull, draft, reason) {
  const key = `stuck-${pull.head.sha}-${draft.head.sha}`;
  const text = `This pull request and its copy have both changed since they were last in step (${reason}), so neither was updated. Someone at N3O needs to bring them back in step by hand.`;
  await notice(client, pull.number, key, text);
  await notice(monorepo, draft.number, key, text);
  console.log(`::warning::${CLIENT_REPO}#${pull.number}: ${reason}; left for N3O`);
  return false;
}

async function onlyMergedMain(pull, marker) {
  if (!(await isAncestor(client, marker.client, pull.head.sha))) return false;
  fetchClientRefs(pull);
  const own = ["rev-list", "--no-merges", `${marker.client}..${pull.head.sha}`, "^refs/n3o-source-sync/client-base"];
  return !git(monorepo, own);
}

async function handleClosedDraft(pull, draft, marker) {
  if (draft.merged_at) {
    const recorded = marker.draft === draft.head.sha || (await isAncestor(monorepo, marker.draft, draft.head.sha));
    if (!recorded || (pull.head.sha !== marker.client && !(await onlyMergedMain(pull, marker)))) {
      await notice(
        client,
        pull.number,
        "merged-early",
        "N3O merged this change without some of the commits pushed to it, so this pull request has been closed. Please raise the rest as a new pull request.",
      );
      await request(client, "PATCH", `pulls/${pull.number}`, { state: "closed" });
      return;
    }
    if (!(await isAncestor(monorepo, draft.merge_commit_sha, mainHead))) {
      console.log(`${CLIENT_REPO}#${pull.number}: draft #${draft.number} was merged after this run's checkout`);
      return;
    }
    mergeHeads.push(pull.head.sha);
    console.log(`${CLIENT_REPO}#${pull.number}: draft #${draft.number} merged; the next copy marks it merged`);
    return;
  }
  const issue = await request(monorepo, "GET", `issues/${draft.number}`);

  if (issue?.closed_by?.login === monorepo.bot) {
    await request(monorepo, "PATCH", `pulls/${draft.number}`, { state: "open" });
    console.log(`${CLIENT_REPO}#${pull.number}: reopened, so draft #${draft.number} is reopened too`);
    return;
  }
  await notice(
    client,
    pull.number,
    "rejected",
    "N3O closed this change without merging it, so this pull request has been closed.",
  );
  await request(client, "PATCH", `pulls/${pull.number}`, { state: "closed" });
}

async function lineText(side, path, commit, line) {
  const file = await request(
    side,
    "GET",
    `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`,
  );
  if (!file?.content) return null;
  return Buffer.from(file.content, "base64").toString("utf8").split("\n")[line - 1] ?? null;
}

// author_association depends on what the token may see: to the App, a private org membership reads as CONTRIBUTOR.
const permissions = new Map();

async function canWrite(login) {
  if (!permissions.has(login)) {
    const result = await request(client, "GET", `collaborators/${encodeURIComponent(login)}/permission`);
    permissions.set(login, result?.permission);
  }
  return ["admin", "write"].includes(permissions.get(login));
}

function counterpartPath(from, path) {
  if (from === client) return `${subtree}/${path}`;
  return path.startsWith(`${subtree}/`) ? path.slice(subtree.length + 1) : null;
}

async function syncComments(pull, draft) {
  const ends = [
    { side: client, number: pull.number, pull },
    { side: monorepo, number: draft.number, pull: draft },
  ];
  for (const end of ends) {
    end.issue = await list(end.side, `issues/${end.number}/comments`);
    end.lines = await list(end.side, `pulls/${end.number}/comments`);
    end.reviews = await list(end.side, `pulls/${end.number}/reviews`);
    end.copies = [
      ["issue", end.issue],
      ["line", end.lines],
    ].flatMap(([kind, items]) =>
      items
        .filter((item) => item.user?.login === end.side.bot)
        .flatMap((item) =>
          [...(item.body ?? "").matchAll(copyPattern)].map((match) => ({ key: match[1], kind, id: item.id })),
        ),
    );
  }
  const verbs = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed" };
  for (const [from, to] of [
    [ends[0], ends[1]],
    [ends[1], ends[0]],
  ]) {
    const people = [...from.issue, ...from.lines, ...from.reviews].filter((item) => item.user && item.user.type !== "Bot");
    const writers = new Set();
    for (const login of new Set(people.map((item) => item.user.login))) {
      if (from.side !== client || (await canWrite(login))) writers.add(login);
    }
    for (const item of people.filter((item) => !writers.has(item.user.login))) {
      console.log(
        `${CLIENT_REPO}#${from.number}: ${item.user.login} can't write to the repository; ${item.id} not copied`,
      );
    }
    const byPerson = (item) => writers.has(item.user?.login);
    const hasText = (item) => Boolean(item.body?.trim());
    for (const review of from.reviews.filter((review) => byPerson(review) && !verbs[review.state])) {
      console.log(`${from.side.repo}#${from.number}: review ${review.id} is ${review.state}; not copied`);
    }
    const items = [
      ...from.issue
        .filter((item) => byPerson(item) && hasText(item))
        .map((item) => ({ kind: "issue", item, at: item.created_at })),
      ...from.reviews
        .filter((review) => byPerson(review) && verbs[review.state])
        .filter((review) => hasText(review) || review.state !== "COMMENTED")
        .map((item) => ({ kind: "review", item, at: item.submitted_at })),
      ...from.lines
        .filter((item) => byPerson(item) && hasText(item))
        .filter((item) => counterpartPath(from.side, item.path) !== null)
        .map((item) => ({ kind: "line", item, at: item.created_at })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    for (const { kind, item } of items) {
      const key = `${from.side.repo}#${from.number} ${kind}:${item.id}`;
      if (to.copies.some((copy) => copy.key === key)) continue;
      const copyMarker = `\n\n<!-- ${markerTag}: copy of ${key} -->`;
      const author = `\`${item.user.login}\``;
      const text = neutralise(item.body);

      try {
        const scanned = from.side === monorepo && hasText(item);
        if (scanned && findsSecrets("stdin", ["--gitleaks-ignore-path", subtree], item.body)) {
          await notice(
            monorepo,
            from.number,
            `secret-comment-${item.id}`,
            `A comment by ${author} looks like it contains a secret, so it was not copied to the client. It is copied once the secret is edited out.`,
          );
          console.log(`::warning::${key} has a possible secret; not copied`);
          continue;
        }
        const placed =
          kind === "line" && (await copyLine(from, to, item, withText(`${author} commented:\n\n`, text, copyMarker)));
        if (placed) {
          to.copies.push({ key, kind: "line", id: placed.id });
          continue;
        }
        let body;
        if (kind === "line") {
          const where = `${neutralise(item.path.replace(/`/g, "'"))}${item.line ? ` line ${item.line}` : ""}`;
          body = withText(`${author} commented on \`${where}\`:\n\n`, text, copyMarker);
        } else {
          const verb = kind === "review" ? verbs[item.state] : "commented";
          body = text ? withText(`${author} ${verb}:\n\n`, text, copyMarker) : `${author} ${verb}.${copyMarker}`;
        }
        const posted = await request(to.side, "POST", `issues/${to.number}/comments`, { body });
        to.copies.push({ key, kind: "issue", id: posted.id });
      } catch (error) {
        console.log(`::warning::${key} was not copied (${error.message}); next run`);
      }
    }
  }
}

async function copyLine(from, to, comment, body) {
  if (comment.in_reply_to_id) {
    const isLine = (copy) => copy.kind === "line";
    const original = from.copies.find((copy) => isLine(copy) && copy.id === comment.in_reply_to_id)?.key;
    const parentKey = `${from.side.repo}#${from.number} line:${comment.in_reply_to_id}`;
    const target = original?.startsWith(`${to.side.repo}#${to.number} line:`)
      ? Number(original.split("line:")[1])
      : to.copies.find((copy) => isLine(copy) && copy.key === parentKey)?.id;
    if (!target) return null;
    return request(to.side, "POST", `pulls/${to.number}/comments/${target}/replies`, { body });
  }
  const path = counterpartPath(from.side, comment.path);
  if (!comment.line || comment.side !== "RIGHT" || comment.subject_type === "file") return null;
  const source = await lineText(from.side, comment.path, comment.commit_id, comment.line);
  const target = await lineText(to.side, path, to.pull.head.sha, comment.line);
  if (source === null || source !== target) return null;

  try {
    return await request(to.side, "POST", `pulls/${to.number}/comments`, {
      body,
      commit_id: to.pull.head.sha,
      path,
      line: comment.line,
      side: "RIGHT",
    });
  } catch (error) {
    console.log(`::warning::line comment ${comment.id} could not be placed (${error.message}); copied as a comment`);
    return null;
  }
}

async function syncPull(number) {
  const pull = await request(client, "GET", `pulls/${number}`);
  const draft = await findDraft(number);

  if (pull.state === "open" && pull.head.repo?.full_name?.toLowerCase() !== CLIENT_REPO.toLowerCase()) {
    await notice(
      client,
      number,
      "fork",
      `Pull requests from forks can't be reviewed. Please push your branch to \`${CLIENT_REPO}\` and raise the pull request from there.`,
    );
    return;
  }
  if (pull.state === "open" && pull.base.ref !== copyBranch) {
    await notice(
      client,
      number,
      "base",
      `Please raise this pull request against \`${copyBranch}\`, the only branch N3O reviews.`,
    );
    return;
  }
  if (!draft) {
    const imported = await importPull(pull);
    if (imported && pull.merged_at) selfMerges.ready.set(number, imported.draft);
    return;
  }
  if (draft.state === "open" && unassigned(draft)) {
    try {
      await assign(draft.number);
    } catch (error) {
      failed.push(number);
      console.log(`::error::${CLIENT_REPO}#${number}: ${error.message}`);
    }
  }
  const marker = readMarker(draft, number);

  if (!marker) {
    await notice(
      monorepo,
      draft.number,
      "no-marker",
      `This description has lost the hidden \`${markerTag}\` marker, so this pull request is no longer kept in step with the client's. Restore the marker from the description's edit history.`,
    );
    console.log(`::warning::${CLIENT_REPO}#${number}: draft #${draft.number} has no ${markerTag} marker; skipped`);
    return;
  }
  if (pull.state === "open" || draft.state === "open") await syncComments(pull, draft);

  if (pull.merged_at) return syncSelfMerged(pull, draft, marker);
  if (pull.state === "closed") {
    if (draft.state !== "open") return;
    await notice(
      monorepo,
      draft.number,
      "client-closed",
      "The client closed their pull request, so this one is closed too.",
    );
    await request(monorepo, "PATCH", `pulls/${draft.number}`, { state: "closed" });
    return;
  }
  if (draft.state === "closed") return handleClosedDraft(pull, draft, marker);
  await syncCommits(pull, draft, marker);
}

// Returns whether the draft now holds all of the client's commits.
async function syncCommits(pull, draft, marker) {
  const clientMoved = pull.head.sha !== marker.client;
  const n3oMoved = draft.head.sha !== marker.draft;
  let written = false;

  if (clientMoved && !n3oMoved) {
    written = (await isAncestor(client, marker.client, pull.head.sha))
      ? await applyClient(pull, draft, marker)
      : await importPull(pull, draft);
  } else if (n3oMoved && !clientMoved) {
    if (!pull.merged_at) written = await pushToClient(pull, draft, marker);
  } else if (clientMoved && n3oMoved) {
    written =
      (await recordIfInStep(pull, draft, marker)) || (await reportStuck(pull, draft, "both sides have new commits"));
  }
  if (!written && (draft.title !== draftTitle(pull) || draft.body !== draftBody(pull, marker, draft))) {
    await writeDraft(draft, pull, marker);
  }
  return !clientMoved || Boolean(written);
}

async function syncSelfMerged(pull, draft, marker) {
  if (draft.state === "open") {
    if (await syncCommits(pull, draft, marker)) selfMerges.ready.set(pull.number, draft.number);
    return;
  }
  const merged =
    draft.merged_at &&
    pull.head.sha === marker.client &&
    (marker.draft === draft.head.sha || (await isAncestor(monorepo, marker.draft, draft.head.sha)));

  if (merged && (await isAncestor(monorepo, draft.merge_commit_sha, mainHead))) selfMerges.ready.set(pull.number, null);
}

const copySubject = new RegExp(COPY_PATTERN);
const noSelfMerges = () => ({ commits: [], numbers: new Set(), forkPoints: new Map(), ready: new Map() });

async function findSelfMerges() {
  const found = noSelfMerges();
  const heads = git(client, ["ls-remote", url(client), `refs/heads/${copyBranch}`]);
  if (!heads.split("\n").some((line) => line.endsWith(`\trefs/heads/${copyBranch}`))) return found;
  git(client, ["fetch", "-q", "--no-tags", url(client), `+refs/heads/${copyBranch}:refs/n3o-source-sync/client-main`]);
  found.head = git(monorepo, ["rev-parse", "refs/n3o-source-sync/client-main"]);
  const format = "--format=%H%x09%P%x09%ce%x09%s";
  const log = git(monorepo, ["log", "--first-parent", format, "refs/n3o-source-sync/client-main"]);

  for (const line of log.split("\n")) {
    const [sha, parents, email, ...subject] = line.split("\t");
    const copied = copySubject.exec(subject.join("\t"));
    if (email === CLIENT_BOT_EMAIL && copied) {
      found.copied = copied[1];
      break;
    }
    found.commits.push({ sha, parent: parents.split(" ")[0] });
  }
  if (!found.copied) return found;
  for (const commit of found.commits) {
    const pulls = await list(client, `commits/${commit.sha}/pulls`);
    commit.number = pulls.find((pull) => pull.merged_at && pull.base.ref === copyBranch)?.number;
    if (!commit.number) continue;
    found.numbers.add(commit.number);
    // The log runs newest first, so the last write per pull request is its oldest commit's parent: main
    // before the merge.
    found.forkPoints.set(commit.number, commit.parent);
  }
  return found;
}

async function adoptHead() {
  const missing = selfMerges.commits.filter((commit) => !selfMerges.ready.has(commit.number));
  if (missing.length) {
    const shas = missing
      .slice(0, 5)
      .map((commit) => commit.sha.slice(0, 7))
      .join(", ");
    throw new Error(`${missing.length} commits the copy did not make that no draft here holds (newest ${shas})`);
  }
  const comparison = await request(monorepo, "GET", `compare/${selfMerges.copied}...${mainHead}`);

  if (!comparison) throw new Error(`the last copy names ${selfMerges.copied}, which is not a commit here`);
  if (comparison.status === "behind") {
    console.log(`${CLIENT_REPO} ${copyBranch} was copied from a newer commit than this run's checkout; next run`);
    return "";
  }
  const goesBack = `This pull request was merged here, but changes reach \`${copyBranch}\` only through N3O, so \`${copyBranch}\` goes back to N3O's copy.`;
  for (const number of selfMerges.numbers) {
    const draftNumber = selfMerges.ready.get(number);
    const text = draftNumber
      ? `${goesBack} N3O is reviewing the change as \`${monorepo.repo}#${draftNumber}\`, and it comes back only if N3O merges it, although this pull request still shows as merged.`
      : `${goesBack} N3O's copy already holds this change.`;
    await notice(client, number, "self-merged", text);
  }
  return selfMerges.head;
}

const mainHead = git(monorepo, ["rev-parse", "HEAD"]);
const mergeHeads = [];
const failed = [];

function mainFailed(error) {
  failed.push(copyBranch);
  console.log(`::error::${CLIENT_REPO} ${copyBranch}: ${error.message}`);
}

let selfMerges = noSelfMerges();

try {
  selfMerges = await findSelfMerges();
} catch (error) {
  mainFailed(error);
}
const openPulls = await list(client, "pulls?state=open");
const openDrafts = (await list(monorepo, "pulls?state=open")).filter(
  (pull) =>
    pull.head.repo?.full_name === monorepo.repo && new RegExp(`^${escapeRegExp(prefix)}\\d+$`).test(pull.head.ref),
);
const numbers = [
  ...new Set([
    ...openPulls.map((pull) => pull.number),
    ...openDrafts.map((pull) => Number(pull.head.ref.slice(prefix.length))),
    ...selfMerges.numbers,
  ]),
].sort((a, b) => a - b);

for (const number of numbers) {
  try {
    await syncPull(number);
  } catch (error) {
    failed.push(number);
    console.log(`::error::${CLIENT_REPO}#${number}: ${error.message}`);
  } finally {
    git(monorepo, ["checkout", "-q", "--force", "--detach", mainHead]);
  }
}

let adopt = "";

if (selfMerges.commits.length) {
  try {
    adopt = await adoptHead();
  } catch (error) {
    mainFailed(error);
  }
}
appendFileSync(GITHUB_OUTPUT, `merge-heads=${mergeHeads.join(" ")}\nadopt-head=${adopt}\n`);

if (failed.length) process.exit(1);
