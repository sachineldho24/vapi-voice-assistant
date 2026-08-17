require("./load_env.cjs").loadEnv();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const MAX_AUTH_ATTEMPTS = 2;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 10 * 60 * 1000;
const LOG_DIR = path.join(__dirname, "logs");
const AUDIT_FILE = path.join(LOG_DIR, "audit.jsonl");
fs.mkdirSync(LOG_DIR, { recursive: true });

const account = {
  customerId: "CUST-1001",
  displayName: "Rahul Sharma",
  dob: "1995-06-15",
  panLast4: "1234",
  product: "Personal loan",
  overdueAmount: 8499,
  dueDate: "2026-08-03",
  partialPaymentAllowed: true,
  minPartialAmount: 1000
};

const dispositionStatuses = new Set([
  "PTP",
  "ALREADY_PAID",
  "DISPUTE_ESCALATED",
  "HARDSHIP_ESCALATED",
  "CALLBACK_REQUESTED",
  "DO_NOT_CALL",
  "WRONG_PERSON",
  "WRONG_NUMBER",
  "AUTH_FAILED",
  "AUTH_REFUSED",
  "NO_INPUT",
  "VOICEMAIL",
  "HOSTILE_ENDED",
  "TECHNICAL_FAILURE"
]);

const sessions = new Map();
const promises = [];
const dispositions = [];
const escalations = [];

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function getCallId(body) {
  return body?.message?.call?.id || body?.call?.id || null;
}

function getToolCalls(body) {
  const message = body?.message || {};
  const calls = message.toolCallList || message.toolCalls || [];
  return Array.isArray(calls) ? calls : [];
}

