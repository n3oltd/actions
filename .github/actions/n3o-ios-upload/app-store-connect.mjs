import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [command, bundleId, marketingVersion, buildNumber, waitMinutes] = process.argv.slice(2);
const { ASC_KEY_FILE, ASC_KEY_ID, ASC_ISSUER_ID } = process.env;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }),
  );
  const key = createPrivateKey(readFileSync(ASC_KEY_FILE));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });

  return `${header}.${payload}.${base64Url(signature)}`;
}

async function get(path, query) {
  const url = new URL(`https://api.appstoreconnect.apple.com/v1/${path}`);

  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url, { headers: { authorization: `Bearer ${token()}` } });

  if (!response.ok) {
    throw new Error(`GET ${url.pathname} answered ${response.status}: ${await response.text()}`);
  }

  return (await response.json()).data;
}

async function findApp() {
  const apps = await get("apps", { "filter[bundleId]": bundleId, "fields[apps]": "bundleId" });
  const app = apps.find((candidate) => candidate.attributes.bundleId === bundleId);

  if (!app) {
    throw new Error(`App Store Connect has no app with bundle ID ${bundleId}`);
  }

  return app.id;
}

async function findBuild(appId) {
  const builds = await get("builds", {
    "filter[app]": appId,
    "filter[version]": buildNumber,
    "filter[preReleaseVersion.version]": marketingVersion,
    "fields[builds]": "version,processingState",
    limit: "1",
  });

  return builds[0] ? { id: builds[0].id, state: builds[0].attributes.processingState } : null;
}

const appId = await findApp();

if (command === "find") {
  const build = await findBuild(appId);
  console.log(JSON.stringify(build ?? {}));
} else if (command === "wait") {
  const deadline = Date.now() + Number(waitMinutes) * 60_000;
  let build = await findBuild(appId);

  while (!build && Date.now() < deadline) {
    await sleep(30_000);
    build = await findBuild(appId);
  }

  if (!build) {
    throw new Error(`${bundleId} ${marketingVersion} (${buildNumber}) did not appear within ${waitMinutes} minutes`);
  }

  console.log(JSON.stringify(build));
} else {
  throw new Error(`unknown command ${command}`);
}
