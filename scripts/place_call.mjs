#!/usr/bin/env node
// Places one outbound phone call with the provisioned assistant, and - run with
// no arguments - reports whether the account can place one at all.
//
// A browser call proves the tool contract but not telephony: barge-in over a real
// codec, and endCall actually clearing the line, only show up over PSTN. That
// needs a phone number on the Vapi account, which is the one part of this repo a
// script cannot create for you.
//
//   node scripts/place_call.mjs                     list numbers and the assistant
//   node scripts/place_call.mjs --to +919876543210  dial that number
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("../load_env.cjs").loadEnv();

const KEY = process.env.VAPI_API_KEY;
const ASSISTANT = process.env.VAPI_ASSISTANT_ID || "4d255930-3056-40b3-aa8e-bd31f4f608d3";
const to = process.argv.includes("--to") ? process.argv[process.argv.indexOf("--to") + 1] : null;

if (!KEY) {
  console.error("VAPI_API_KEY is not set. Put it in .env or the shell.");
  process.exit(1);
}

async function api(method, route, body) {
  const response = await fetch(`https://api.vapi.ai${route}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

// Node keeps the fetch connection pool warm, and process.exit while a socket is
// still open trips a libuv assertion on Windows, so every path returns instead.
async function main() {
  const numbers = await api("GET", "/phone-number");
  if (numbers.length === 0) {
    console.log("No phone number on this account, so no outbound call can be placed yet.");
    console.log("Buy or import one at https://dashboard.vapi.ai/phone-numbers first:");
    console.log("  - a free Vapi number is US-only, which is enough to prove telephony and endCall");
    console.log("  - an Indian number must be imported from Twilio, and Indian regulations");
    console.log("    require the destination to be a verified caller ID on a trial account");
    if (to) process.exitCode = 1;
    return;
  }

  console.log("phone numbers:");
  for (const number of numbers) console.log(`  ${number.number}  ${number.provider}  ${number.id}`);

  if (!to) {
    console.log(`\nassistant ${ASSISTANT}`);
    console.log("dial with: node scripts/place_call.mjs --to +91XXXXXXXXXX");
    return;
  }

  if (!/^\+[1-9]\d{7,14}$/.test(to)) {
    console.error(`\n"${to}" is not E.164. Pass a leading + and country code, e.g. +919876543210.`);
    process.exitCode = 1;
    return;
  }

  const call = await api("POST", "/call", {
    assistantId: ASSISTANT,
    phoneNumberId: numbers[0].id,
    customer: { number: to },
  });

  console.log(`\nplaced call ${call.id} from ${numbers[0].number} -> ${to} (${call.status})`);
  console.log(`watch it with: node scripts/tail_audit.mjs ${String(call.id).slice(0, 8)}`);
}

await main();
