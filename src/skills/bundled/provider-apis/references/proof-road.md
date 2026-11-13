# Provider proof road

Reproduce the defect on the base and verify the fix with the existing fixture nearest the changed owner.

## Isolation

Set a fresh scratch `MERCURY_CONFIG_DIR` and `TMPDIR`, unset `MERCURY_HOME`, use `MERCURY_CREDENTIAL_STORE=file` with dummy keys and `MERCURY_LOCAL_PROBE_TARGETS=none`, and point every exercised provider base URL to loopback before importing dispatch. Build `dist/mercury.mjs` first when driving the bundle; never touch operator homes, credentials or daemons.

## Fixture map

| Changed behavior | Owner to inspect |
|---|---|
| Messages requests, auth recovery, stream cuts | `scripts/lib/fixtureApi.ts`, `scripts/api/authRetryFixture.ts`, `scripts/api/streamCutFixture.mjs` |
| HTTP/1.1 dispatcher | `scripts/api/prove-http2-lane.ts` |
| Workspace headers, in-flight slot switch | `scripts/providers/prove-anthropic-workspace-key.ts`, `scripts/providers/prove-anthropic-inflight-slot-switch.ts` |
| First byte / request deadline | `scripts/providers/prove-first-byte-budget.ts`, `scripts/api/prove-anthropic-request-deadline.ts` |
| Chat decode, OpenRouter mixed-upstream retry | `scripts/provider-compat/prove-compat-chat-transport.ts`, `scripts/provider-compat/prove-openrouter-mixed-upstream-retry.ts` |
| Pairable malformed calls, Gemini trailing signatures | `scripts/providers/prove-malformed-call-tool-result.ts`, `scripts/providers/prove-gemini-stop-reason.ts` |
| Resume / roster replay | `scripts/messages/prove-stopped-resume-wire.ts`, `scripts/api/prove-restart-keeps-thinking.ts`, `scripts/mcp/prove-mcp-list-changed-live.ts` |
| Usage meters, xAI account fixtures | `scripts/providers/prove-usage-truth-meters.ts`, `scripts/providers/lib/xai-auth-fixture.ts`, `scripts/providers/lib/xai-usage-fixture.ts` |
| Context overflow | `scripts/compact/overflowFixture.ts` |

Assert identity, endpoint, effort, tool/result pairing and replay order without secrets. For refusal/retry changes, test served recovery after refusal and explicit `Retry-After` separately from plan-window bodies; cover cancellation, partial output and terminal faults where affected. Regenerate byte goldens only through their recorders (`scripts/messages/prove-dialect-byte-parity.ts` with archived `/base`; `scripts/messages/prove-messages-parity.ts`), never by hand.
