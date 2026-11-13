# Responses roads

## OpenAI

- `src/services/providers/openai/openaiCallModel.ts` owns settlement, `src/services/providers/openai/openaiClient.ts` HTTP, `src/services/providers/openai/openaiWire.ts` typed items/SSE/faults, and `src/services/providers/openai/responsesBridge.ts` stateless request assembly and ordered replay.
- Keep `store: false` and replay captured reasoning, message and `function_call` items in recorded order (`previous_response_id` never replaces Mercury's stateless transcript, and foreign-provider thinking never replays as OpenAI reasoning). Preserve assistant phase, correlate `function_call_output` by `call_id`, and use flat function tool definitions.
- Check model-generation support before changing effort, reasoning mode, `configuration_update` or cache retention fields. Settle each tool call once from its done item (falling back to accumulated deltas if needed), keep unknown items observable, distinguish `completed` / `failed` / `incomplete` terminals (missing terminal = fault), and settle reported input/cached/output/reasoning usage once.
- `src/services/providers/openai/openaiUsageState.ts` and `src/services/providers/openai/openaiLimitState.ts` track subscription/header windows and refusals (distinct from org API billing).

## OpenRouter

- `src/services/providers/openrouter/openrouterCallModel.ts` selects Responses vs chat; `src/services/providers/openrouter/openrouterResponsesTransport.ts` owns stateless Responses and replay; `src/services/providers/openrouter/openrouterCache.ts` separates top-level Responses cache markers from chat block breakpoints.
- Mixed-upstream recovery (`scripts/provider-compat/prove-openrouter-mixed-upstream-retry.ts`): a single matching encrypted-reasoning HTTP 400 retries once with only encrypted reasoning input items stripped, preserving text, calls, outputs and order; other 400s and a second 400 do not retry.
- `src/services/providers/openrouter/openrouterRoutingPolicy.ts` enforces Mercury's `require_parameters` / `data_collection`, fallback and ZDR preferences without crossing account families; `src/services/providers/openrouter/openrouterUsageState.ts` reads active-key budgets and limit sources.

## Other account variants

- **xAI:** `src/services/providers/xai/xaiCallModel.ts` routes subscription credentials to `src/services/providers/xai/xaiResponsesTransport.ts` and API keys to shared chat (subscription proxy/quota fields are CODE-owned, **UNRESOLVED** publicly).
- **OpenCode Zen:** `src/services/providers/zen/zenCallModel.ts` routes per `src/services/providers/zen/zenPins.ts` to `src/services/providers/zen/zenResponsesTransport.ts`; do not migrate legacy endpoints/headers from newer public docs without account verification.
- **Compat:** `src/services/providers/openaicompat/compatCallModel.ts` routes configured or probed (`src/services/providers/openaicompat/compatProbe.ts`) Responses endpoints to `src/services/providers/openaicompat/compatResponsesTransport.ts`.
