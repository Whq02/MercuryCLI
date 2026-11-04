# Provider proof road

Reproduce the reported behavior on the base and the same case on the change. Select the fixture that reaches the changed owner; a usage-reader fix does not require inventing a new protocol suite.

## Isolation

Use a fresh scratch `MERCURY_CONFIG_DIR` and `TMPDIR`, unset `MERCURY_HOME`, select the file credential store and dummy keys, and set `MERCURY_LOCAL_PROBE_TARGETS=none`. Point every exercised provider base to loopback before importing dispatch. Dummy credentials alone do not isolate a request. Build the intended checkout before a proof that drives its bundle; never read the operator's settings, credentials or daemon.

## Fixture map

| Changed behavior | Existing owner to inspect |
|---|---|
| Messages requests, auth recovery, interrupted streams | `scripts/lib/fixtureApi.ts`, `scripts/api/authRetryFixture.ts`, `scripts/api/streamCutFixture.mjs` |
| HTTP/1.1 dispatcher | `scripts/api/prove-http2-lane.ts` |
| Workspace headers, in-flight slot switch | `scripts/providers/prove-anthropic-workspace-key.ts`, `scripts/providers/prove-anthropic-inflight-slot-switch.ts` |
| First byte / request deadline | `scripts/providers/prove-first-byte-budget.ts`, `scripts/api/prove-anthropic-request-deadline.ts` |
| Chat decode, Responses retry through routedCallModel | `scripts/provider-compat/prove-compat-chat-transport.ts`, `scripts/provider-compat/prove-openrouter-mixed-upstream-retry.ts` |
| Pairable malformed calls, Gemini trailing signatures | `scripts/providers/prove-malformed-call-tool-result.ts`, `scripts/providers/prove-gemini-stop-reason.ts` |
| Resume / roster replay | `scripts/messages/prove-stopped-resume-wire.ts`, `scripts/api/prove-restart-keeps-thinking.ts`, `scripts/mcp/prove-mcp-list-changed-live.ts` |
| Usage, xAI account fixtures | `scripts/providers/prove-usage-truth-meters.ts`, `scripts/providers/lib/xai-auth-fixture.ts`, `scripts/providers/lib/xai-usage-fixture.ts` |
| Context overflow | `scripts/compact/overflowFixture.ts` |

Capture identity, endpoint, effort, tool/result pairing and replay order without secrets. For a refusal/retry change, prove a served turn after refusal and explicit Retry-After separately from a plan-window body. Select cancellation, partial output and terminal-fault cases by the affected behavior.

Run the touched behavior's checks and required project gates. Byte goldens move only through their recorders: `scripts/messages/prove-dialect-byte-parity.ts` requires an archived `/base` for recording; `scripts/messages/prove-messages-parity.ts` owns its own captures. Explain every changed expectation; do not hand-edit captured bytes.

For skill changes, compare loader expansion separately from task quality: observed engineering requests, account/UI non-triggers and confusable carrier/account cases. With operator-selected engines/effort, compare current, variant and safe no-skill baseline; record invocations, references read, outcomes, tokens and latency across repeats. Smaller text alone is not a quality result. Report tested base/tip, exits, request evidence and limits; release/deployment and live inference need their own authorisation.
