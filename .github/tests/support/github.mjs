import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

function bareGit(bare, args) {
  try {
    return execFileSync("git", ["--git-dir", bare, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const now = () => new Date().toISOString();

export class GitHub {
  constructor() {
    this.repos = new Map();
    this.requests = [];
    this.nextId = 1000;
  }

  addRepo(full, { bare, token, bot }) {
    const repo = {
      full,
      bare,
      token,
      bot,
      pulls: new Map(),
      issueComments: [],
      lineComments: [],
      reviews: [],
      permissions: new Map(),
      assignable: new Set(),
      commitPulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(full, repo);
    return repo;
  }

  openPull(full, { head, base = "main", title = "A change", body = "", user, headRepo = full }) {
    const repo = this.repos.get(full);
    const pull = {
      number: repo.nextNumber++,
      state: "open",
      merged_at: null,
      merge_commit_sha: null,
      draft: false,
      title,
      body,
      user: { login: user, type: "User" },
      head: { ref: head, sha: bareGit(repo.bare, ["rev-parse", `refs/heads/${head}`]), repo: { full_name: headRepo } },
      base: { ref: base },
      assignees: [],
      closed_by: null,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  pull(full, number) {
    const repo = this.repos.get(full);
    const pull = repo.pulls.get(number);
    if (pull.state === "open" && pull.head.repo.full_name === full) {
      pull.head.sha = bareGit(repo.bare, ["rev-parse", `refs/heads/${pull.head.ref}`]) ?? pull.head.sha;
    }
    return pull;
  }

  close(full, number, { by, merged, mergeCommit } = {}) {
    const pull = this.pull(full, number);
    pull.state = "closed";
    pull.closed_by = { login: by };
    if (merged) {
      pull.merged_at = now();
      pull.merge_commit_sha = mergeCommit;
    }
  }

  review(full, number, { user, state, body = "" }) {
    const repo = this.repos.get(full);
    const review = {
      id: this.nextId++,
      pull: number,
      user: { login: user, type: "User" },
      state,
      body,
      submitted_at: now(),
    };
    repo.reviews.push(review);
    return review;
  }

  comments(full, number) {
    return this.repos.get(full).issueComments.filter((comment) => comment.issue === number);
  }

  async start() {
    this.server = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => (data += chunk));
      request.on("end", () => {
        const body = data ? JSON.parse(data) : undefined;
        const [status, payload] = this.route(
          request.method,
          new URL(request.url, "http://mock"),
          body,
          request.headers,
        );
        this.requests.push({ method: request.method, url: request.url, body, status });
        response.writeHead(status, { "content-type": "application/json", connection: "close" });
        response.end(payload === undefined ? "" : JSON.stringify(payload));
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  stop() {
    this.server?.close();
  }

  route(method, url, body, headers) {
    const match = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(url.pathname);
    const repo = match && this.repos.get(match[1]);
    if (!repo) return [404, { message: "Not Found" }];
    if (headers.authorization !== `Bearer ${repo.token}`) return [401, { message: "Bad credentials" }];
    const path = match[2];
    const page = Number(url.searchParams.get("page") ?? 1);
    const paged = (items) => [200, page === 1 ? items : []];
    let parts;

    if (path === "pulls" && method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const head = url.searchParams.get("head");
      const pulls = [...repo.pulls.keys()]
        .map((number) => this.pull(repo.full, number))
        .filter((pull) => state === "all" || pull.state === state)
        .filter((pull) => !head || `${pull.head.repo.full_name.split("/")[0]}:${pull.head.ref}` === head);
      return paged(pulls);
    }
    if (path === "pulls" && method === "POST") {
      const pull = this.openPull(repo.full, {
        head: body.head,
        base: body.base,
        title: body.title,
        body: body.body,
        user: repo.bot,
      });
      pull.user.type = "Bot";
      pull.draft = body.draft;
      return [201, pull];
    }
    if ((parts = /^pulls\/(\d+)$/.exec(path))) {
      const pull = repo.pulls.has(Number(parts[1])) && this.pull(repo.full, Number(parts[1]));
      if (!pull) return [404, { message: "Not Found" }];
      if (method === "GET") return [200, pull];
      if (body.title !== undefined) pull.title = body.title;
      if (body.body !== undefined) pull.body = body.body;
      if (body.state === "closed" && pull.state === "open") this.close(repo.full, pull.number, { by: repo.bot });
      if (body.state === "open") pull.state = "open";
      return [200, pull];
    }
    if ((parts = /^pulls\/(\d+)\/reviews$/.exec(path))) {
      return paged(repo.reviews.filter((review) => review.pull === Number(parts[1])));
    }
    if ((parts = /^pulls\/(\d+)\/reviews\/(\d+)\/dismissals$/.exec(path)) && method === "PUT") {
      const review = repo.reviews.find((item) => item.id === Number(parts[2]));
      review.state = "DISMISSED";
      return [200, review];
    }
    if ((parts = /^pulls\/(\d+)\/comments$/.exec(path))) {
      if (method === "GET") return paged(repo.lineComments.filter((comment) => comment.pull === Number(parts[1])));
      const comment = {
        id: this.nextId++,
        pull: Number(parts[1]),
        user: { login: repo.bot, type: "Bot" },
        created_at: now(),
        ...body,
      };
      repo.lineComments.push(comment);
      return [201, comment];
    }
    if ((parts = /^pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(path))) {
      const comment = {
        id: this.nextId++,
        pull: Number(parts[1]),
        in_reply_to_id: Number(parts[2]),
        user: { login: repo.bot, type: "Bot" },
        created_at: now(),
        ...body,
      };
      repo.lineComments.push(comment);
      return [201, comment];
    }
    if ((parts = /^issues\/(\d+)\/comments$/.exec(path))) {
      if (method === "GET") return paged(this.comments(repo.full, Number(parts[1])));
      if (body.body.length > 65536) return [422, { message: "body is too long" }];
      const comment = {
        id: this.nextId++,
        issue: Number(parts[1]),
        user: { login: repo.bot, type: "Bot" },
        created_at: now(),
        body: body.body,
      };
      repo.issueComments.push(comment);
      return [201, comment];
    }
    if ((parts = /^issues\/(\d+)\/assignees$/.exec(path)) && method === "POST") {
      const pull = this.pull(repo.full, Number(parts[1]));
      for (const login of body.assignees.filter((login) => repo.assignable.has(login))) {
        if (!pull.assignees.some((assignee) => assignee.login === login)) pull.assignees.push({ login });
      }
      return [201, { number: pull.number, assignees: pull.assignees }];
    }
    if ((parts = /^issues\/(\d+)$/.exec(path))) {
      const pull = this.pull(repo.full, Number(parts[1]));
      return [200, { number: pull.number, closed_by: pull.closed_by }];
    }
    if ((parts = /^compare\/([^.]+)\.\.\.(.+)$/.exec(path))) return this.compare(repo, parts[1], parts[2]);
    if ((parts = /^collaborators\/([^/]+)\/permission$/.exec(path))) {
      const permission = repo.permissions.get(decodeURIComponent(parts[1]));
      return permission ? [200, { permission }] : [404, { message: "Not Found" }];
    }
    if ((parts = /^contents\/(.+)$/.exec(path))) {
      const content = bareGit(repo.bare, ["show", `${url.searchParams.get("ref")}:${decodeURIComponent(parts[1])}`]);
      return content === null
        ? [404, { message: "Not Found" }]
        : [200, { content: Buffer.from(`${content}\n`).toString("base64") }];
    }
    if ((parts = /^commits\/([0-9a-f]{40})\/pulls$/.exec(path))) {
      return paged((repo.commitPulls.get(parts[1]) ?? []).map((number) => this.pull(repo.full, number)));
    }
    return [404, { message: `No mock for ${method} ${path}` }];
  }

  compare(repo, base, head) {
    const [from, to] = [base, head].map((ref) =>
      bareGit(repo.bare, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]),
    );
    if (!from || !to) return [404, { message: "Not Found" }];
    const mergeBase = bareGit(repo.bare, ["merge-base", from, to]);
    const status = from === to ? "identical" : mergeBase === from ? "ahead" : mergeBase === to ? "behind" : "diverged";
    const commits = (bareGit(repo.bare, ["rev-list", "--reverse", "--parents", `${from}..${to}`]) || "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...parents] = line.split(" ");
        return { sha, parents: parents.map((parent) => ({ sha: parent })) };
      });
    const files = (bareGit(repo.bare, ["diff", "--name-only", mergeBase, to]) || "")
      .split("\n")
      .filter(Boolean)
      .map((filename) => ({ filename }));
    return [
      200,
      {
        status,
        ahead_by: commits.length,
        behind_by: Number(bareGit(repo.bare, ["rev-list", "--count", `${to}..${from}`])),
        commits,
        files,
        merge_base_commit: { sha: mergeBase },
      },
    ];
  }
}
