// Pinned before requiring server.js, which loads .env. The loader never
// overwrites an existing value, so the suite stays deterministic whatever a
// local .env holds: a fixed today, and the endpoint open by default so most
// webhook checks exercise the tool contract rather than the bearer gate. The
// gate itself is switched on for three requests at the end of runWebhook, and
// test_webhook.ps1 / test_webhook.sh cover it against a running server.
process.env.DEMO_TODAY = "2026-08-15";
process.env.WEBHOOK_TOKEN = "";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  handleTool,
  getSession,
  validIsoDate,
  normalizeDob,
  parseArguments,
  pruneSessions,
  sessions
} = require("./server");

function run() {
  assert.equal(normalizeDob("15-06-1995"), "1995-06-15");
  assert.equal(validIsoDate("2026-08-18"), true);
  assert.equal(validIsoDate("2026-99-99"), false);

  const locked = getSession("unit-locked");
  assert.equal(handleTool("get_account_details", {}, locked, "unit-locked").reason, "AUTH_REQUIRED");
  assert.equal(handleTool("verify_customer", { verification_type: "DOB", verification_value: "01-01-1991" }, locked, "unit-locked").status, "failed");
  assert.equal(handleTool("verify_customer", { verification_type: "PAN_LAST4", verification_value: "ZZZZ" }, locked, "unit-locked").status, "failed");
  assert.equal(handleTool("verify_customer", { verification_type: "DOB_FULL", verification_value: "15-06-1995" }, locked, "unit-locked").status, "locked");

  const verified = getSession("unit-verified");
  assert.equal(handleTool("verify_customer", { verification_type: "DOB_FULL", verification_value: "15-06-1995" }, verified, "unit-verified").status, "success");
  assert.equal(handleTool("get_account_details", {}, verified, "unit-verified").overdue_amount, 8499);
  assert.equal(handleTool("log_promise_to_pay", { amount: 8499, ptp_date: "2026-99-99", payment_type: "FULL" }, verified, "unit-verified").reason, "INVALID_DATE_FORMAT");

  const ptp = handleTool("log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-18", payment_type: "FULL" }, verified, "unit-verified");
  assert.equal(ptp.status, "success");
  assert.match(ptp.ptp_id, /^PTP-/);

  const disposition = handleTool("mark_disposition", { status: "PTP", ptp_date: "2026-08-18", ptp_amount: 8499 }, verified, "unit-verified");
  const duplicate = handleTool("mark_disposition", { status: "PTP" }, verified, "unit-verified");
  assert.equal(disposition.status, "success");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.disposition_id, disposition.disposition_id);

  // Every gated tool must refuse a locked session, and escalate_to_agent must
  // still accept TECHNICAL_FAILURE so a broken tool can never trap the call.
  const gated = getSession("unit-gates");
  assert.equal(handleTool("send_payment_link", { channel: "SMS" }, gated, "unit-gates").reason, "AUTH_REQUIRED");
  assert.equal(handleTool("log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-18", payment_type: "FULL" }, gated, "unit-gates").reason, "AUTH_REQUIRED");
  assert.equal(handleTool("escalate_to_agent", { reason: "DISPUTE", notes: "x" }, gated, "unit-gates").reason, "AUTH_REQUIRED");
  const techEscalation = handleTool("escalate_to_agent", { reason: "TECHNICAL_FAILURE", notes: "tool timeout" }, gated, "unit-gates");
  assert.equal(techEscalation.status, "success");
  assert.match(techEscalation.ticket_id, /^ESC-/);
  assert.equal(techEscalation.queue, "COLLECTIONS_SPECIALIST");

  // A promise for a date that has already passed must be rejected, not logged.
  // On its own session, because `unit-verified` has since dispositioned and a
  // closed call now refuses promises before it ever looks at the date.
  const pastDate = getSession("unit-past-date");
  handleTool("verify_customer", { verification_type: "PAN_LAST4", verification_value: "1234" }, pastDate, "unit-past-date");
  assert.equal(
    handleTool("log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-01", payment_type: "FULL" }, pastDate, "unit-past-date").reason,
    "PTP_DATE_IN_PAST"
  );

  // A terminal disposition closes the call for business purposes. One live call
  // marked WRONG_PERSON, never hung up, then verified the same customer and
  // logged a promise on the same call ID; the lock is what stops the second half.
  assert.equal(handleTool("get_account_details", {}, verified, "unit-verified").reason, "CALL_CLOSED");
  assert.equal(handleTool("get_account_details", {}, verified, "unit-verified").status, "access_denied");
  assert.equal(
    handleTool("log_promise_to_pay", { amount: 8499, ptp_date: "2026-08-18", payment_type: "FULL" }, verified, "unit-verified").reason,
    "CALL_CLOSED"
  );
  assert.equal(handleTool("send_payment_link", { channel: "SMS" }, verified, "unit-verified").reason, "CALL_CLOSED");
  // Left open on purpose, so a mis-fired disposition cannot trap a call that
  // still needs a human.
  assert.equal(handleTool("escalate_to_agent", { reason: "DISPUTE", notes: "reopened" }, verified, "unit-verified").status, "success");

  // A differing second disposition supersedes rather than reporting success
  // against the stale record, which is how one call reported a clean close while
  // WRONG_PERSON stayed on the books.
  const revised = handleTool("mark_disposition", { status: "CALLBACK_REQUESTED" }, verified, "unit-verified");
  assert.equal(revised.status, "success");
  assert.notEqual(revised.disposition_id, disposition.disposition_id);
  assert.equal(revised.supersedes, disposition.disposition_id);
  assert.match(revised.disposition_id, /^DSP-/);

  // Vapi's own webhook example reads `toolCall.parameters || toolCall.arguments`,
  // so all four documented argument shapes must parse identically.
  const shapes = [
    { arguments: { channel: "SMS" } },
    { parameters: { channel: "SMS" } },
    { function: { arguments: { channel: "SMS" } } },
    { function: { parameters: { channel: "SMS" } } },
    { arguments: '{"channel":"SMS"}' }
  ];
  for (const shape of shapes) {
    assert.deepEqual(parseArguments(shape), { channel: "SMS" }, `failed to parse ${JSON.stringify(shape)}`);
  }
  assert.equal(parseArguments({ arguments: "{not json" }), null);

  // Sessions expire on read; the sweep must also drop them without a read.
  const stale = getSession("unit-stale");
  stale.lastSeenAt = Date.now() - (3 * 60 * 60 * 1000);
  assert.ok(pruneSessions() >= 1);
  assert.equal(sessions.has("unit-stale"), false);

  const cases = JSON.parse(
    fs.readFileSync(path.join(__dirname, "test_cases.json"), "utf8")
  );
  const requiredFields = [
    "id",
    "category",
    "priority",
    "precondition",
    "turns",
    "expected_behavior",
    "pass_criteria",
    "must_call",
    "must_not_call",
    "forbidden_phrases",
    "disposition_expected"
  ];
  assert.equal(cases.length, 28);
  assert.equal(new Set(cases.map((test) => test.id)).size, cases.length);
  for (const test of cases) {
    for (const field of requiredFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(test, field), `${test.id} missing ${field}`);
    }
    for (const field of ["turns", "pass_criteria", "must_call", "must_not_call", "forbidden_phrases"]) {
      assert.ok(Array.isArray(test[field]), `${test.id}.${field} must be an array`);
    }
  }
  // Every case with spoken turns must forbid something: at minimum a tool name,
  // an ISO date read aloud, or the verification factor repeated back. A case that
  // only asserts a disposition would pass while the amount leaked in the same turn.
  for (const test of cases.filter((item) => item.turns.length > 0)) {
    assert.ok(
      test.forbidden_phrases.length > 0,
      `${test.id} has spoken turns but no forbidden_phrases`
    );
  }

  console.log("All server and test-matrix validation passed.");
}

