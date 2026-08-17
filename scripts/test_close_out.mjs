#!/usr/bin/env node
// Regression test for the robustness fixes live calls forced: the end-of-call
// close-out, promise supersession, the closed-call lock, and disposition
// supersession.
//
// A real call hit maxDurationSeconds at 306s with a promise and a payment link
// already logged and no mark_disposition anywhere, which quietly broke the one
// guarantee the design makes out loud - every call ends with a logged outcome.
// A later call did the opposite: it marked WRONG_PERSON at 71s, never called
// endCall, and then verified the same customer, disclosed his account and logged
// a promise on the same call ID, so one call asserted three different things
// about itself. The server now closes a cut call out itself and refuses account
// reads, promises and links on a call that already has a terminal disposition.
// None of that is visible in a demo - it only shows up when a call goes wrong -
// so it needs a test, and the test also pins the auth lock, because a change to
// the webhook entry point is exactly the change that could loosen it.
//
//   npm start                              in one terminal
//   node scripts/test_close_out.mjs        in another
//
// It writes synthetic test-* call IDs to logs/audit.jsonl. Strip them before
// shipping the log:
//   node -e "const f=require('fs'),p='logs/audit.jsonl';f.writeFileSync(p,f.readFileSync(p,'utf8').split('\n').filter(l=>l&&!JSON.parse(l).call_id.startsWith('test-')).join('\n')+'\n')"
import { readFileSync } from "node:fs";
import path from "node:path";

const ENV = path.join(import.meta.dirname, "..", ".env");
const token = readFileSync(ENV, "utf8").match(/^WEBHOOK_TOKEN=(.+)$/m)?.[1].trim();
const BASE = `http://localhost:${process.env.PORT || 3000}`;
const URL = `${BASE}/webhook`;
let fails = 0;

async function post(body) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return res.json();
}

let seq = 0;
// Unique per run. The server caches results by toolCallId to make Vapi retries
// idempotent, and it keeps sessions for two hours, so a fixed set of IDs would
// replay the first run's cached answers against a warm server and pass without
// testing anything.
const RUN = Date.now().toString(36);
const id = (label) => `test-${label}-${RUN}`;
const tool = (callId, name, args) =>
  post({ message: { type: "tool-calls", call: { id: callId }, toolCallList: [{ id: `tc-${RUN}-${++seq}`, name, arguments: args }] } });
const parse = (r) => JSON.parse(r.results[0].result);

const endReport = (callId, endedReason) =>
  post({ message: { type: "end-of-call-report", call: { id: callId }, endedReason } });
const statusEnded = (callId, endedReason) =>
  post({ message: { type: "status-update", status: "ended", call: { id: callId }, endedReason } });

function check(ok, label, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const summary = async () => (await fetch(`${BASE}/debug/summary`)).json();
const dispositionFor = async (callId) =>
  (await summary()).dispositions.filter((d) => d.callId === callId).pop() || null;

// 1. Cut off mid-flow with a promise on the books and no disposition.
const A = id("cut-with-ptp");
check(parse(await tool(A, "verify_customer", { verification_type: "DOB_FULL", verification_value: "15-06-1995" })).status === "success", "A verify succeeds");
check(parse(await tool(A, "get_account_details", {})).status === "success", "A account details");
check(parse(await tool(A, "log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-29", payment_type: "FULL" })).status === "success", "A promise logged");
await endReport(A, "exceeded-max-duration");
const a = await dispositionFor(A);
check(a?.status === "TECHNICAL_FAILURE", "A auto-closed as TECHNICAL_FAILURE", a?.status);
check(a?.autoClosed === true, "A flagged autoClosed");
check(a?.authenticated === true, "A carries the auth state it really had");
check(/exceeded-max-duration/.test(a?.notes || ""), "A notes name the endedReason");
check(/PTP-.*8499 on 2026-08-29/.test(a?.notes || ""), "A notes flag the unconfirmed promise", a?.notes);

// 2. Call that never made a tool call at all.
const B = id("cut-empty");
await endReport(B, "customer-ended-call");
const b = await dispositionFor(B);
check(b?.status === "TECHNICAL_FAILURE", "B silent call still gets an outcome", b?.status);
check(b?.authenticated === false, "B is not authenticated");
check(/No promise was logged/.test(b?.notes || ""), "B notes say no promise existed");

// 3. Properly closed call must not be overwritten.
const C = id("clean-close");
await tool(C, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" });
await tool(C, "log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-29", payment_type: "FULL" });
check(parse(await tool(C, "mark_disposition", { status: "PTP", ptp_date: "2026-08-29", ptp_amount: 8499 })).status === "success", "C disposition logged");
await statusEnded(C, "assistant-ended-call");
await endReport(C, "assistant-ended-call");
const cAll = (await summary()).dispositions.filter((d) => d.callId === C);
check(cAll.length === 1, "C keeps exactly one disposition", `count=${cAll.length}`);
check(cAll[0].status === "PTP", "C stays PTP, not overwritten", cAll[0].status);

