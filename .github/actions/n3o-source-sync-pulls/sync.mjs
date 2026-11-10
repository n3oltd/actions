import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const {
  SUBTREE_PATH: subtree,
  CLIENT_REPO,
  BRANCH_PREFIX: prefix,
  GITHUB_REPOSITORY,
  CLIENT_TOKEN,
  SITES_TOKEN,
  RUNNER_TEMP,
  GITHUB_OUTPUT,
} = process.env;
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const copyBranch = "main";
const tag = "n3o-source-sync";
const sitesBot = "github-actions[bot]";
const clientBot = { name: "n3o-source-sync[bot]", email: "354428725+n3o-source-sync[bot]@users.noreply.github.com" };

const client = { repo: CLIENT_REPO, token: CLIENT_TOKEN };
const sites = { repo: GITHUB_REPOSITORY, token: SITES_TOKEN };

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
    const batch = await request(side, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
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

function git(side, args, { cwd, input, env } = {}) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...auth(side), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

const url = (side) => `https://github.com/${side.repo}.git`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stateMarker = (number, clientHead, draftHead) =>
  `<!-- ${tag}: ${CLIENT_REPO}#${number} client=${clientHead} draft=${draftHead} -->`;
const statePattern = (number) =>
  new RegExp(`<!-- ${escape(tag)}: ${escape(CLIENT_REPO)}#${number} client=([0-9a-f]{40}) draft=([0-9a-f]{40}) -->`);
const copyPattern = new RegExp(`<!-- ${escape(tag)}: copy of (\\S+ \\w+:\\d+) -->`, "g");

function readState(draft, number) {
  const match = statePattern(number).exec(draft.body ?? "");
  return match && { client: match[1], draft: match[2] };
}

// A mention copied to the other repository would notify whoever holds that login there.
const unmention = (text) => (text ?? "").replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@\u2060");

async function notice(side, number, key, text) {
  const marker = `<!-- ${tag}: notice ${key} -->`;
  const comments = await list(side, `issues/${number}/comments`);
  if (comments.some((comment) => comment.body?.includes(marker))) return;
  await request(side, "POST", `issues/${number}/comments`, { body: `${text}\n\n${marker}` });
}

async function isAncestor(side, base, head) {
  const comparison = await request(side, "GET", `compare/${base}...${head}`);
  return comparison !== null && (comparison.status === "ahead" || comparison.status === "identical");
}

async function findDraft(number) {
  const owner = sites.repo.split("/")[0];
  const drafts = await list(sites, `pulls?state=all&head=${owner}:${encodeURIComponent(`${prefix}${number}`)}`);
  return drafts.sort((a, b) => b.number - a.number)[0];
}

function fetchClientHead(pull) {
  git(client, [
    "fetch",
    "-q",
    "--no-tags",
    url(client),
    `+refs/heads/${copyBranch}:refs/n3o-source-sync/client-base`,
    `+refs/heads/${pull.head.ref}:refs/n3o-source-sync/client-head`,
  ]);
  const head = git(sites, ["rev-parse", "refs/n3o-source-sync/client-head"]);
  if (head !== pull.head.sha)
    throw new Error(`${pull.head.ref} moved to ${head} during this run; it is picked up next run`);
}

function applyClientCommits(from, to) {
  const patches = git(sites, ["format-patch", "--stdout", `${from}..${to}`]);
  if (!patches) return true;
  try {
    git(sites, ["am", "-q", "-3", `--directory=${subtree}`], { input: `${patches}\n` });
    return true;
  } catch {
    git(sites, ["am", "--abort"]);
    return false;
  }
}

function pushDraftBranch(number, force) {
  git(sites, ["push", "-q", ...(force ? ["--force"] : []), url(sites), `HEAD:refs/heads/${prefix}${number}`]);
  return git(sites, ["rev-parse", "HEAD"]);
}

async function writeState(draft, number, clientHead, draftHead) {
  const body = draft.body.replace(statePattern(number), stateMarker(number, clientHead, draftHead));
  await request(sites, "PATCH", `pulls/${draft.number}`, { body });
}

async function importPull(pull, draft) {
  fetchClientHead(pull);
  const forkPoint = git(sites, ["merge-base", "refs/n3o-source-sync/client-base", "refs/n3o-source-sync/client-head"]);
  git(sites, ["checkout", "-q", "--force", "--detach", mainHead]);
  if (!applyClientCommits(forkPoint, pull.head.sha)) {
    await notice(
      client,
      pull.number,
      `stale-${pull.head.sha}`,
      `This change no longer applies to the latest \`${copyBranch}\`. Please update the branch from \`${copyBranch}\` and push again.`,
    );
    return;
  }
  const draftHead = pushDraftBranch(pull.number, true);
  if (draft) {
    await writeState(draft, pull.number, pull.head.sha, draftHead);
    console.log(`${CLIENT_REPO}#${pull.number}: rebuilt draft #${draft.number} from the rewritten branch`);
    return;
  }
  const body = [
    `Imported from \`${CLIENT_REPO}#${pull.number}\`, opened by \`${pull.user.login}\`.`,
    unmention(pull.body),
    "no-work-issue: imported from a client pull request",
    stateMarker(pull.number, pull.head.sha, draftHead),
  ]
    .filter(Boolean)
    .join("\n\n");
  const created = await request(sites, "POST", "pulls", {
    title: pull.title,
    head: `${prefix}${pull.number}`,
    base: "main",
    body,
    draft: true,
  });
  console.log(`${CLIENT_REPO}#${pull.number}: imported as draft #${created.number}`);
}

async function applyClient(pull, draft, state) {
  fetchClientHead(pull);
  git(sites, [
    "fetch",
    "-q",
    "--no-tags",
    "--depth=1",
    url(sites),
    `+refs/heads/${draft.head.ref}:refs/n3o-source-sync/draft`,
  ]);
  git(sites, ["checkout", "-q", "--force", "--detach", "refs/n3o-source-sync/draft"]);
  if (!applyClientCommits(state.client, pull.head.sha)) {
    await bothMoved(pull, draft, "the client's new commits no longer apply to the draft");
    return;
  }
  const draftHead = pushDraftBranch(pull.number, false);
  await writeState(draft, pull.number, pull.head.sha, draftHead);
  console.log(`${CLIENT_REPO}#${pull.number}: applied the client's new commits to draft #${draft.number}`);
}

async function pushToClient(pull, draft, state) {
  const comparison = await request(sites, "GET", `compare/${state.draft}...${draft.head.sha}`);
  if (comparison?.status !== "ahead") return bothMoved(pull, draft, "the draft branch was rewritten");
  if (comparison.commits.some((commit) => commit.parents.length > 1)) {
    return bothMoved(pull, draft, "the draft has a merge commit, which can't be sent to the client's branch");
  }
  git(sites, [
    "fetch",
    "-q",
    "--no-tags",
    `--depth=${comparison.ahead_by + 1}`,
    url(sites),
    `+refs/heads/${draft.head.ref}:refs/n3o-source-sync/draft`,
  ]);
  const patches = git(sites, [
    "format-patch",
    "--stdout",
    `--relative=${subtree}`,
    `${state.draft}..refs/n3o-source-sync/draft`,
    "--",
    subtree,
  ]);
  if (patches) {
    const work = mkdtempSync(join(RUNNER_TEMP, "n3o-source-sync-"));
    git(client, ["init", "-q", work]);
    git(client, ["fetch", "-q", "--no-tags", "--depth=1", url(client), `refs/heads/${pull.head.ref}`], { cwd: work });
    git(client, ["checkout", "-q", "--detach", "FETCH_HEAD"], { cwd: work });
    if (git(client, ["rev-parse", "HEAD"], { cwd: work }) !== pull.head.sha) {
      throw new Error(`${pull.head.ref} moved during this run; it is picked up next run`);
    }
    const committer = { GIT_COMMITTER_NAME: clientBot.name, GIT_COMMITTER_EMAIL: clientBot.email };
    try {
      git(client, ["am", "-q"], { cwd: work, input: `${patches}\n`, env: committer });
    } catch {
      return bothMoved(pull, draft, "N3O's commits don't apply to the client's branch");
    }
    git(client, ["push", "-q", url(client), `HEAD:refs/heads/${pull.head.ref}`], { cwd: work });
    const clientHead = git(client, ["rev-parse", "HEAD"], { cwd: work });
    await writeState(draft, pull.number, clientHead, draft.head.sha);
    console.log(`${CLIENT_REPO}#${pull.number}: pushed N3O's commits from draft #${draft.number}`);
    return;
  }
  await writeState(draft, pull.number, state.client, draft.head.sha);
}

async function bothMoved(pull, draft, reason) {
  const key = `stuck-${pull.head.sha}-${draft.head.sha}`;
  const text = `This pull request and its copy have both changed since they were last in step (${reason}), so neither was updated. Someone at N3O needs to bring them back in step by hand.`;
  await notice(client, pull.number, key, text);
  await notice(sites, draft.number, key, text);
  console.log(`::warning::${CLIENT_REPO}#${pull.number}: ${reason}; left for N3O`);
}

async function closedDraft(pull, draft, state) {
  if (draft.merged_at) {
    if (pull.head.sha === state.client) {
      mergeHeads.push(pull.head.sha);
      console.log(`${CLIENT_REPO}#${pull.number}: draft #${draft.number} merged; the next copy marks it merged`);
      return;
    }
    await notice(
      client,
      pull.number,
      "merged-early",
      `N3O merged this change as of ${state.client.slice(0, 7)}, without the commits pushed after it, so this pull request has been closed. Please raise the rest as a new pull request.`,
    );
    await request(client, "PATCH", `pulls/${pull.number}`, { state: "closed" });
    return;
  }
  const issue = await request(sites, "GET", `issues/${draft.number}`);
  if (issue?.closed_by?.login === sitesBot) {
    await request(sites, "PATCH", `pulls/${draft.number}`, { state: "open" });
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

function counterpartPath(from, path) {
  if (from === client) return `${subtree}/${path}`;
  return path.startsWith(`${subtree}/`) ? path.slice(subtree.length + 1) : null;
}

async function syncComments(number, draftNumber) {
  const ends = [
    { side: client, number, pull: await request(client, "GET", `pulls/${number}`) },
    { side: sites, number: draftNumber, pull: await request(sites, "GET", `pulls/${draftNumber}`) },
  ];
  for (const end of ends) {
    end.issue = await list(end.side, `issues/${end.number}/comments`);
    end.lines = await list(end.side, `pulls/${end.number}/comments`);
    end.reviews = await list(end.side, `pulls/${end.number}/reviews`);
    end.copied = new Set(
      [...end.issue, ...end.lines, ...end.reviews].flatMap((item) =>
        [...(item.body ?? "").matchAll(copyPattern)].map((match) => match[1]),
      ),
    );
  }
  const verbs = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed" };
  for (const [from, to] of [
    [ends[0], ends[1]],
    [ends[1], ends[0]],
  ]) {
    const human = (item) => item.user?.type !== "Bot" && item.body?.trim() && !item.body.includes(`<!-- ${tag}:`);
    const items = [
      ...from.issue.filter(human).map((item) => ({ kind: "issue", item, at: item.created_at })),
      ...from.reviews
        .filter((review) => human(review) && verbs[review.state])
        .map((item) => ({ kind: "review", item, at: item.submitted_at })),
      ...from.lines.filter(human).map((item) => ({ kind: "line", item, at: item.created_at })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    for (const { kind, item } of items) {
      const key = `${from.side.repo}#${from.number} ${kind}:${item.id}`;
      if (to.copied.has(key)) continue;
      const marker = `<!-- ${tag}: copy of ${key} -->`;
      const author = `\`${item.user.login}\``;
      const text = unmention(item.body);
      if (kind === "line") {
        const placed = await copyLine(from, to, item, `${author} commented:\n\n${text}\n\n${marker}`);
        if (!placed) {
          await request(to.side, "POST", `issues/${to.number}/comments`, {
            body: `${author} commented on \`${item.path}\`${item.line ? ` line ${item.line}` : ""}:\n\n${text}\n\n${marker}`,
          });
        }
      } else {
        const verb = kind === "review" ? verbs[item.state] : "commented";
        await request(to.side, "POST", `issues/${to.number}/comments`, {
          body: `${author} ${verb}:\n\n${text}\n\n${marker}`,
        });
      }
      to.copied.add(key);
    }
  }
}

async function copyLine(from, to, comment, body) {
  if (comment.in_reply_to_id) {
    // The parent is either a copy of a comment on the other side, or an original whose copy is there.
    const parent = from.lines.find((item) => item.id === comment.in_reply_to_id);
    const original = [...(parent?.body ?? "").matchAll(copyPattern)]
      .map((match) => match[1])
      .find((key) => key.startsWith(`${to.side.repo}#${to.number} line:`));
    let target = original && Number(original.split("line:")[1]);
    if (!target) {
      const parentKey = `${from.side.repo}#${from.number} line:${comment.in_reply_to_id}`;
      const lines = await list(to.side, `pulls/${to.number}/comments`);
      target = lines.find((item) => item.body?.includes(`copy of ${parentKey} -->`))?.id;
    }
    if (!target) return false;
    await request(to.side, "POST", `pulls/${to.number}/comments/${target}/replies`, { body });
    return true;
  }
  const path = counterpartPath(from.side, comment.path);
  if (!path || !comment.line || comment.side !== "RIGHT" || comment.subject_type === "file") return false;
  const source = await lineText(from.side, comment.path, comment.commit_id, comment.line);
  const target = await lineText(to.side, path, to.pull.head.sha, comment.line);
  if (source === null || source !== target) return false;
  try {
    await request(to.side, "POST", `pulls/${to.number}/comments`, {
      body,
      commit_id: to.pull.head.sha,
      path,
      line: comment.line,
      side: "RIGHT",
    });
    return true;
  } catch (error) {
    console.log(`::warning::line comment ${comment.id} could not be placed (${error.message}); copied as a comment`);
    return false;
  }
}

async function syncPull(number) {
  const pull = await request(client, "GET", `pulls/${number}`);
  const draft = await findDraft(number);
  const state = draft && readState(draft, number);

  if (pull.state === "closed") {
    if (draft?.state !== "open") return;
    if (pull.merged_at) {
      console.log(
        `::warning::${CLIENT_REPO}#${number} was merged in the client repository; draft #${draft.number} is left for N3O`,
      );
      return;
    }
    await notice(
      sites,
      draft.number,
      "client-closed",
      "The client closed their pull request, so this one is closed too.",
    );
    await request(sites, "PATCH", `pulls/${draft.number}`, { state: "closed" });
    return;
  }
  if (pull.head.repo?.full_name !== CLIENT_REPO) {
    await notice(
      client,
      number,
      "fork",
      `Pull requests from forks can't be reviewed. Please push your branch to \`${CLIENT_REPO}\` and raise the pull request from there.`,
    );
    return;
  }
  if (pull.base.ref !== copyBranch) {
    await notice(
      client,
      number,
      "base",
      `Please raise this pull request against \`${copyBranch}\`, the only branch N3O reviews.`,
    );
    return;
  }
  if (!draft) return importPull(pull);
  if (!state) throw new Error(`draft #${draft.number} has no ${tag} marker`);
  if (draft.state === "closed") return closedDraft(pull, draft, state);

  const clientMoved = pull.head.sha !== state.client;
  const n3oMoved = draft.head.sha !== state.draft;
  if (clientMoved && !n3oMoved) {
    if (await isAncestor(client, state.client, pull.head.sha)) await applyClient(pull, draft, state);
    else await importPull(pull, draft);
  } else if (n3oMoved && !clientMoved) {
    await pushToClient(pull, draft, state);
  } else if (clientMoved && n3oMoved) {
    await bothMoved(pull, draft, "both sides have new commits");
  }
  if (pull.title !== draft.title) await request(sites, "PATCH", `pulls/${draft.number}`, { title: pull.title });
  await syncComments(number, draft.number);
}

const mainHead = git(sites, ["rev-parse", "HEAD"]);
const mergeHeads = [];
const failed = [];
const openPulls = await list(client, "pulls?state=open");
const openDrafts = (await list(sites, "pulls?state=open")).filter(
  (pull) => pull.head.repo?.full_name === sites.repo && new RegExp(`^${escape(prefix)}\\d+$`).test(pull.head.ref),
);
const numbers = [
  ...new Set([
    ...openPulls.map((pull) => pull.number),
    ...openDrafts.map((pull) => Number(pull.head.ref.slice(prefix.length))),
  ]),
].sort((a, b) => a - b);

for (const number of numbers) {
  try {
    await syncPull(number);
  } catch (error) {
    failed.push(number);
    console.log(`::error::${CLIENT_REPO}#${number}: ${error.message}`);
  } finally {
    if (existsSync(git(sites, ["rev-parse", "--git-path", "rebase-apply"]))) git(sites, ["am", "--abort"]);
    git(sites, ["checkout", "-q", "--force", "--detach", mainHead]);
  }
}

appendFileSync(GITHUB_OUTPUT, `merge-heads=${mergeHeads.join(" ")}\n`);
if (failed.length) process.exit(1);
