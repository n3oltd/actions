import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const { SERVICE_ACCOUNT_FILE, PACKAGE_NAME, AAB, VERSION_CODE, RELEASE_NAME, TRACK, CHANGES_NOT_SENT_FOR_REVIEW, DRY_RUN } =
  process.env;

const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}`;
const upload = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}`;

async function accessToken() {
  const account = JSON.parse(readFileSync(SERVICE_ACCOUNT_FILE, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: account.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), createPrivateKey(account.private_key)).toString("base64url");

  const response = await fetch(account.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`the service account's token request answered ${response.status}`);
  }

  return (await response.json()).access_token;
}

const token = await accessToken();

async function call(method, url, { json, body, contentType } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  let payload = body;

  if (json !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(json);
  } else if (contentType) {
    headers["content-type"] = contentType;
  }

  const response = await fetch(url, { method, headers, body: payload });

  if (!response.ok) {
    const text = await response.text();
    let message = text;

    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {}

    throw new Error(`${method} ${new URL(url).pathname} answered ${response.status}: ${message}`);
  }

  return response.status === 204 ? null : response.json();
}

function result(value) {
  console.log(JSON.stringify(value));
}

const edit = await call("POST", `${api}/edits`, { json: {} });
const editUrl = `${api}/edits/${edit.id}`;
let committed = false;

try {
  const { bundles = [] } = await call("GET", `${editUrl}/bundles`);

  if (bundles.some((bundle) => String(bundle.versionCode) === VERSION_CODE)) {
    result({ result: "held" });
  } else {
    const bundle = await call("POST", `${upload}/edits/${edit.id}/bundles?uploadType=media`, {
      body: readFileSync(AAB),
      contentType: "application/octet-stream",
    });

    if (String(bundle.versionCode) !== VERSION_CODE) {
      throw new Error(`Play read the bundle as version code ${bundle.versionCode}, not ${VERSION_CODE}`);
    }

    const track = await call("GET", `${editUrl}/tracks/${TRACK}`);
    const kept = (track.releases ?? []).filter((release) => release.status !== "draft");
    const replaced = (track.releases ?? []).filter((release) => release.status === "draft").map((release) => release.name);

    await call("PUT", `${editUrl}/tracks/${TRACK}`, {
      json: { track: TRACK, releases: [...kept, { name: RELEASE_NAME, versionCodes: [VERSION_CODE], status: "draft" }] },
    });

    if (DRY_RUN === "true") {
      await call("POST", `${editUrl}:validate`);
      result({ result: "dry-run", sha256: bundle.sha256, replaced });
    } else {
      await call("POST", `${editUrl}:commit?changesNotSentForReview=${CHANGES_NOT_SENT_FOR_REVIEW === "true"}`);
      committed = true;
      result({ result: "uploaded", sha256: bundle.sha256, replaced });
    }
  }
} finally {
  if (!committed) {
    await call("DELETE", editUrl);
  }
}
