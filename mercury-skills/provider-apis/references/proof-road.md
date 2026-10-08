# Provider proof road

Source map read 2026-10-08. Work in the intended checkout and name it explicitly in build and proof commands.

## Isolate first

Use a fresh scratch directory for `MERCURY_CONFIG_DIR`, set `MERCURY_CREDENTIAL_STORE=file` and `ANTHROPIC_API_KEY=proof-key-ci-gate-not-a-real-key`, and unset `MERCURY_HOME`. Set `MERCURY_LOCAL_PROBE_TARGETS=none` so a proof does not discover somebody else's server. Use a real scratch `TMPDIR`; never point a proof at the operator's home, settings, credentials or daemon. Build that checkout before setting `MERCURY_GATE_PREBUILT=1` for its suites. A dummy key is not network isolation: point every provider base a fixture exercises to its loopback server before importing the dispatch road.

## Pick the fixture that reaches the changed owner

- `scripts/lib/fixtureApi.ts` serves scripted Anthropic Messages and captures request bodies. `scripts/api/authRetryFixture.ts` supplies `authWorld`, including sign-in refresh and refusal cases. `scripts/api/streamCutFixture.mjs` drives interrupted streams.
- `scripts/provider-compat/prove-compat-chat-transport.ts` injects fetch responses to pin shared request and SSE decoding. `scripts/provider-compat/prove-openrouter-mixed-upstream-retry.ts` starts a loopback Responses server and reaches it through `routedCallModel`; use that pattern when the bug spans routing and replay.
- `scripts/providers/lib/xai-auth-fixture.ts` and `scripts/providers/lib/xai-usage-fixture.ts` provide `xaiAuthFixture` and `xaiUsageFixture`. Usage proofs such as `scripts/providers/prove-usage-truth-meters.ts` cover the common display facts; do not replace an account balance with a token estimate.
- `scripts/compact/overflowFixture.ts` supplies `startOverflowFixture` for compaction and overflow requests across provider dialects.

A defect proof must fail on the base for the reported behavior and pass on the tip. Capture enough of each request to prove model identity, endpoint, tool/result pairing, effort and replay order without writing secrets. Exercise a served turn after a refusal: the retry/resume reaches the provider and the old usage note does not refuse it locally. Exercise `Retry-After` separately from an explicit plan-window body.

## Keep the byte contracts

`scripts/messages/dialectFixture.ts` is the shared synthetic conversation. `scripts/messages/prove-dialect-byte-parity.ts` compares complete canonical and serialized request bodies; its `--record <archived-base>` mode requires the archived source path to end in `/base`. Preserve that recorder's provenance rule. Other message goldens have their own recorder in `scripts/messages/prove-messages-parity.ts`. Never hand-edit captured bytes or erase an assertion to accept a changed transport.

The mechanical behavior baseline uses `bash scripts/agent-experience/benchmark.sh --record mechanical`. Run a recorder only for an explained, intended contract change and inspect the resulting diff. Ordinary provider work first runs the existing baseline unchanged.

## Close on measured evidence

Run `bun run typecheck`, the nearest `scripts/api`, `scripts/provider-compat`, `scripts/providers` and `scripts/messages` proofs that exercise the changed road, and every suite whose `# gate-watch:` lines name the changed source. Run `scripts/identity/run-all.sh` when words or fixtures changed. Generated assets move through their generators and are checked with `bun scripts/gate/generated-assets.ts --all --check`.

For this bundled skill, edit `mercury-skills/provider-apis/`, then run `bun scripts/skills/gen-bundled.ts provider-apis`. The generated mirror is `src/skills/bundled/provider-apis/`. Run `scripts/skills/run-all.sh`: registration, description, arguments, body and extracted references must come through the real loader. Keep the positive provider-engineering example and the negative account-sign-in example distinct; a loader check alone does not prove semantic model routing.

Report which base and tip were tested, captured requests, actual exits, re-pinned expectations and anything not verified. Loopback success is not a live-provider reading. Do not spend a real model request, change the operator's account or deploy a build without separate authorisation.
