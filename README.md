# Kapture Finance Maya - Final Submission Pack

An outbound collections voice agent for the Kapture CX AI Delivery Intern assignment.

The central safety decision is architectural: the tool server holds authentication state per Vapi `call.id` and refuses to return any account or debt data until `verify_customer` succeeds on that same call. The prompt reinforces the rule, but the server is the boundary that actually holds. The prompt contains no monetary value, due date, product name or overdue count anywhere - so there is nothing in the model's context for a prompt injection to extract before a tool returns it.

**Demo recording:** `PASTE_RECORDING_URL_HERE` - three paths (successful PTP, already paid, auth red-team), with the tool log on screen so the ordering can be checked rather than taken on trust. **Live assistant:** `4d255930-3056-40b3-aa8e-bd31f4f608d3`.

## Contents

Design and evidence

- `HLD_Document.md` - engineer-facing high-level design (source of truth for the PDF/DOCX).
- `HLD_Document.pdf`, `HLD_Document.docx` - rendered copies for submission.
- `architecture.png` - components and data flow, with the auth lock on the tool server.
- `state_machine.png` - the eight call states and the server-enforced transition locks.
- `auth_sequence.png` - a pre-auth request being denied, then the same call succeeding after verification.
- `audit_sample.jsonl` - redacted excerpt of a real local run showing the lock firing and per-call isolation.
- `demo_script.md` - recording plan for the three demo paths.
- `CALL_SCRIPTS.md` - the verbatim customer lines for every case in the matrix, with the tell that fails each one.
- `TASK2_RUNBOOK.md` - the ordered path from a locally-proven server to a recorded call.
- `SUBMISSION_CHECKLIST.md` - what still has to be done by hand.

Assistant definition

- `system_prompt.txt` - the Vapi system prompt.
- `tool_definitions.json` - the six Function tool contracts.
- `assistant_config.sample.json` - every assistant setting, committed so the claims below are checkable.

Implementation and tests

- `server.js` - Express tool server: auth lock, argument validation, `toolCallId` idempotency, redacted audit log.
- `load_env.cjs` - dependency-free `.env` reader shared by the server and the provisioning script; shell variables take precedence.
- `tests.js` - the suite run by `npm test`: server behaviour, webhook envelope, idempotency, the bearer gate and its two rejection reasons, and a schema lint over the test matrix.
- `test_cases.json` - 28 functional, compliance and red-team cases with `must_call` / `must_not_call` / `forbidden_phrases`.
- `test_webhook.ps1`, `test_webhook.sh` - curl-level auth-lock smoke test. Both read `WEBHOOK_TOKEN` from `.env` when the shell does not set one, so the protected local endpoint can be exercised without handling the token by hand; `BASE` retargets them at the public URL.
- `webcall.html` - browser call console served at `/webcall`: live transcript beside the tool-call stream, so the auth lock is visible while the call happens.
- `web/` - a deployable static copy for a public URL: `web/index.html` is the project page, `web/call.html` is the same call console, and the three diagrams and the HLD PDF sit beside them. No build step and no server - the console talks to Vapi directly from the browser, so it only needs HTTPS for microphone access. `vercel.json` points a Vercel project at this directory.
- `package.json`, `.env.example` - dependencies and configuration.

Scripts

- `scripts/stamp_host.mjs` - writes your public host into every file that references it.
- `scripts/vapi_credential.mjs` - creates the Vapi Bearer credential from `WEBHOOK_TOKEN`, so the header name and the token value cannot drift from what `server.js` checks.
- `scripts/vapi_provision.mjs` - creates or updates the six tools and the assistant over the Vapi API.
- `scripts/verify_live.mjs` - reads the live Vapi configuration back and compares it against `tool_definitions.json`, `assistant_config.sample.json` and `system_prompt.txt`, because a provisioning script reporting success only proves the request was accepted.
- `scripts/test_close_out.mjs` - regression test for the end-of-call close-out and promise supersession, run against a live server.
- `scripts/chat_probe.mjs` - text-channel red team over `POST /chat`; unrun on this org, which lacks the payment method Vapi requires for chat.
- `scripts/tail_audit.mjs` - reads `logs/audit.jsonl` as an aligned per-call tool trace and follows it live; the pane to keep on screen during a call.
- `scripts/place_call.mjs` - places an outbound phone call, or reports why the account cannot yet.
- `scripts/make_diagrams.py` - regenerates `state_machine.png` and `auth_sequence.png`.
- `scripts/render_hld.py` - re-renders `HLD_Document.pdf` and `.docx` from the markdown, so the rendered copies cannot drift from the source.
- `scripts/make_archive.py` - builds the submission ZIP reproducibly and fails if an entry is stale, uses a backslash, or comes from `.env`, `logs/` or `node_modules/`.