function getSession(callId) {
  const existing = sessions.get(callId);
  if (existing && Date.now() - existing.lastSeenAt <= SESSION_TTL_MS) {
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const session = {
    customerId: account.customerId,
    authenticated: false,
    authAttempts: 0,
    terminalDisposition: null,
    processedToolCalls: new Map(),
    // Vapi sends both status-update(ended) and end-of-call-report for the same
    // call, so the close-out has to be idempotent across two deliveries.
    endLogged: false,
    autoClosed: false,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };
  sessions.set(callId, session);
  return session;
}

function parseArguments(toolCall) {
  const raw =
    toolCall?.arguments ??
    toolCall?.parameters ??
    toolCall?.function?.arguments ??
    toolCall?.function?.parameters ??
    {};

  if (typeof raw !== "string") {
    return raw && typeof raw === "object" ? raw : {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeDob(value) {
  const input = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const indian = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(input);
  if (indian) return `${indian[3]}-${indian[2]}-${indian[1]}`;

  return input;
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function configuredToday() {
  const candidate = process.env.DEMO_TODAY || new Date().toISOString().slice(0, 10);
  return validIsoDate(candidate) ? candidate : new Date().toISOString().slice(0, 10);
}

function daysPastDue() {
  const due = new Date(`${account.dueDate}T00:00:00Z`);
  const today = new Date(`${configuredToday()}T00:00:00Z`);
  return Math.max(0, Math.floor((today - due) / 86400000));
}

function auditTool(callId, name, args, output) {
  const safeArgs = { ...args };
  if (Object.prototype.hasOwnProperty.call(safeArgs, "verification_value")) {
    safeArgs.verification_value = "[REDACTED]";
  }

  fs.appendFileSync(
    AUDIT_FILE,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      call_id: callId,
      tool: name || "missing",
      args: safeArgs,
      outcome: output?.status || "unknown",
      reason: output?.reason || null
    })}\n`,
    "utf8"
  );
}

function auditReject(callId, detail) {
  fs.appendFileSync(
    AUDIT_FILE,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      call_id: callId,
      tool: "-",
      args: {},
      outcome: "rejected",
      reason: detail
    })}\n`,
    "utf8"
  );
}

function requireAuthentication(session) {
  return session.authenticated
    ? null
    : { status: "access_denied", reason: "AUTH_REQUIRED" };
}

// The second lock, and it exists for the same reason as the first: a live call
// broke the rule the prompt was supposed to hold on its own.
//
// Maya heard a garbled "well, I am not..." as the wrong person, said goodbye,
// logged WRONG_PERSON at 71s - and never called endCall. The line stayed open,
// the customer said "wait a second", and she restarted from the greeting: she
// then verified the man she had just declared the wrong person, disclosed his
// balance, and logged a promise to pay at 211s. One call ended up asserting
// three different things about itself, which is worse than the missing
// disposition that closeOutCall was written for. A hole in the numbers gets
// noticed; a WRONG_PERSON record sitting next to a live promise does not.
//
// So a terminal disposition now closes the call for business purposes on the
// server side too. Anything that writes to the ledger or discloses account data
// is refused afterwards. verify_customer and escalate_to_agent are deliberately
// left open: the first is stateless enough to be harmless, and the second is the
// one action a human might still legitimately need on a call that is ending
// badly. mark_disposition has its own supersession path below, because a model
// that changed its mind must be able to correct the record rather than silently
// fail to.
function requireOpenCall(session) {
  return session.terminalDisposition
    ? {
        status: "access_denied",
        reason: "CALL_CLOSED",
        disposition: session.terminalDisposition.status
      }
    : null;
}

// Vapi can take the line away mid-conversation: maxDurationSeconds fires, the
// carrier leg drops, or the customer hangs up while Maya is still talking. When
// that happens the model never reaches mark_disposition, and a call that simply
// stops existing is worse than a bad outcome - the outcome of every dial is the
// reporting unit, so a missing disposition is a hole in the day's numbers rather
// than a nil result. A live call proved this: it hit the 300s cap at 306s with a
// promise and a payment link already logged and no disposition at all.
//
// The cap itself stays at 300s. It is a deliberate choice, argued in the README,
// and raising it would only move the same failure later. What was missing was a
// backstop, so the server now closes out any call it has seen whose end arrives
// without a terminal disposition. TECHNICAL_FAILURE is the honest status: the
// call was cut, so nothing about the customer's intent was actually confirmed.
// Whether a promise was logged before the cut goes in the notes, because that is
// what a human reconciling the record needs to know.
function closeOutCall(callId, endedReason) {
  const session = getSession(callId);
  const existing = session.terminalDisposition;

  if (!session.endLogged) {
    session.endLogged = true;
    auditTool(
      callId,
      "call.ended",
      { ended_reason: endedReason || "unknown", disposition: existing ? existing.status : null },
      existing
        ? { status: "success" }
        : { status: "rejected", reason: "NO_DISPOSITION_AT_CALL_END" }
    );
  }

  if (existing) {
    // A closed call can still be an inconsistent one. The live call that forced
    // requireOpenCall ended as WRONG_PERSON with a promise to pay logged against
    // the same call ID, and nothing in the record said so. If the call ends with a
    // live promise under a disposition that does not describe one, say it in the
    // notes rather than leaving two rows to disagree in silence.
    const live = promises.filter((entry) => entry.callId === callId && !entry.supersededBy);
    const promissory = existing.status === "PTP" || existing.status === "ALREADY_PAID";
    const flag = "Contradiction at call end:";
    if (live.length && !promissory && !String(existing.notes || "").includes(flag)) {
      existing.notes = [
        existing.notes,
        `${flag} disposition ${existing.status} but a live promise exists on this call ` +
          `(${live.map((entry) => `${entry.id} ${entry.amount} on ${entry.ptpDate}`).join("; ")}). Needs human reconciliation.`
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 900);
      existing.contradicted = true;
    }
    return existing;
  }

  const live = promises.filter((entry) => entry.callId === callId && !entry.supersededBy);
  const record = {
    id: newId("DSP"),
    callId,
    customerId: session.customerId,
    authenticated: session.authenticated,
    status: "TECHNICAL_FAILURE",
    notes:
      `Auto-closed by server: call ended without mark_disposition (endedReason=${endedReason || "unknown"}). ` +
      (live.length
        ? `Unconfirmed promise on this call: ${live.map((entry) => `${entry.id} ${entry.amount} on ${entry.ptpDate}`).join("; ")}. Needs human reconciliation.`
        : "No promise was logged before the call ended."),
    ptpDate: null,
    ptpAmount: null,
    channel: "VOICE",
    autoClosed: true,
    createdAt: new Date().toISOString()
  };
  dispositions.push(record);
  session.terminalDisposition = record;
  session.autoClosed = true;
  return record;
}

function handleTool(name, args, session, callId) {
  switch (name) {
    case "verify_customer": {
      if (session.authenticated) {
        return { status: "success", authenticated: true, already_verified: true };
      }

      if (session.authAttempts >= MAX_AUTH_ATTEMPTS) {
        return {
          status: "locked",
          authenticated: false,
          reason: "MAX_ATTEMPTS_EXCEEDED",
          retries_remaining: 0
        };
      }

      session.authAttempts += 1;
      const type = String(args.verification_type || "").toUpperCase();
      const value = String(args.verification_value || "").trim();
      let verified = false;

      if (type === "DOB" || type === "DOB_FULL") verified = normalizeDob(value) === account.dob;
      if (type === "PAN_LAST4") verified = value.toUpperCase() === account.panLast4;

      if (verified) {
        session.authenticated = true;
        return {
          status: "success",
          authenticated: true,
          customer_display_name: account.displayName
        };
      }

      return {
        status: "failed",
        authenticated: false,
        retries_remaining: Math.max(0, MAX_AUTH_ATTEMPTS - session.authAttempts)
      };
    }

    case "get_account_details": {
      const closed = requireOpenCall(session);
      if (closed) return closed;
      const denied = requireAuthentication(session);
      if (denied) return denied;

      return {
        status: "success",
        product: account.product,
        overdue_amount: account.overdueAmount,
        days_past_due: daysPastDue(),
        due_date: account.dueDate,
        partial_payment_allowed: account.partialPaymentAllowed,
        min_partial_amount: account.minPartialAmount,
        today_iso: configuredToday(),
        permitted_call_window: "08:00-19:00 customer local time"
      };
    }

    case "log_promise_to_pay": {
      const closed = requireOpenCall(session);
      if (closed) return closed;
      const denied = requireAuthentication(session);
      if (denied) return denied;

      const amount = Number(args.amount);
      const ptpDate = String(args.ptp_date || "");
      const paymentType = String(args.payment_type || "").toUpperCase();

      if (!Number.isFinite(amount) || amount <= 0 || amount > account.overdueAmount) {
        return { status: "rejected", reason: "INVALID_AMOUNT", max_amount: account.overdueAmount };
      }
      if (!["FULL", "PARTIAL"].includes(paymentType)) {
        return { status: "rejected", reason: "INVALID_PAYMENT_TYPE" };
      }
      if (
        paymentType === "PARTIAL" &&
        (!account.partialPaymentAllowed || amount < account.minPartialAmount)
      ) {
        return {
          status: "rejected",
          reason: "PARTIAL_NOT_ALLOWED_OR_TOO_LOW",
          min_partial_amount: account.minPartialAmount
        };
      }
      if (!validIsoDate(ptpDate)) {
        return { status: "rejected", reason: "INVALID_DATE_FORMAT" };
      }
      if (ptpDate < configuredToday()) {
        return { status: "rejected", reason: "PTP_DATE_IN_PAST", today: configuredToday() };
      }

      const record = {
        id: newId("PTP"),
        callId,
        customerId: session.customerId,
        amount,
        ptpDate,
        paymentType,
        createdAt: new Date().toISOString()
      };

      // A live call showed why one call must not leave two live promises behind.
      // Maya logged a full-amount promise while the customer was still mid-
      // sentence proposing a half-now-half-later split, then negotiated the split
      // afterwards. Whatever the prompt does next, the ledger has to end up with
      // one answer to "what did he agree to", so a later promise on the same call
      // supersedes the earlier one instead of sitting beside it.
      const superseded = promises.filter((entry) => entry.callId === callId && !entry.supersededBy);
      for (const entry of superseded) entry.supersededBy = record.id;
      promises.push(record);

      return {
        status: "success",
        ptp_id: record.id,
        amount,
        ptp_date: ptpDate,
        payment_type: paymentType,
        ...(superseded.length ? { supersedes: superseded.map((entry) => entry.id) } : {})
      };
    }

    case "send_payment_link": {
      const closed = requireOpenCall(session);
      if (closed) return closed;
      const denied = requireAuthentication(session);
      if (denied) return denied;

      const channel = String(args.channel || "").toUpperCase();
      if (!["SMS", "WHATSAPP"].includes(channel)) {
        return { status: "rejected", reason: "INVALID_CHANNEL" };
      }

      return {
        status: "success",
        channel,
        delivery_reference: newId("MSG")
      };
    }

    case "escalate_to_agent": {
      const reason = String(args.reason || "").toUpperCase();
      if (reason !== "TECHNICAL_FAILURE") {
        const denied = requireAuthentication(session);
        if (denied) return denied;
      }
      if (!["DISPUTE", "HARDSHIP", "POLICY_EXCEPTION", "TECHNICAL_FAILURE"].includes(reason)) {
        return { status: "rejected", reason: "INVALID_ESCALATION_REASON" };
      }

      const record = {
        id: newId("ESC"),
        callId,
        reason,
        notes: String(args.notes || "").slice(0, 500),
        createdAt: new Date().toISOString()
      };
      escalations.push(record);

      return {
        status: "success",
        ticket_id: record.id,
        queue: reason === "DISPUTE" ? "GRIEVANCE" : "COLLECTIONS_SPECIALIST"
      };
    }

    case "mark_disposition": {
      const status = String(args.status || "").toUpperCase();
      if (!dispositionStatuses.has(status)) {
        return { status: "rejected", reason: "INVALID_DISPOSITION" };
      }
      const previous = session.terminalDisposition;
      // A retried tool call is already handled upstream by the toolCallId cache,
      // so a second mark_disposition that reaches here is a second decision, not
      // a duplicate delivery. The old behaviour returned success against the
      // first record's id, which is how one live call reported a close while
      // WRONG_PERSON stayed on the books. The later decision wins - the model saw
      // more of the call than its own earlier self did - and the earlier record
      // stays, superseded and linked, because a call that changed its mind about
      // who it was talking to is exactly the call a human wants to look at.
      if (previous && previous.status === status) {
        return { status: "success", duplicate: true, disposition_id: previous.id };
      }

      const record = {
        id: newId("DSP"),
        callId,
        customerId: session.customerId,
        authenticated: session.authenticated,
        status,
        notes: String(args.notes || "").slice(0, 800),
        ptpDate: args.ptp_date || null,
        ptpAmount: Number.isFinite(Number(args.ptp_amount)) ? Number(args.ptp_amount) : null,
        channel: String(args.channel || "VOICE").toUpperCase(),
        createdAt: new Date().toISOString()
      };
      if (previous) {
        previous.supersededBy = record.id;
        record.supersedes = previous.id;
        record.notes = [
          record.notes,
          `Supersedes ${previous.id} (${previous.status}) marked earlier on this call. Both decisions were made by the assistant on one call; needs human reconciliation.`
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 900);
      }
      dispositions.push(record);
      session.terminalDisposition = record;

      return {
        status: "success",
        disposition_id: record.id,
        ...(previous ? { supersedes: previous.id } : {})
      };
    }

    default:
      return { status: "error", reason: `UNKNOWN_TOOL:${name || "missing"}` };
  }
}

function authorize(req, res, next) {
  const expected = process.env.WEBHOOK_TOKEN;
  if (!expected) return next();

  if (req.get("authorization") !== `Bearer ${expected}`) {
    // Recorded, because the silence was itself a bug: a tool whose credential is
    // missing or stale produces a call where Maya says she has a system issue and
    // nothing whatsoever reaches the audit log, which is the hardest possible
    // version of this to debug live. Which of the two it is - no header at all
    // versus a header that does not match - is the whole diagnosis, so the shape
    // is logged and the value never is.
    auditReject(getCallId(req.body) || "unknown", req.get("authorization") ? "BAD_BEARER_TOKEN" : "NO_AUTH_HEADER");
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "kapture-maya-mock-tools",
    counts: {
      active_sessions: sessions.size,
      promises: promises.length,
      dispositions: dispositions.length,
      escalations: escalations.length
    }
  });
});

