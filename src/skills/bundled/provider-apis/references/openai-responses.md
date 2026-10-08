# Responses roads in Mercury

Source map read 2026-10-08. Vendor pages are indexed in `live-sources.md`; an OpenAI-shaped request does not establish which account endpoint serves it.

## OpenAI

- `src/services/providers/openai/openaiCallModel.ts` owns call-model integration and settlement. `src/services/providers/openai/openaiClient.ts` owns HTTP. `src/services/providers/openai/openaiWire.ts` owns typed request items, the Responses stream fold and fault mapping.
- `src/services/providers/openai/responsesBridge.ts` owns request construction and ordered stateless replay. Keep `store:false`, the requested encrypted reasoning, assistant `phase`, and function call/output correlation by `call_id`. Tools are flat function objects, not Chat Completions' nested `function` objects.
- Replay captured output items in their recorded order. A turn without a usable record derives text and tool items from Mercury's content blocks; another provider's thinking is not an OpenAI replay item. Do not substitute `previous_response_id` storage for the stateless contract.
- A tool call settles once from its done item, with accumulated arguments available when the item omits them. Unknown items remain observable; malformed arguments and a missing completed/failed/incomplete terminal event cannot masquerade as success.
- `src/services/providers/openai/openaiUsageState.ts` exposes the subscription usage reader; `src/services/providers/openai/openaiLimitState.ts` holds the observed refusal. `src/services/providers/providerUsage.ts` presents windows, credits and spend. A recorded window is not permission to refuse the next request.

## OpenRouter

`src/services/providers/openrouter/openrouterCallModel.ts` selects the family profile. Read `src/services/providers/openrouter/openrouterResponsesTransport.ts` rather than assuming this road is always Chat Completions: it builds Responses input, folds events back into the shared stream vocabulary and records replay items.

Its mixed-upstream recovery is narrow: a matching HTTP 400 about encrypted reasoning from multiple providers earns one replay after removing only encrypted reasoning input items. Text, function calls, outputs and their ordering remain. Other 400s do not take that road, and a second refusal is the answer. `scripts/provider-compat/prove-openrouter-mixed-upstream-retry.ts` captures the two request bodies over loopback.

`src/services/providers/openrouter/openrouterRoutingPolicy.ts` maps `routing.openrouter` to provider preferences: data collection denied and required parameters enabled by default, with explicit fallback and zero-data-retention settings preserved. Upstream routing preferences are not permission for Mercury to switch account families after a fault.

`src/services/providers/openrouter/openrouterUsageState.ts` reads key usage and rate facts. The current reader, the active key and the observation's freshness must agree before painting a balance; none of those readings closes the request door.

## xAI subscription variant

`src/services/providers/xai/xaiCallModel.ts` selects `src/services/providers/xai/xaiResponsesTransport.ts` for the subscription road; the API-key road uses shared chat. Inspect that selector and the credential's endpoint before changing a request. Its usage owners are listed in `chat-completions.md`.
