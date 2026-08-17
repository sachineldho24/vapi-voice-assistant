#!/usr/bin/env node
// Reads logs/audit.jsonl as a call transcript rather than as JSON.
//
// During a demo the question is always the same - did get_account_details fire
// before verify_customer succeeded, and did anything get rejected - and answering
// it by eye from raw JSONL is slow. This prints one aligned line per tool call and
// follows the file, so the pane can sit next to the browser during a call.
//
//   node scripts/tail_audit.mjs                 follow every call
//   node scripts/tail_audit.mjs 01a00a20        follow one call (id prefix)
//   node scripts/tail_audit.mjs 01a00a20 --once print what is already there
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(import.meta.dirname, "..", "logs", "audit.jsonl");
const args = process.argv.slice(2);
const once = args.includes("--once");
const filter = args.find((a) => !a.startsWith("--"));

const C = { dim: "\x1b[90m", ok: "\x1b[32m", bad: "\x1b[31m", warn: "\x1b[33m", acc: "\x1b[36m", off: "\x1b[0m" };

function render(line) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  const id = row.call_id || "-";
  if (filter && !id.startsWith(filter)) return;

  const clock = (row.timestamp || "").slice(11, 23) || "-".repeat(12);
  const denied = row.outcome !== "success";
  const colour = row.outcome === "rejected" ? C.bad : denied ? C.warn : C.ok;
  const detail = row.reason ? `${C.dim}${row.reason}${C.off}` : JSON.stringify(row.args ?? {});
  const call = filter ? "" : `${C.dim}${id.slice(0, 8)}${C.off}  `;
  console.log(`${C.dim}${clock}${C.off}  ${call}${C.acc}${(row.tool || "-").padEnd(20)}${C.off}${colour}${(row.outcome || "?").padEnd(10)}${C.off}${detail}`);
}

let offset = 0;
function drain() {
  let size;
  try {
    size = fs.statSync(FILE).size;
  } catch {
    return; // the log appears on the first tool call; wait for it
  }
  if (size < offset) offset = 0; // truncated or rotated
  if (size === offset) return;

  const fd = fs.openSync(FILE, "r");
  const buffer = Buffer.alloc(size - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  fs.closeSync(fd);
  offset = size;
  for (const line of buffer.toString("utf8").split("\n")) if (line.trim()) render(line);
}

drain();
if (!once) {
  console.log(`${C.dim}times are UTC, as written. following ${path.relative(process.cwd(), FILE)}${filter ? ` for call ${filter}*` : ""} - ctrl-c to stop${C.off}`);
  setInterval(drain, 400);
}
