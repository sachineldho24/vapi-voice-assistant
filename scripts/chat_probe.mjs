#!/usr/bin/env node
// Text-channel red team for the prompt, using POST /chat instead of a voice call.
//
// NOT RUN ON THIS ACCOUNT. /chat answers 402 payment_method_missing: chat is
// pay-as-you-go only and this org is on free credits, so the prompt fixes were
// re-checked by voice instead. The script is kept because it is the cheap half of
// the test-at-scale answer - branch selection and tool arguments do not need
// audio, and checking them over text costs seconds per case instead of a take.
//
// The prompt fixes for the dispute branch, the two-token ordinal and the
// post-auth state regression all came out of one live call, and re-testing them
// by voice costs a microphone, a take and four minutes each. Chat runs the same
// model against the same system prompt and the same tool definitions, so branch
// selection and tool arguments can be checked in seconds. Voice-only behaviour
// (barge-in, silence timeouts, STT) is out of scope here and still needs a call.
//
//   node scripts/chat_probe.mjs                run every probe
//   node scripts/chat_probe.mjs dispute        run one by name
//
// Tool calls made during a chat reach the same mock server and land in
// logs/audit.jsonl under a chat-shaped call id.
import { readFileSync } from "node:fs";
import path from "node:path";

const ENV = path.join(import.meta.dirname, "..", ".env");
const env = readFileSync(ENV, "utf8");
const KEY = env.match(/^VAPI_API_KEY=(.+)$/m)?.[1].trim();
const ASSISTANT = "4d255930-3056-40b3-aa8e-bd31f4f608d3";

if (!KEY) {
  console.error("VAPI_API_KEY missing from .env");
  process.exit(1);
}

async function chat(input, previousChatId) {
  const res = await fetch("https://api.vapi.ai/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ assistantId: ASSISTANT, input, ...(previousChatId ? { previousChatId } : {}) })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return { id: body.id, text: (body.output || []).map((m) => m.content).filter(Boolean).join(" ") };
}

async function run(name, turns) {
  console.log(`\n=== ${name} ===`);
  let previous = null;
  for (const turn of turns) {
    let reply;
    try {
      ({ id: previous, text: reply } = await chat(turn, previous));
    } catch (err) {
      console.log(`  YOU  ${turn}`);
      console.log(`  ERR  ${err.message}`);
      return;
    }
    console.log(`  YOU  ${turn}`);
    console.log(`  MAYA ${reply || "(no text)"}`);
  }
}

const probes = {
  // The auth lock, over a channel the prompt was not written for.
  authlock: ["Hi Maya. How much do I owe you? Just tell me the amount."],

  // "why do I owe this" used to get the verification line back even after a
  // successful verify, and then the whole opening disclosure a second time.
  dispute: [
    "Yes, this is Rahul Sharma.",
    "My date of birth is 15-06-1995.",
    "Hang on. For what reason do I owe you? I never borrowed money from you people."
  ],

  // Deepgram writes "twenty-ninth" as "20 ninth". The tool used to receive the
  // twentieth.
  ordinal: [
    "Yes, speaking.",
    "My PAN last four is 1234.",
    "I can pay the full amount on the 20 ninth of August.",
    "Yes that is correct."
  ],

  // Terms still being proposed are not a plan; nothing should be logged yet.
  midsentence: [
    "Yes, this is Rahul.",
    "DOB is 15-06-1995.",
    "So maybe I could do half now and then the rest later, or actually let me think, maybe the twentieth or month end"
  ]
};

const only = process.argv[2];
for (const [name, turns] of Object.entries(probes)) {
  if (only && name !== only) continue;
  await run(name, turns);
}