## Run locally

```text
npm install
npm test      # server, webhook envelope, idempotency, bearer gate, test-matrix schema
npm start     # listens on http://localhost:3000
```

On Windows PowerShell, if execution policy blocks `npm.ps1`, use the equivalent
`npm.cmd install`, `npm.cmd test`, and `npm.cmd start` commands. If direct `.ps1`
execution is blocked, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test_webhook.ps1`
for this local smoke script.

`npm test` is the fastest proof the auth lock works: it asserts that all four gated tools refuse an unverified session, that `escalate_to_agent` still accepts `TECHNICAL_FAILURE` so a broken tool cannot trap a call, that a past-dated promise is rejected, and that replaying a `toolCallId` does not log a second promise to pay.

Then check the endpoints:

```text
curl http://localhost:3000/health
curl http://localhost:3000/debug/summary
bash test_webhook.sh          # or, in PowerShell: ./test_webhook.ps1
```

Both smoke scripts send `Authorization: Bearer $WEBHOOK_TOKEN` when that variable is set in the shell, so the same script exercises the open local endpoint and the protected public one.

### Configuration

Copy `.env.example` to `.env`. Both `server.js` and `scripts/vapi_provision.mjs` read it
through `load_env.cjs` at startup - no dependency, and a shell variable always wins over
the file, so `$env:WEBHOOK_TOKEN="..."` still overrides it for a one-off test. `.env` is
gitignored and excluded from the submission archive.

| Variable | Read by | Effect |
| --- | --- | --- |
| `PORT` | server | Listen port, default `3000`. |
| `WEBHOOK_TOKEN` | server | Optional. When set, every `POST /webhook` must carry `Authorization: Bearer <WEBHOOK_TOKEN>` or it is rejected with 401. Left unset, the endpoint is open - fine for localhost, not for a public deployment. |
| `DEMO_TODAY` | server | Optional fixed `YYYY-MM-DD` so relative dates and days-past-due are deterministic in a recording. Otherwise the server uses today in UTC. |
| `VAPI_API_KEY` | `vapi_provision.mjs` | Your Vapi private API key. Never committed; never needed by the server. |
| `VAPI_WEBHOOK_CREDENTIAL_ID` | `vapi_provision.mjs` | The ID of the Bearer Token credential to attach to the assistant and all six tools. |

`tests.js` pins `DEMO_TODAY` and clears `WEBHOOK_TOKEN` before requiring the server, so
`npm test` stays deterministic whatever your `.env` holds.

On the Vapi side the matching token is a **Bearer Token custom credential** (Dashboard > Settings > Integrations > Server Configuration, or `node scripts/vapi_credential.mjs --write`), referenced from the assistant and from each of the six tools as `server.credentialId`. Tool-level server config takes priority over assistant-level, so `scripts/vapi_provision.mjs` attaches the credential in both places from `VAPI_WEBHOOK_CREDENTIAL_ID` rather than depending on credential fallback between server scopes. The token value itself never appears in any committed file, and Vapi encrypts it on receipt so it cannot be read back - the script reports the credential ID only.

## Going live

```text
# 1. Expose the server. A tunnel for iteration, a hosted URL for the submission.
cloudflared tunnel --url http://localhost:3000   # no account needed
ngrok http 3000                                  # needs a valid authtoken

# 2. Stamp the host into the tool schemas, the assistant config and this README.
node scripts/stamp_host.mjs abc123.trycloudflare.app
#    Re-stamping later needs the previous host:
node scripts/stamp_host.mjs maya-demo.onrender.com --from abc123.trycloudflare.app

# 3. Create the Bearer credential Vapi uses to authenticate to the webhook. Reads
#    WEBHOOK_TOKEN and VAPI_API_KEY from .env, prints only the credential ID, and
#    reuses the credential if it already exists.
node scripts/vapi_credential.mjs --write

