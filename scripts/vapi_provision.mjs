#!/usr/bin/env node
// Provision the whole Maya assistant in Vapi from the files in this repo:
// the six Function tools from tool_definitions.json, then one assistant built
// from assistant_config.sample.json with system_prompt.txt inlined.
//
//   $env:VAPI_API_KEY="..."            # PowerShell
//   node scripts/vapi_provision.mjs --dry-run    # print payloads, mutate nothing
//   node scripts/vapi_provision.mjs              # create or update in place
//
// Idempotent: tools are matched on function.name and assistants on name, so a
// second run updates rather than duplicating. Optional VAPI_WEBHOOK_CREDENTIAL_ID
// attaches a Bearer credential created in Dashboard > Settings > Integrations > Server Configuration.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// VAPI_API_KEY and VAPI_WEBHOOK_CREDENTIAL_ID may live in the gitignored .env
// instead of the shell. Shell values still take precedence over the file.
createRequire(import.meta.url)("../load_env.cjs").loadEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.vapi.ai";
const DRY_RUN = process.argv.includes("--dry-run");
const KEY = process.env.VAPI_API_KEY;

const read = (name) => readFileSync(join(root, name), "utf8");
const readJson = (name) => JSON.parse(read(name));

if (!KEY && !DRY_RUN) {
  console.error("VAPI_API_KEY is not set. Get one at https://dashboard.vapi.ai/org/api-keys");
  console.error("Run with --dry-run to inspect the payloads without it.");
  process.exit(1);
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}\n${JSON.stringify(payload, null, 2)}`);
  }
  return payload;
}

const tools = readJson("tool_definitions.json");
const config = readJson("assistant_config.sample.json");
const systemPrompt = read("system_prompt.txt");

const unresolved = JSON.stringify({ tools, server: config.server }).includes("YOUR_PUBLIC_HOST");
if (unresolved) {
  console.error("tool_definitions.json still contains YOUR_PUBLIC_HOST.");
  console.error("Run: node scripts/stamp_host.mjs <your-public-host>");
  process.exit(1);
}

const toolName = (tool) => tool?.function?.name;
const CREDENTIAL_ID = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;

// Vapi gives the tool's own server configuration priority over the assistant's.
// Attach the credential at both scopes instead of relying on credential fallback;
// otherwise a protected webhook can reject tool calls that arrive without Bearer auth.
const withCredential = (server) =>
  CREDENTIAL_ID ? { ...server, credentialId: CREDENTIAL_ID } : { ...server };

async function upsertTools() {
  const existing = DRY_RUN ? [] : await api("GET", "/tool");
  const byName = new Map();
  for (const tool of Array.isArray(existing) ? existing : []) {
    const name = toolName(tool);
    if (name) byName.set(name, tool);
  }

  const ids = {};
  for (const tool of tools) {
    const name = toolName(tool);
    const payload = { type: tool.type, function: tool.function, server: withCredential(tool.server) };
    const current = byName.get(name);

    if (DRY_RUN) {
      console.log(`[dry-run] ${current ? "PATCH" : "POST"} /tool  ${name}  server=${JSON.stringify(payload.server)}`);
      ids[name] = `<${name}_tool_id>`;
      continue;
    }
    const saved = current
      ? await api("PATCH", `/tool/${current.id}`, payload)
      : await api("POST", "/tool", payload);
    ids[name] = saved.id;
    console.log(`${current ? "updated" : "created"} tool ${name} -> ${saved.id}`);
  }
  return ids;
}

// The sample config carries `notes` for human readers and placeholder tool ids.
// Both are stripped here: the prompt is inlined from system_prompt.txt and the
// ids come from the upsert above, so the file on disk stays readable while the
// payload Vapi receives is complete.
function buildAssistant(toolIds) {
  const { notes, ...rest } = config;
  const assistant = JSON.parse(JSON.stringify(rest));

  assistant.model.messages = [{ role: "system", content: systemPrompt }];
  assistant.model.toolIds = tools.map((tool) => toolIds[toolName(tool)]);

  const missing = tools.filter((tool) => !toolIds[toolName(tool)]).map(toolName);
  if (missing.length > 0) {
    throw new Error(`no tool id resolved for: ${missing.join(", ")}`);
  }

  const credentialId = CREDENTIAL_ID;
  if (credentialId) {
    assistant.server = { ...assistant.server, credentialId };
  } else {
    // A placeholder credential id is rejected by the API, so drop it rather than
    // ship something that only looks configured.
    delete assistant.server.credentialId;
    console.warn("VAPI_WEBHOOK_CREDENTIAL_ID not set: no Vapi Bearer credential will be attached to the assistant or six tools. If WEBHOOK_TOKEN is enabled, calls without the Authorization header will 401; leaving it disabled makes the public endpoint open.");
  }
  return assistant;
}

async function upsertAssistant(body) {
  if (DRY_RUN) {
    console.log(`\n[dry-run] POST /assistant  ${body.name}`);
    console.log(JSON.stringify(body, null, 2));
    return null;
  }

  const existing = await api("GET", "/assistant");
  const current = (Array.isArray(existing) ? existing : []).find((item) => item.name === body.name);
  const saved = current
    ? await api("PATCH", `/assistant/${current.id}`, body)
    : await api("POST", "/assistant", body);

  console.log(`${current ? "updated" : "created"} assistant ${saved.name} -> ${saved.id}`);
  return saved;
}

try {
  const toolIds = await upsertTools();
  const saved = await upsertAssistant(buildAssistant(toolIds));

  if (DRY_RUN) {
    console.log("\nDry run complete. Nothing was created or modified.");
    console.log("Set VAPI_API_KEY and re-run without --dry-run to provision.");
  } else {
    console.log("\nProvisioned:");
    for (const [name, id] of Object.entries(toolIds)) {
      console.log(`  tool  ${name.padEnd(22)} ${id}`);
    }
    console.log(`  assistant ${saved.id}`);
    console.log("\nNext: place a web call from the Vapi dashboard and watch the webhook log.");
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