// Webhook-layer checks: the response envelope Vapi requires, and idempotency on
// toolCallId so a retried tool call cannot log a second promise to pay.
async function runWebhook() {
  const auditFile = path.join(__dirname, "logs", "audit.jsonl");
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const post = async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const envelope = (toolCallId, name, args) => ({
    message: {
      type: "tool-calls",
      call: { id: "webhook-idempotency" },
      toolCallList: [{ id: toolCallId, name, arguments: args }]
    }
  });

  const denied = await post(envelope("toolu_deny", "get_account_details", {}));
  assert.equal(denied.results.length, 1);
  assert.equal(denied.results[0].toolCallId, "toolu_deny");
  assert.equal(JSON.parse(denied.results[0].result).reason, "AUTH_REQUIRED");

  await post(envelope("toolu_verify", "verify_customer", {
    verification_type: "DOB_FULL",
    verification_value: "15-06-1995"
  }));

  const ptpArgs = { amount: 8499, ptp_date: "2026-08-18", payment_type: "FULL" };
  const first = await post(envelope("toolu_ptp", "log_promise_to_pay", ptpArgs));
  const replay = await post(envelope("toolu_ptp", "log_promise_to_pay", ptpArgs));
  assert.equal(first.results[0].result, replay.results[0].result);

  const summary = await (await fetch(`http://127.0.0.1:${server.address().port}/debug/summary`)).json();
  const logged = summary.promises.filter((row) => row.callId === "webhook-idempotency");
  assert.equal(logged.length, 1, "a replayed toolCallId must not create a second PTP");

  // The bearer gate, and the diagnosis it records. A tool whose Vapi credential is
  // missing and one whose token is stale both present identically on a live call -
  // Maya reports a system issue - so the audit line has to tell them apart.
  process.env.WEBHOOK_TOKEN = "test-bearer-token";
  const rejectBody = JSON.stringify(envelope("toolu_gate", "get_account_details", {}));
  const rejects = [];
  for (const headers of [
    { "content-type": "application/json" },
    { "content-type": "application/json", authorization: "Bearer not-the-token" },
    { "content-type": "application/json", authorization: "Bearer test-bearer-token" }
  ]) {
    rejects.push((await fetch(url, { method: "POST", headers, body: rejectBody })).status);
  }
  process.env.WEBHOOK_TOKEN = "";
  assert.deepEqual(rejects, [401, 401, 200], "no header and a wrong token are both 401; the right token passes");

  const auditLines = fs.readFileSync(auditFile, "utf8").trim().split("\n").slice(-3).map(JSON.parse);
  assert.equal(auditLines[0].reason, "NO_AUTH_HEADER");
  assert.equal(auditLines[1].reason, "BAD_BEARER_TOKEN");
  assert.equal(auditLines[0].tool, "-", "a rejected request never reaches a tool");

  await new Promise((resolve) => server.close(resolve));
  console.log("Webhook envelope, idempotency and bearer-gate validation passed.");
}

run();
runWebhook().catch((error) => {
  console.error(error);
  process.exit(1);
});
