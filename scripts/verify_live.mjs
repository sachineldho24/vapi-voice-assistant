#!/usr/bin/env node
//
// Reads the live Vapi configuration back over the API and compares it against the
// committed files, because a provisioning script reporting success only proves the
// request was accepted - not that the six tools carry the stamped host, that the
// credential is attached at tool scope, or that nobody has since edited the
// assistant in the dashboard.
//
//   node scripts/verify_live.mjs
//
// Needs VAPI_API_KEY and VAPI_WEBHOOK_CREDENTIAL_ID (read from .env). Prints PASS
// or FAIL per check and exits 1 if anything failed, so it can gate a recording.
// Credential and key values are never printed - only whether they match.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
createRequire(import.meta.url)(path.join(ROOT, "load_env.cjs")).loadEnv();

const KEY = process.env.VAPI_API_KEY;
const CRED = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;

if (!KEY) {
  console.error("VAPI_API_KEY is not set. Put it in .env or the shell.");
  process.exit(1);
}

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
const tools = readJson("tool_definitions.json");
const config = readJson("assistant_config.sample.json");
const systemPrompt = fs.readFileSync(path.join(ROOT, "system_prompt.txt"), "utf8");

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

async function get(route) {
  const response = await fetch(`https://api.vapi.ai${route}`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${route} -> ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Vapi returns the same objects with keys in a different order, and adds defaults
// of its own to provider blocks, so compare canonically and by subset rather than
// by JSON text - otherwise every run reports drift that is not there.
const canon = (value) =>
  Array.isArray(value)
    ? value.map(canon)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]))
      : value;

const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// Every key the committed config states must match; live extras are Vapi defaults.
const covers = (live, committed) =>
  Object.entries(committed || {}).every(([key, value]) => same(live?.[key], value));

async function main() {
  const expectedUrl = tools[0]?.server?.url;
  console.log(`expected webhook  ${expectedUrl}`);
  console.log(`credential in .env ${CRED ? "present" : "MISSING"}\n`);

  // 1. The six tools.
  const live = await get("/tool");
  const byName = new Map();
  for (const tool of live) if (tool.function?.name) byName.set(tool.function.name, tool);

  console.log("TOOLS");
  const liveIds = {};
  for (const committed of tools) {
    const name = committed.function.name;
    const found = byName.get(name);
    if (!found) {
      check(false, name.padEnd(21), "not on the account - run scripts/vapi_provision.mjs");
      continue;
    }
    liveIds[name] = found.id;
    const urlOk = found.server?.url === expectedUrl;
    const credOk = Boolean(CRED) && found.server?.credentialId === CRED;
    const schemaOk = same(found.function.parameters, committed.function.parameters);
    check(
      urlOk && credOk && schemaOk,
      name.padEnd(21),
      [
        urlOk ? "url ok" : `url ${found.server?.url || "(none)"}`,
        credOk ? "credential attached" : "CREDENTIAL MISSING OR WRONG",
        schemaOk ? "schema matches" : "SCHEMA DRIFTED from tool_definitions.json"
      ].join(" | ")
    );
  }

  // 2. The assistant.
  const assistants = await get("/assistant");
  const assistant = assistants.find((a) => a.name === config.name);
  console.log(`\nASSISTANT ${config.name}`);
  if (!assistant) {
    check(false, "exists", "no assistant with that name - run scripts/vapi_provision.mjs");
  } else {
    console.log(`  id ${assistant.id}\n`);
    const nativeTypes = (assistant.model?.tools || []).map((t) => t.type).sort();
    const expectedNative = (config.model?.tools || []).map((t) => t.type).sort();
    const livePrompt = assistant.model?.messages?.[0]?.content || "";
    const orderedIds = tools.map((t) => liveIds[t.function.name]);

    check(assistant.model?.model === config.model.model, "model", assistant.model?.model || "(none)");
    check(assistant.model?.temperature === config.model.temperature, "temperature", String(assistant.model?.temperature));
    check(same(assistant.transcriber, config.transcriber), "transcriber", `${assistant.transcriber?.model} ${assistant.transcriber?.language}`);
    check(covers(assistant.voice, config.voice), "voice", `${assistant.voice?.provider}/${assistant.voice?.voiceId}`);
    check(same(nativeTypes, expectedNative), "native tools", nativeTypes.join(", ") || "(none)");
    check(same(assistant.model?.toolIds, orderedIds), "toolIds", `${(assistant.model?.toolIds || []).length} in committed order`);
    check(assistant.server?.url === expectedUrl, "server.url", assistant.server?.url || "(none)");
    check(Boolean(CRED) && assistant.server?.credentialId === CRED, "server credential", "attached at assistant scope too");
    check(same(assistant.serverMessages?.slice().sort(), config.serverMessages.slice().sort()), "serverMessages", (assistant.serverMessages || []).join(", "));
    check(assistant.silenceTimeoutSeconds === config.silenceTimeoutSeconds, "silenceTimeoutSeconds", String(assistant.silenceTimeoutSeconds));
    check(assistant.maxDurationSeconds === config.maxDurationSeconds, "maxDurationSeconds", String(assistant.maxDurationSeconds));
    check(Boolean(assistant.analysisPlan?.structuredDataPlan), "analysisPlan structured data", "carries the disposition");
    check(livePrompt.trim() === systemPrompt.trim(), "prompt matches system_prompt.txt", `${livePrompt.length} chars live`);

    // The submission's thesis: an injection cannot extract a figure the prompt
    // never carried. Assert it against what is actually live, not the file.
    const leaks = ["8,499", "8499", "2026-08-03", "personal loan", "13 days"].filter((needle) =>
      livePrompt.toLowerCase().includes(needle.toLowerCase())
    );
    check(leaks.length === 0, "no figures in the live prompt", leaks.length ? `LEAKED: ${leaks.join(", ")}` : "amount, due date, product and dpd all absent");
    // The greeting may name the person it is calling; what it must not do is say
    // why before anyone has been verified, which is what a third party would hear.
    const greeting = assistant.firstMessage || "";
    const greetingLeaks = ["overdue", "loan", "emi", "balance", "payment", "8,499", "8499", "due"].filter((needle) =>
      greeting.toLowerCase().includes(needle)
    );
    check(
      same(greeting, config.firstMessage) && greetingLeaks.length === 0,
      "first message discloses no purpose",
      greetingLeaks.length ? `LEAKED: ${greetingLeaks.join(", ")}` : `"${greeting.slice(0, 64)}"`
    );
  }

  // 3. Telephony capability, reported rather than asserted.
  const numbers = await get("/phone-number");
  console.log("\nTELEPHONY");
  console.log(
    numbers.length
      ? `  ${numbers.length} number(s): ${numbers.map((n) => `${n.number} (${n.provider})`).join(", ")} - outbound phone calls possible`
      : "  no phone number on the account - browser calls only (scripts/place_call.mjs explains)"
  );

  console.log(
    failures === 0
      ? "\nLive configuration matches the committed files."
      : `\n${failures} check(s) failed. Fix before calling: node scripts/vapi_provision.mjs`
  );
  if (failures > 0) process.exitCode = 1;
}

// process.exit while a fetch socket is still open trips a libuv assertion on
// Windows, so set the code and return instead.
await main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
