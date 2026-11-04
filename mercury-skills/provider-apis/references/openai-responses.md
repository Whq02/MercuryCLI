# Responses roads

Historical CODE map, 2026-10-26. Vendor readings and account-specific limits are in `live-sources.md`; shared invariants live in the entry. An OpenAI-shaped request does not identify its serving account.

## OpenAI

`src/services/providers/openai/openaiCallModel.ts` integrates settlement; `src/services/providers/openai/openaiClient.ts` owns HTTP; `src/services/providers/openai/openaiWire.ts` owns typed items, SSE fold and faults. `src/services/providers/openai/responsesBridge.ts` builds stateless requests and ordered replay.

Keep store:false and encrypted reasoning replay; the legacy include request is accepted, not required for stateless encrypted output. Replay captured reasoning/message/function-call items in their recorded order. Another provider's thinking is not an OpenAI replay item; previous_response_id is not a substitute for Mercury's stateless record. Preserve assistant phase and correlate function_call_output by call_id. Function tools are flat, unlike Chat Completions' nested function objects.

Effort, reasoning context/mode, configuration_update and cache controls vary by model generation. Consult the current model's reference before substituting newer cache options for older retention fields. A tool call settles once from its done item, using accumulated arguments if needed. Unknown items remain observable. Completed, failed and incomplete are distinct terminals; absence of a required terminal is a fault. Settle input/cached/output/reasoning usage as reported rather than counting stream updates twice.

`src/services/providers/openai/openaiUsageState.ts` owns subscription/header observations; `src/services/providers/openai/openaiLimitState.ts` holds observed refusal. These are not interchangeable with API organization billing.

## OpenRouter

`src/services/providers/openrouter/openrouterCallModel.ts` selects the profile; `src/services/providers/openrouter/openrouterResponsesTransport.ts` builds stateless Responses and records replay. `src/services/providers/openrouter/openrouterCache.ts` distinguishes top-level Responses cache markers from supported chat block breakpoints.

Mixed-upstream recovery is narrow: one matching encrypted-reasoning HTTP 400 permits replay after removing only encrypted reasoning input items. Preserve text, calls, outputs and order. Other 400s and the second refusal do not take this path. `scripts/provider-compat/prove-openrouter-mixed-upstream-retry.ts` captures both requests.

`src/services/providers/openrouter/openrouterRoutingPolicy.ts` sets Mercury's stricter require_parameters/data_collection preferences; these are not the vendor defaults. Preserve explicit fallback/ZDR settings. Provider preferences do not authorize switching Mercury account families. `src/services/providers/openrouter/openrouterUsageState.ts` reads active-key budgets and limit-source classifications; a public budget schema is not proof of a particular key's balance.

## Other account variants

- `src/services/providers/xai/xaiCallModel.ts` selects `src/services/providers/xai/xaiResponsesTransport.ts` for subscription credentials, shared chat for API keys. The subscription proxy and private quota contract are CODE-owned, **UNRESOLVED** by the public announcement.
- `src/services/providers/zen/zenCallModel.ts` selects `src/services/providers/zen/zenResponsesTransport.ts` using model facts in `src/services/providers/zen/zenPins.ts`. Public newer endpoints do not authorize migrating the legacy endpoint/header; inspect the selected account.
- `src/services/providers/openaicompat/compatCallModel.ts` selects `src/services/providers/openaicompat/compatResponsesTransport.ts` for configured/probed Responses dialects (`src/services/providers/openaicompat/compatProbe.ts`). A custom URL alone does not establish the dialect.