// 4. Both end signals arriving for one cut call must close it once.
const D = id("double-signal");
await tool(D, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" });
await statusEnded(D, "silence-timed-out");
await endReport(D, "silence-timed-out");
const dAll = (await summary()).dispositions.filter((d) => d.callId === D);
check(dAll.length === 1, "D closed exactly once across both signals", `count=${dAll.length}`);

// 5. A second promise on one call supersedes the first.
const E = id("supersede");
await tool(E, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" });
const first = parse(await tool(E, "log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-29", payment_type: "FULL" }));
const second = parse(await tool(E, "log_promise_to_pay", { amount: 4250, ptp_date: "2026-08-20", payment_type: "PARTIAL" }));
check(second.status === "success", "E revised promise accepted");
check(Array.isArray(second.supersedes) && second.supersedes[0] === first.ptp_id, "E revision supersedes the original", JSON.stringify(second.supersedes));
const live = (await summary()).promises.filter((p) => p.callId === E && !p.supersededBy);
check(live.length === 1 && live[0].amount === 4250, "E leaves one live promise", JSON.stringify(live.map((p) => p.amount)));

// 6. A dispositioned call is closed for business. The live call that forced this
// marked WRONG_PERSON at 71s, never called endCall, then verified the same man,
// disclosed his account and logged a promise on the same call ID.
const G = id("call-closed");
await tool(G, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" });
check(parse(await tool(G, "get_account_details", {})).status === "success", "G account read allowed while open");
await tool(G, "mark_disposition", { status: "WRONG_PERSON" });
const gAccount = parse(await tool(G, "get_account_details", {}));
check(gAccount.reason === "CALL_CLOSED", "G account read refused after disposition", gAccount.reason);
check(gAccount.status === "access_denied", "G refusal is access_denied", gAccount.status);
const gPromise = parse(await tool(G, "log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-29", payment_type: "FULL" }));
check(gPromise.reason === "CALL_CLOSED", "G promise refused after disposition", gPromise.reason);
const gLink = parse(await tool(G, "send_payment_link", { channel: "SMS" }));
check(gLink.reason === "CALL_CLOSED", "G payment link refused after disposition", gLink.reason);
check((await summary()).promises.filter((p) => p.callId === G).length === 0, "G has no promise on a wrong-person call");
// Deliberately still open, so a mis-fired disposition cannot trap a call that
// needs a human or a second verification attempt.
check(parse(await tool(G, "escalate_to_agent", { reason: "POLICY_EXCEPTION", notes: "reopened" })).status === "success", "G escalation stays available");
check(parse(await tool(G, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" })).status === "success", "G verification stays available");

// 7. A differing second disposition supersedes rather than reporting a false success.
const H = id("disposition-supersede");
await tool(H, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" });
const hFirst = parse(await tool(H, "mark_disposition", { status: "WRONG_PERSON" }));
const hSecond = parse(await tool(H, "mark_disposition", { status: "CALLBACK_REQUESTED", notes: "asked for a call back tomorrow" }));
check(hSecond.disposition_id !== hFirst.disposition_id, "H second decision writes its own record");
check(hSecond.supersedes === hFirst.disposition_id, "H second record links back to the first", hSecond.supersedes);
const hAll = (await summary()).dispositions.filter((d) => d.callId === H);
check(hAll.length === 2, "H keeps both decisions visible", `count=${hAll.length}`);
check(hAll[0].supersededBy === hSecond.disposition_id, "H first record is marked superseded", hAll[0].supersededBy);
check(/needs human reconciliation/i.test(hAll[1].notes || ""), "H flags the contradiction for a human", hAll[1].notes);
const hRepeat = parse(await tool(H, "mark_disposition", { status: "CALLBACK_REQUESTED", notes: "asked for a call back tomorrow" }));
check(hRepeat.duplicate === true, "H identical repeat is an idempotent no-op");
check((await summary()).dispositions.filter((d) => d.callId === H).length === 2, "H repeat writes no third record");

// 8. Close-out annotates a promise left under a non-promissory disposition.
const I = id("contradicted");
await tool(I, "verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" });
await tool(I, "log_promise_to_pay", { amount: 4250, ptp_date: "2026-08-20", payment_type: "PARTIAL" });
await tool(I, "mark_disposition", { status: "HOSTILE_ENDED" });
await endReport(I, "assistant-ended-call");
const i = await dispositionFor(I);
check(i?.status === "HOSTILE_ENDED", "I keeps its own disposition", i?.status);
check(i?.contradicted === true, "I flagged contradicted");
check(/Contradiction at call end/.test(i?.notes || ""), "I notes name the live promise", i?.notes);
await statusEnded(I, "assistant-ended-call");
const iNotes = (await dispositionFor(I))?.notes || "";
check(iNotes.match(/Contradiction at call end/g)?.length === 1, "I annotation is written once across both end signals");

// 9. The auth lock still holds - the fixes must not have loosened it.
const F = id("authlock");
check(parse(await tool(F, "get_account_details", {})).reason === "AUTH_REQUIRED", "F pre-auth account read still denied");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