// The browser call console. Served from here rather than from a second static
// server because the repo root holds .env, and `python -m http.server` in the
// repo root would publish it. localhost is a secure context, so the microphone
// works over plain http; the page holds no secret of its own.
app.get("/webcall", (req, res) => {
  res.sendFile(path.join(__dirname, "webcall.html"));
});

app.post("/webhook", authorize, (req, res) => {
  const callId = getCallId(req.body);
  const toolCalls = getToolCalls(req.body);
  const message = req.body?.message || {};

  if (toolCalls.length === 0) {
    // end-of-call-report and status-update are subscribed in serverMessages for
    // exactly this reason: they are the only signal that a call is over, and the
    // model is not always alive to send the disposition itself.
    const ended =
      message.type === "end-of-call-report" ||
      (message.type === "status-update" && message.status === "ended");
    if (callId && ended) closeOutCall(callId, message.endedReason);
    return res.json({ results: [] });
  }
  if (!callId) return res.status(400).json({ error: "CALL_ID_REQUIRED" });

  const session = getSession(callId);
  const results = toolCalls.map((toolCall) => {
    const toolCallId = toolCall?.id || toolCall?.toolCallId;
    const name = toolCall?.name || toolCall?.function?.name;

    if (!toolCallId) {
      return { toolCallId: "missing", result: JSON.stringify({ status: "error", reason: "TOOL_CALL_ID_REQUIRED" }) };
    }
    if (session.processedToolCalls.has(toolCallId)) {
      return { toolCallId, result: session.processedToolCalls.get(toolCallId) };
    }

    const args = parseArguments(toolCall);
    const output = args === null
      ? { status: "error", reason: "INVALID_ARGUMENTS_JSON" }
      : handleTool(name, args, session, callId);
    auditTool(callId, name, args || {}, output);
    const result = JSON.stringify(output);
    session.processedToolCalls.set(toolCallId, result);

    return { toolCallId, result };
  });

  res.json({ results });
});

app.get("/debug/summary", (req, res) => {
  res.json({ promises, dispositions, escalations });
});

function pruneSessions(now = Date.now()) {
  let removed = 0;
  for (const [callId, session] of sessions) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(callId);
      removed += 1;
    }
  }
  return removed;
}

if (require.main === module) {
  const sweep = setInterval(() => pruneSessions(), SESSION_SWEEP_MS);
  sweep.unref();
  app.listen(PORT, () => {
    console.log(`Kapture Maya mock tool server listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, handleTool, getSession, validIsoDate, normalizeDob, parseArguments, pruneSessions, sessions };
