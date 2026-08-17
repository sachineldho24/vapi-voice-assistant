// Create (or verify) the Vapi Bearer Token credential that lets Vapi authenticate
// to this repo's webhook.
//
// The runbook used to make this a manual dashboard step, which is the easiest
// place in the whole flow to get wrong: the header has to be Authorization with
// the Bearer prefix on - the legacy X-Vapi-Secret shape is not what server.js
// checks - and the token has to match WEBHOOK_TOKEN exactly. Both come from .env
// here, so they cannot drift.
//
//   node scripts/vapi_credential.mjs            # create, print the ID
//   node scripts/vapi_credential.mjs --write    # ...and store it in .env
//
// The token value is never printed. Vapi encrypts it on receipt and it cannot be
// read back, so this script reports only the credential ID.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
createRequire(import.meta.url)("../load_env.cjs").loadEnv();

const API = "https://api.vapi.ai";
const NAME = "Kapture Maya webhook bearer";
const write = process.argv.includes("--write");

const key = process.env.VAPI_API_KEY;
const token = process.env.WEBHOOK_TOKEN;

if (!key) {
  console.error("VAPI_API_KEY is not set. Put it in .env or export it in the shell.");
  process.exit(1);
}
if (!token) {
  console.error(
    "WEBHOOK_TOKEN is not set. A credential whose token is empty would authenticate\n" +
      "nothing; set WEBHOOK_TOKEN in .env to the same value server.js runs with."
  );
  process.exit(1);
}

const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

function storeInEnv(id) {
  const file = join(root, ".env");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.log(`\nNo .env found; add this line yourself:\n  VAPI_WEBHOOK_CREDENTIAL_ID=${id}`);
    return;
  }
  const line = `VAPI_WEBHOOK_CREDENTIAL_ID=${id}`;
  const next = /^VAPI_WEBHOOK_CREDENTIAL_ID=.*$/m.test(text)
    ? text.replace(/^VAPI_WEBHOOK_CREDENTIAL_ID=.*$/m, line)
    : `${text.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(file, next);
  console.log("wrote VAPI_WEBHOOK_CREDENTIAL_ID into .env");
}

const existing = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;
if (existing) {
  const found = await call("GET", `/credential/${existing}`);
  if (found.ok) {
    console.log(`credential ${existing} already exists (${found.body?.name ?? "unnamed"})`);
    console.log("Nothing to do. Run: node scripts/vapi_provision.mjs --dry-run");
    process.exit(0);
  }
  console.error(
    `VAPI_WEBHOOK_CREDENTIAL_ID is set to ${existing} but Vapi returned ${found.status}.\n` +
      "Clear it from .env to create a fresh credential, or fix the ID."
  );
  process.exit(1);
}

const listed = await call("GET", "/credential");
if (!listed.ok) {
  console.error(`GET /credential failed with ${listed.status}:`);
  console.error(JSON.stringify(listed.body, null, 2));
  process.exit(1);
}

const reuse = Array.isArray(listed.body) ? listed.body.find((c) => c?.name === NAME) : undefined;
if (reuse) {
  // Vapi will not disclose the stored token, so this cannot assert the value
  // still matches WEBHOOK_TOKEN. Reuse the ID and say so plainly.
  console.log(`reusing existing credential "${NAME}" -> ${reuse.id}`);
  console.log("Its token cannot be read back; if you rotated WEBHOOK_TOKEN, delete it and re-run.");
  if (write) storeInEnv(reuse.id);
  process.exit(0);
}

const created = await call("POST", "/credential", {
  provider: "custom-credential",
  name: NAME,
  authenticationPlan: {
    type: "bearer",
    token,
    headerName: "Authorization",
    bearerPrefixEnabled: true,
  },
});

if (!created.ok) {
  console.error(`POST /credential failed with ${created.status}:`);
  console.error(JSON.stringify(created.body, null, 2));
  process.exit(1);
}

const id = created.body?.id;
if (!id) {
  console.error("Vapi accepted the request but returned no credential id:");
  console.error(JSON.stringify(created.body, null, 2));
  process.exit(1);
}

console.log(`created credential "${NAME}" -> ${id}`);
console.log("header Authorization, Bearer prefix enabled, token taken from WEBHOOK_TOKEN");
if (write) storeInEnv(id);
else console.log(`\nAdd to .env:\n  VAPI_WEBHOOK_CREDENTIAL_ID=${id}`);
