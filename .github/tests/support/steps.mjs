import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const actionsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../actions");

export function stepScript(action, step) {
  const lines = readFileSync(join(actionsDir, action, "action.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*-? *(name|id): ${step}$`).test(line));
  if (start < 0) throw new Error(`${action} has no step ${step}`);
  const at = lines.findIndex((line, index) => index > start && /^\s*run: /.test(line));
  const quoted = /^\s*run: '(.*)'$/.exec(lines[at]);
  if (quoted) return quoted[1].replace(/''/g, "'");
  const indent = lines[at].search(/\S/);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join("\n");
}

export function runStep(action, step, { env = {}, cwd } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "n3o-step-"));
  const script = join(temp, "step.sh");
  const output = join(temp, "output");
  writeFileSync(script, stepScript(action, step));
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: join(actionsDir, action),
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: env.RUNNER_TEMP ?? temp,
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status, log: `${result.stdout}${result.stderr}`, outputs };
}