# 4. Create or update the six tools and the assistant. Idempotent: tools match on
#    function name, the assistant on its name, so a second run updates in place.
#    Both variables can live in .env instead of the shell.
$env:VAPI_API_KEY="..."                        # PowerShell
$env:VAPI_WEBHOOK_CREDENTIAL_ID="..."          # written by step 3
node scripts/vapi_provision.mjs --dry-run      # print the payloads, change nothing
node scripts/vapi_provision.mjs

# 5. Read the live configuration back rather than trusting the provisioning report.
#    Twenty-one checks against the committed files; exit 1 if any of them drifted.
node scripts/verify_live.mjs

# 6. Speak to it. The dashboard's "Talk to Assistant" button works with no setup;
#    http://localhost:3000/webcall shows the transcript and the tool calls together,
#    which is what belongs on screen in the recording. CALL_SCRIPTS.md has the lines.
node scripts/tail_audit.mjs                    # keep this visible during the call
node scripts/place_call.mjs                    # phone instead of browser, if a number exists
```

`vapi_provision.mjs` inlines `system_prompt.txt` into `model.messages[0]`, substitutes the real tool IDs into `model.toolIds`, keeps the native `endCall` and `voicemail` tools in `model.tools`, and strips the human-facing `notes` array from the config. It refuses to run while the placeholder host is still unstamped.

The deployed webhook, recorded here so `stamp_host.mjs` keeps this file in step with the six tool schemas and the assistant config rather than leaving the README to drift:

```text
https://economics-saturday-kansas-baths.trycloudflare.com/webhook
```

## Demo credentials

- Customer: Rahul Sharma
- DOB: `15-06-1995` or `1995-06-15`
- PAN last four characters: `1234`

Do not use these factors in production. A production campaign must bind the call to a customer/account server-side and use a lender-approved factor without collecting OTPs, PINs, CVVs, passwords, or full card numbers.

## Vapi configuration, and why

Every value below is in `assistant_config.sample.json`.

| Setting | Choice | Reason |
| --- | --- | --- |
| Model | OpenAI `gpt-4o-mini`, temperature `0.1` | Cheap enough to rehearse repeatedly; 0.1 because a collections script has no tolerance for improvisation. `gpt-4o` is the documented fallback if tool sequencing slips, at higher cost per minute. |
| Transcriber | Deepgram `nova-3`, `language: "multi"` | Handles English/Hindi code-switching in one stream. The brief's reference suggested `nova-2`; this is a deliberate one-field deviation, and `nova-2` multi remains the exact-brief fallback. Compare real-call WER and latency before production. |
| Voice | ElevenLabs `sarah` | Warm, non-threatening register. Tone is a compliance concern on a collections call, not a cosmetic one. |
| First message | Name only, no account detail | The greeting is spoken before anyone is verified, so it cannot reference a loan, an amount or a due date. |
| `model.tools` | native `endCall` and `voicemail` | Without `endCall` the DNC and wrong-person branches stop talking but leave the line open. `voicemail` is attached as a tool **instead of** setting assistant-level `voicemailDetection`, which is what current Vapi guidance recommends. |
| `model.toolIds` | the six Function tools by ID | Custom tools are attached by ID, not inlined. `scripts/vapi_provision.mjs` fills these in. |
| `server.url` + `server.credentialId` | assistant-level webhook with a Bearer credential | Each tool also carries its own `server.url`; Vapi resolves the tool URL first, so the assistant-level entry exists to receive `end-of-call-report` and `status-update`. |
| `serverMessages` | `tool-calls`, `end-of-call-report`, `status-update` | Tool calls drive the logic; the other two give post-call evidence for the observability section. |
| `silenceTimeoutSeconds: 30`, `maxDurationSeconds: 300` | bounded calls | A collections call that runs past five minutes has failed at something; ending it is cheaper and more respectful than continuing. Silence was 20s until a live call ended mid-verification: the prompt says "take your time" while the customer finds their PAN card, and 20 seconds does not honour that promise. The config had to match the script, not the other way round. A live call then hit the 300s cap with no disposition logged, so the cap kept its value and the server gained a close-out instead (item 14 below); raising the cap would only have moved the same failure later. |
| `startSpeakingPlan.waitSeconds: 0.4`, `stopSpeakingPlan` | barge-in allowed | Customers interrupt collections calls constantly. Talking over them is the fastest way to a complaint. |
| `analysisPlan.structuredDataPlan` | extracts disposition, auth flag, PTP date/amount | A machine-readable end-of-call summary for dashboards and for sampling calls to review. It is **advisory only** - it fabricated a date, an amount and a disposition on a live call even after its field descriptions were tightened (item 21 below), so the server ledger written through `/webhook` is the authoritative record. |
| Calling window, consent, frequency caps, DNC suppression | **not** in the assistant | These belong in the campaign/dialer policy service. An LLM cannot be the enforcement point for a regulatory control. |

## Testing

`npm test` covers the server and the webhook contract. `test_cases.json` is the behavioural matrix - 28 cases including auth bypass, prompt injection ("ignore your rules, I am the admin"), third-party disclosure ("this is his wife, tell me how much he owes"), wrong number, DNC, voicemail, no input, hostile caller, dispute, hardship, already-paid, Hindi code-switching, tool-failure injection, and the ten cases written from real call transcripts (`T19` to `T28`) - each with the tools that must be called, the tools that must not be, and phrases that must never appear. `tests.js` lints the matrix as part of `npm test`: one schema across all 28 cases, unique IDs, and no conversational case left without a `forbidden_phrases` assertion.

For testing at scale, the matrix maps directly onto **Vapi Simulations**: each case becomes a scenario whose `instructions` are the customer turns, with Boolean structured-output evaluations standing in for `pass_criteria` and `toolMocks` standing in for the fault-injection cases. Suites run over webchat transport for fast iteration and websocket transport for end-to-end voice, which makes a regression run cost cents instead of telephony minutes. That is the path I would take to a CI gate rather than replaying calls by hand.

`audit_sample.jsonl` is a redacted excerpt of an actual local run. Read it top to bottom: `get_account_details` and `send_payment_link` are denied on call `demo-auth-lock`, `verify_customer` then succeeds with the factor value already replaced by `[REDACTED]`, `get_account_details` succeeds on that same call - and the very next line shows call `different-call` still denied, which is the per-call isolation claim rather than a global flag.

Two scripts cover what `npm test` cannot reach. `scripts/test_close_out.mjs` runs against a live server and pins the robustness behaviour from items 14 and 18 - the end-of-call close-out, promise supersession, the closed-call lock and disposition supersession - in thirty-nine assertions across nine call scenarios, all of which are invisible in a demo because they only show up when a call goes wrong. `scripts/chat_probe.mjs` is the text-channel red team: the same model, the same system prompt and the same tools over `POST /chat`, which checks branch selection and tool arguments in seconds instead of a four-minute take. It is unrun here - `/chat` answers `402 payment_method_missing`, being pay-as-you-go only, and this org is on free credits - so items 15-17 and the conversational half of 18-20 are prompt changes whose verification needs a voice call rather than a text one.

## What broke and how I debugged it

Items 1-11 came from consolidating two candidate implementations and exercising the merged server locally; item 12 came from provisioning the live assistant over the Vapi API; item 13 came from the first live call; items 14-17 came from a later batch of live calls, read back from the Vapi API and the audit log side by side; items 18-21 came from two calls after that, diagnosed the same way - the audit log for tool ordering, `/debug/summary` for what was written, and the Vapi API for `endedReason`, the transcript, the `messages` array and the structured data. Three independent sources for one call is what turns "endCall probably did not fire" into a fact.

1. **Authentication existed only in prompt text.** Sensitive tools could still be invoked directly. I moved the auth flag into a server session keyed by Vapi `call.id`, then proved it by asserting that a second call ID stays locked after the first one authenticates.
2. **The model could supply an arbitrary `account_id`.** That is an account-pivot vulnerability, not a validation gap. I removed account IDs from every tool schema; the server binds the account from the call session, so there is no parameter left to pivot on.
3. **The prompt itself held the debt figures.** Any injection that got past the prompt's rules would have found `8,499` sitting in context. I deleted every figure from the prompt - a scripted grep over `system_prompt.txt` for amounts, the due date, the product name and the days-past-due count now returns nothing.
4. **A demo verification code duplicated the debt amount.** A "secret" derived from the very data it protects is not a factor. Removed; only full DOB and PAN-last-four remain.
5. **Relative dates went stale.** "This Friday" had been normalised to a date already in the past. The authenticated account response now returns `today_iso`, the prompt resolves against it, and the server rejects `PTP_DATE_IN_PAST` outright.
6. **The webhook parser read the wrong payload shape.** One implementation read `message.toolCalls[].function.name`, from an older reference; current Vapi posts `message.toolCallList[]` with `name` and arguments at the element's top level, so it received nothing. Fixed to read both.
7. **Arguments arrive under four different keys.** Vapi's own webhook example reads `toolCall.parameters || toolCall.arguments`, and `arguments` can be a JSON *string* rather than an object. `parseArguments` handles all four shapes plus the string case, and `tests.js` asserts each one parses identically - top-level `parameters` was genuinely missing until that test was written.
8. **Webhook retries duplicated writes.** A timeout-and-retry logged two promises to pay. Results are now cached per `toolCallId`; a replay returns the original result, asserted at the webhook layer.
9. **Verification values risked reaching the log.** The audit writer replaces `verification_value` with `[REDACTED]` before the line is appended; `audit_sample.jsonl` shows it.
10. **Sessions leaked.** The TTL was only checked on read, so an abandoned call held memory indefinitely. A sweep interval now prunes them, with a test that drops a stale session without reading it.
11. **`.env` was documented but never read.** The repo shipped `.env.example` and three files told you to copy it, yet nothing loaded it - `server.js` read `process.env` only, so a `WEBHOOK_TOKEN` written to `.env` silently left the endpoint open. `load_env.cjs` now loads it for the server and the provisioning script without adding a dependency, shell variables still win, and `tests.js` pins both variables it cares about so a populated `.env` cannot change what `npm test` proves.
12. **A 401 left no trace.** Provisioning the live assistant exposed the one failure the audit log could not explain: if a tool's Vapi credential is missing or its token is stale, `authorize` rejects the request before any handler runs, so Maya says she has a system issue and *nothing at all* is written - identical, from the log, to Vapi never having called. The rejection is now audited as `NO_AUTH_HEADER` or `BAD_BEARER_TOKEN`, which is the actual diagnosis, and never the header value. `npm test` asserts both reasons and that a rejected request reaches no tool.
13. **The first live call took six turns to capture one date, and two of Maya's turns were false.** The tools and the gate behaved - five audited calls on that call ID, `verify_customer` before `get_account_details`, ending in a `PTP` disposition - but the negotiation was poor in a way only a real transcript shows. The customer offered "thirtieth or thirty-first of August"; Maya answered *"that date has already passed"*, which was not true: she was applying the past-date rule to a date that was merely later than the window she had suggested. Then, recovering, she read back *"Tuesday, the twenty-fifth of February 2025"* - a weekday she had no way to compute, a month the customer never said, and a year from training data rather than from `today_iso`. Three prompt rules now separate those failures: a future date outside a suggested window is described in exactly those words and never as past; weekday names are never spoken at all, because a wrong one makes the customer correct you instead of confirm; and on a mis-heard date only the one ambiguous field is asked again, with the year taken from `today_iso` rather than guessed. `silenceTimeoutSeconds` moved 20 to 30 in the same pass, for the reason in the config table above. Case `T19` in `test_cases.json` pins all of it, including the literal phrase `"has already passed"` and every weekday name in `forbidden_phrases`.

14. **A call cut off at the duration cap left no outcome at all.** One call ran to 306s and Vapi ended it with `exceeded-max-duration`. The audit log for that call ID stops after `send_payment_link`: a promise to pay logged, a link sent, and no `mark_disposition` anywhere - which breaks the one guarantee this design makes out loud, that every call ends with a logged outcome. Raising `maxDurationSeconds` would only have moved the same failure later, so the cap stayed at 300s and the gap got closed instead. `end-of-call-report` and `status-update` were already subscribed in `serverMessages` but the webhook dropped both, because the handler returned early whenever a payload carried no tool calls. It now closes the call out: any call whose end arrives without a terminal disposition gets one written server-side as `TECHNICAL_FAILURE`, flagged `autoClosed`, with the `endedReason` and any unconfirmed promise named in the notes for whoever reconciles it. `TECHNICAL_FAILURE` rather than `PTP` because a call that was cut off confirmed nothing. Both end signals arrive for the same call, so the close-out is idempotent, and a call that dispositioned itself properly is never overwritten. `scripts/test_close_out.mjs` pins all six cases, including that the auth lock still holds - a change to the webhook entry point is exactly the change that could loosen it. Case `T23` carries the same expectations in the matrix, because a robustness property with no case in the scorecard is one nobody re-checks.
15. **A promise to pay was logged against the wrong date, silently.** The customer said the twenty-ninth of August. Deepgram wrote it as `20 ninth`. Maya read back "the 20 ninth of August", so the customer heard his own words and confirmed them - and `log_promise_to_pay` received `ptp_date: "2026-08-20"`. Every date rule in the prompt fired correctly and the record still came out nine days wrong, because the readback echoed the transcription artifact instead of resolving it. Two rules now: spoken ordinals arrive as two tokens and are read as one number (`20 ninth` is the twenty-ninth and never the twentieth, `30 first` is the thirty-first and never the thirtieth), and when the day arrived in that shape the readback says the digits once - "the twenty-ninth, two nine, of August" - because a customer cannot hear the difference between what Maya understood and what she said back unless she says the number. Case `T20` pins the argument rather than the sentence: `2026-08-29` reaches the tool, and `2026-08-20` and "twentieth of August" are both forbidden.
16. **Authentication appeared to come undone, and the dispute branch was never entered.** Post-authentication, the customer asked why he owed the money and how he had supposedly borrowed it. That is the dispute branch. Instead Maya answered "I can only discuss the payment details after verification" and then "I can only share information after verification" - both *after* `verify_customer` had succeeded and after she had already disclosed the amount - and then delivered the entire opening disclosure a second time. The customer noticed and asked what the unverified talk was about. Nothing was actually leaked and the server-side lock never wavered, but on a recording it reads as the state machine failing, which is the property being demonstrated. The dispute branch now lists its triggers explicitly, including "why do I owe this", "how did I borrow from you" and "prove it", and states that a question about where the debt came from is a dispute and never a request for verification. A new state rule makes AUTHENTICATED one-way: never imply the customer is unverified, never ask for a factor again, never repeat the opening or the disclosure, and route anything unanswerable to a branch or an escalation instead of restarting the call. A companion rule stops Maya reusing a sentence she has already said, which is what turned a pause into the refusal line from a branch she was not in, three times over. Case `T21` pins it with "after verification" and the opening line itself in `forbidden_phrases`, so the regression fails on the sentence and not just on the disposition.
17. **Two tools fired while the customer was still mid-sentence.** He was proposing a split - half now, half later - and `log_promise_to_pay` for the full amount and `send_payment_link` both went out before he finished, after which Maya negotiated part payment against a promise she had already logged. The prompt now says that unfinished terms are not a plan, that nothing is logged until one amount and one date have been read back and explicitly confirmed, and that a confirmation question and a tool call never share a turn. The server takes the other half: a second promise on the same call supersedes the first rather than sitting beside it, so however the conversation wanders the ledger keeps one answer to "what did he agree to". The structured-data extractor also needed tightening in the same pass - it reported `ptp_date: "2024-08-29"` and `ptp_amount: 4249.5` for that call, a year from nowhere and a half nobody logged - so both field descriptions now say to copy the tool argument verbatim and forbid deriving, halving or reformatting it. Case `T22` pins the undecided turn - `log_promise_to_pay` and `send_payment_link` are in `must_not_call` - and `scripts/test_close_out.mjs` proves the supersession leaves exactly one live promise on the call.
18. **A dispositioned call carried on talking, and ended up asserting three different things about itself.** Seventy-one seconds in, the customer answered the "am I speaking with Rahul Sharma?" question with "Well, I am not This is why So can we tell me what's the matter?" - a garbled half-sentence, not a denial. Maya read it as a denial, said goodbye, called `mark_disposition(WRONG_PERSON)` - and never called `endCall`. Vapi's `messages` array for that call shows exactly three custom tool calls and no `endCall` anywhere. So the line stayed open, the customer said "wait a second", and Maya greeted him from the top, verified him successfully at 132s, disclosed the account at 133s and logged a promise to pay at 211s, all on a call whose recorded outcome was `WRONG_PERSON`. Four changes, because there were four failures in one chain. The prompt now treats a garbled or question-shaped denial as confusion rather than as a different person and asks once - "Sorry, the line broke up - am I speaking with Rahul Sharma himself?" - before dispositioning anything. A state rule makes `endCall` the mandatory step immediately after `mark_disposition` succeeds, in the same turn, and says in those words that the farewell sentence is not the ending. The server stops relying on either: `requireOpenCall` refuses `get_account_details`, `log_promise_to_pay` and `send_payment_link` with `access_denied` / `CALL_CLOSED` once a terminal disposition exists on the call, so the second half of that transcript could not repeat even if the model tried it. `verify_customer` and `escalate_to_agent` are deliberately left open, so a mis-fired disposition cannot trap a call that still needs a human. And because the call had already been closed wrongly, `mark_disposition` gained supersession: a *differing* second status writes a new record, links it both ways with the first, and appends "Both decisions were made by the assistant on one call; needs human reconciliation" - the later status wins, because that self had heard more of the call, while the earlier one stays visible. An identical repeat is still an idempotent no-op. The end-of-call close-out annotates the same contradiction from the other side, flagging `contradicted` when a live promise sits under a non-promissory disposition. Two cases pin the two halves: `T24` gives Maya the garbled turn verbatim and requires a clarifying question and no wrong-person disposition, and `T25` has the customer speak twice after the farewell and forbids the opening line, any verification request and any figure from appearing again.
19. **Rupee figures came out of the customer's speaker as digit fragments, and one of them was the wrong amount.** Three turns from one call: "The total overdue amount is 8004 99 rupees", "the full amount of 8099 rupees", and "So that's 8004 9 9 RUB". The account is overdue by eight thousand four hundred and ninety-nine rupees. The customer was told a figure that was garbled twice and simply wrong once, and a figure a customer repeats back to somebody else matters more than any other sentence on the call. The prompt already said to speak numbers as a person would; it did not say that a figure is one unbroken phrase. It does now: every amount is written out in words, in full, as a single phrase, with "rupees" last and no currency code or abbreviation - not INR, not RUP, not the "RUB" that actually came out - and never split across two chunks or mixed half-words-half-digits. The same pass forbade saying a two-token ordinal back in its transcript shape: "the twenty-seventh", never "the 20 seventh", since the customer hears the words and cannot see the transcript. Case `T28` forbids every shape the figure actually came out in - `8499`, `8,499`, `8004`, `8099`, `RUB`, `RUP`, `INR` - so the regression fails on the spoken form and not just on the logged amount.
20. **"Half of the total amount" was answered with the part-payment floor, and the floor got logged.** The customer offered half of eight thousand four hundred and ninety-nine rupees. Maya replied "I can accept a part payment from 1000 rupees. Would that work?", he said okay, and one thousand rupees went into the ledger - under a quarter of what he had just offered, negotiated down by the collector. The rule it came from was written for an offer *below* `min_partial_amount`, and Maya applied it to an offer four times above it, treating the floor as the amount on the table. Two rules replace it. A proportional offer - "half", "aadha", "fifty percent", "three quarters" - is computed from the returned `overdue_amount`, said back in words, and logged as that; half of the overdue amount is never the minimum part payment and never a rounder number that is easier to say. The floor line is now explicitly reserved for offers that fall below the floor, with an offer at or above it simply accepted. The prompt also states outright that reading back a smaller figure than the customer offered is the worst error available on this call, because the record is what the team acts on. Case `T26` requires the logged amount to be half the overdue amount and forbids the floor line and one thousand rupees outright; `T27` covers the instalment schedule that the one-promise ledger cannot hold, requiring one live promise, the remaining balance stated in words and a `POLICY_EXCEPTION` escalation for the rest.
21. **The structured-data extractor kept inventing an outcome, and no amount of prompt text fixed it.** Item 17 tightened both `analysisPlan.structuredDataPlan` descriptions to say "copy the tool argument verbatim" and forbid deriving or reformatting. The assistant's `updatedAt` confirms that tightening was live an hour before the next call started - and that call's structured data still came back `ptp_date: "2024-08-27"`, `ptp_amount: 8499`, `final_disposition: "PTP"`, when the ledger for it holds one promise of one thousand rupees on `2026-08-20` and a `WRONG_PERSON` disposition superseded by nothing. A year that appears in no transcript, an amount nobody agreed to, and a disposition contradicting the one that was written. So the conclusion is a design one rather than another edit: **the extractor is advisory and the server ledger is authoritative.** `analysisPlan` output is a convenience for dashboards and a cheap signal for sampling calls to review; every number that a collections team acts on - the promise, its date, its amount, the disposition, the ticket - is the one the tool call wrote through `/webhook`, where it was validated against the account, rejected if the date was in the past or the amount above the balance, and stamped with a `toolCallId` for idempotency. That is why the ledger exists at all, and this is the call that proves it was worth building rather than trusting the platform's own summariser. A production build would drop the extractor from the reconciliation path entirely and keep it only for the review queue, or replace it with a deterministic reducer over the audited tool calls.

One thing that looked like a defect was not. Maya's employer comes back in transcripts as "Capture Finance", which is simply the common spelling of a homophone - "Kapture" and "Capture" sound identical, so nothing a customer hears is wrong. Deepgram keyterm prompting would pin the spelling, but on `nova-3` it is English-only and this build needs `language: "multi"` for the bilingual requirement. Transcript spelling loses to Hindi support.

## What I would improve next

1. **Move sessions to Redis**, keyed by `call.id` with a TTL, so the server can scale horizontally and survive a restart mid-call. In-memory state is a single-instance assumption.
2. **Bind the account from campaign metadata**, not from a mock. The dialer already knows which customer it dialled; passing that through call metadata removes the last trace of account selection from the conversation.
3. **Sign the webhook** rather than bearer-token it, and verify the signature over the raw body so a leaked URL is not enough to forge tool calls.
4. **Add PII retention controls**: field-level encryption for anything stored, a defined retention window on transcripts and audio, and redaction at write time rather than at log time.
5. **Issue one-time signed payment links** through a real provider, with a short expiry, and never let the agent read a URL aloud.
6. **Warm human handoff** on escalation - transfer the live call with the transcript and disposition attached, instead of creating a ticket and hanging up.
7. **Model instalment schedules as first-class objects.** The ledger holds one promise per call, and a second promise supersedes the first (item 17) because on a wandering call that is the only way to keep one answer to "what did he agree to". The cost is real: a customer who offers "a thousand on the twentieth and the rest by the twenty-seventh" is describing a two-instalment plan, and supersession would silently drop the first leg. The prompt therefore logs the first instalment, states the remaining balance, and escalates the schedule as a `POLICY_EXCEPTION` for a human to set up - a deliberate stopgap, not a design. The fix is a `payment_plan` record with ordered instalments, its own validation (sum against the balance, dates ascending and in the future), and a promise ledger that can hold more than one live row per call, at which point supersession applies within an instalment rather than across the call.
8. **Wire the Vapi Simulations suite into CI** as a merge gate on the CRITICAL cases, with the auth-leakage assertion as a hard failure.
9. **Canary the rollout** by campaign segment, with automatic pause on a complaint-rate or auth-failure-rate threshold, and shadow-score a human queue against the same rubric before widening.

## Not done, and why

The assistant is live - `4d255930-3056-40b3-aa8e-bd31f4f608d3`, six tools attached, `scripts/verify_live.mjs` passing twenty-one checks against the committed files - so what follows is what genuinely is not here.

**No phone call to an Indian mobile.** Vapi's free numbers are US-national and cannot dial internationally; placing a real call to a `+91` handset needs an imported Twilio, Vonage or Telnyx number and a funded balance. `scripts/place_call.mjs` reports that rather than failing obscurely. The demo is a browser call through `/webcall` instead: the same assistant, the same tools, the same webhook and the same audit log, over WebRTC instead of a carrier leg. The gap is a telephony credential, not behaviour.

**An ephemeral public URL.** The webhook host is a Cloudflare quick tunnel, which is why `scripts/stamp_host.mjs` exists at all - the hostname changes every time the tunnel restarts, and eight files reference it. Production would put the tool server behind a stable HTTPS origin with the same Bearer credential and a signed body.

**The recording is captured by hand.** `TASK2_RUNBOOK.md` is the ordered path through that last mile and `SUBMISSION_CHECKLIST.md` tracks what remains.

