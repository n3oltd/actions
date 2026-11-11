import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { workspace, write } from "./support/git.mjs";
import { actionsDir, runStep } from "./support/steps.mjs";

const usyncKeys = `[extend]
useDefault = true

[[allowlists]]
description = "uSync item keys"
targetRules = ["generic-api-key"]
condition = "AND"
paths = ['''(^|[\\\\/])uSync[\\\\/]''']
regexes = ['''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''']
`;
const itemKey = '<ContentType Key="7c9e6679-7425-40de-944b-e07fc1f90ae7" Alias="page" Level="2">\n</ContentType>\n';
const token = () => randomBytes(24).toString("base64url");
const fakeSendGridKey = () => `SG.${token().slice(0, 22)}.${token().slice(0, 32)}${token().slice(0, 11)}`;

before(() => assert.ok(process.env.GITLEAKS, "GITLEAKS must be the path of a gitleaks binary"));

function scan(files) {
  const dir = workspace();
  write(dir, files);
  const config = runStep("n3o-secret-scan", "check config", { env: { CONFIG: join(dir, ".gitleaks.toml") } });
  if (config.status !== 0) return { config };
  const result = runStep("n3o-secret-scan", "scan", {
    env: { CONFIG: config.outputs.config, GITLEAKS: process.env.GITLEAKS, SCAN_PATH: dir },
  });
  return { dir, config, result };
}

function defaultsOnly(dir) {
  const config = join(workspace(), "defaults.toml");
  writeFileSync(config, "[extend]\nuseDefault = true\n");
  return spawnSync(process.env.GITLEAKS, ["dir", "--no-banner", "--config", config, dir], { encoding: "utf8" }).status;
}

test("the composed config is the directory's config followed by the markup rules", () => {
  const { config } = scan({ ".gitleaks.toml": usyncKeys });

  assert.equal(config.status, 0, config.log);
  const composed = readFileSync(config.outputs.config, "utf8");
  const rules = readFileSync(join(actionsDir, "n3o-secret-scan", "markup-rules.toml"), "utf8");
  assert.equal(composed, `${usyncKeys}\n${rules}`);
});

test("without a config, the markup rules are added to the defaults", () => {
  const { config } = scan({ "readme.md": "nothing\n" });

  assert.equal(config.status, 0, config.log);
  assert.match(readFileSync(config.outputs.config, "utf8"), /^\[extend\]\nuseDefault = true\n\n\[\[rules\]\]/);
});

test("a config that replaces the default rules is refused", () => {
  const { config } = scan({ ".gitleaks.toml": "[extend]\nuseDefault = false\n" });

  assert.equal(config.status, 1);
  assert.match(config.log, /must set useDefault = true/);
});

test("a credential in a uSync property is found", () => {
  const { dir, result } = scan({
    "uSync/v9/Content/settings.config": `<Content>\n  <apiKey>\n    <Value><![CDATA[${token()}]]></Value>\n  </apiKey>\n</Content>\n`,
  });

  assert.equal(result.status, 1, result.log);
  assert.equal(defaultsOnly(dir), 0);
});

test("a SendGrid key inside an XML element is found", () => {
  const { dir, result } = scan({ "web.config": `<settings>\n  <apiKey>${fakeSendGridKey()}</apiKey>\n</settings>\n` });

  assert.equal(result.status, 1, result.log);
  assert.equal(defaultsOnly(dir), 0);
});

test("the directory's allowlists still apply", () => {
  const allowed = scan({ ".gitleaks.toml": usyncKeys, "uSync/v9/ContentTypes/page.config": itemKey });
  const control = scan({ "uSync/v9/ContentTypes/page.config": itemKey });

  assert.equal(allowed.result.status, 0, allowed.result.log);
  assert.equal(control.result.status, 1, control.result.log);
});
