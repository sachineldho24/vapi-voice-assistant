#!/usr/bin/env node
// Stamp the public webhook host into every file that references it, so the six
// tool schemas, the assistant config and the README can never drift apart.
//
//   node scripts/stamp_host.mjs maya-demo.onrender.com
//   node scripts/stamp_host.mjs abc123.ngrok-free.app --from maya-demo.onrender.com
//
// Pass a bare host, not a URL. Re-stamping needs --from with the previous host.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = "YOUR_PUBLIC_HOST";
const TARGETS = ["tool_definitions.json", "assistant_config.sample.json", "README.md"];

const args = process.argv.slice(2);
const host = args.find((value) => !value.startsWith("--"));
const fromIndex = args.indexOf("--from");
const from = fromIndex === -1 ? PLACEHOLDER : args[fromIndex + 1];

if (!host) {
  console.error("Usage: node scripts/stamp_host.mjs <host> [--from <previous-host>]");
  process.exit(1);
}
if (/^https?:\/\//.test(host) || host.includes("/")) {
  console.error(`Pass a bare host such as maya-demo.onrender.com, not "${host}".`);
  process.exit(1);
}

let total = 0;
for (const name of TARGETS) {
  const file = join(root, name);
  const before = readFileSync(file, "utf8");
  const after = before.split(from).join(host);
  const hits = before.split(from).length - 1;
  if (hits > 0) writeFileSync(file, after);
  total += hits;
  console.log(`${hits > 0 ? "✓" : "-"} ${name}: ${hits} replacement${hits === 1 ? "" : "s"}`);
}

if (total === 0) {
  console.error(`\nNothing replaced. "${from}" was not found — pass --from <current-host> to re-stamp.`);
  process.exit(1);
}
console.log(`\nStamped ${total} reference${total === 1 ? "" : "s"} to https://${host}/webhook`);
console.log("Next: node scripts/vapi_provision.mjs   (needs VAPI_API_KEY)");
