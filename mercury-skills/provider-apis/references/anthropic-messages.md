# Anthropic Messages in Mercury

Source map read 2026-10-25. These are checkout paths; vendor links are in `live-sources.md` and must be checked for the account and date of the change.

## Owners

- `src/services/providers/anthropic/streamCore.ts` builds and consumes the streaming Messages call (`POST /v1/messages`). `src/services/api/client.ts` constructs Mercury's `AnthropicClient` (`src/services/providers/anthropic/anthropicClient.ts`, backed by `src/services/providers/anthropic/anthropicStream.ts` and `src/services/providers/anthropic/anthropicWire.ts`); keep that client on the Anthropic transport rather than introducing it into other families' HTTP roads.
- `src/services/providers/anthropic/requestParams.ts` owns extra-body assembly, model beta selection, `output_config.effort` (`low`, `medium`, `high`, `xhigh`, `max`) and cache-lifetime decisions. `src/services/providers/anthropic/cacheAndUsage.ts` owns cache-breakpoint placement, system-block assembly and usage folds.
- `src/services/providers/anthropic/messageParams.ts` maps content blocks. `src/services/providers/anthropic/thinkingBinding.ts`, `src/services/providers/anthropic/thinkingDisplay.ts`, `src/services/providers/anthropic/boundPrefixRecord.ts` and `src/services/providers/anthropic/prefixLedger.ts` own signed `thinking` (`signature`) and `redacted_thinking` (`data`) blocks, `thinking.display` (`summarized` or `omitted`), and the prefix they belong to. Read these before changing history replay or a cached prefix.
- `src/services/providers/anthropic/anthropicUsageState.ts` refreshes subscription usage; `src/services/anthropicLimits.ts` owns observed windows. `src/services/providers/providerUsage.ts` presents those facts alongside session spend. Usage is information, not a dispatch lock.

## Request and settlement

Follow the actual `beta.messages.create` call: model, `max_tokens`, `system` blocks, `messages`, `tools`, `thinking` (`{ type: "adaptive", display }` on adaptive models, `{ type: "between_tools" }` where supported, `{ type: "enabled", budget_tokens }` on legacy extended-thinking models, or `{ type: "disabled" }` when the model allows turning thinking off; always-on models omit `thinking` when thinking is switched off so adaptive thinking still runs) and `output_config` (`effort`, `format`) are assembled by Mercury. Preserve `tool_use`/`tool_result` pairing by `tool_use_id`. Preserve content-block arrays and the signed-thinking binding; text serialization is not interchangeable with replaying those blocks.

Streaming (`stream: true`) emits `message_start`, indexed `content_block_start` / `content_block_delta` (`text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`) / `content_block_stop`, `message_delta` (whose `usage` token counts are cumulative) and `message_stop`, plus `ping` and in-stream `error` events (such as `overloaded_error`, equivalent to HTTP 529).

Read the current cache placement before editing it: the conversation has one message-level breakpoint, and the system prefix has its own cacheable blocks (`cache_control: { type: "ephemeral", ttl?: "5m" | "1h" }`; up to 4 explicit breakpoints across `tools`, `system`, and `messages`, with a 20-block lookback window, alongside the API's top-level automatic `cache_control` option). The cache clock chooses the eligible lifetime. A retry is another request, not a guaranteed cheap continuation. Keep `cache_read_input_tokens`, `cache_creation_input_tokens` (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`) and uncached `input_tokens` distinct; stream usage updates replace the matching counters while cross-turn settlement accumulates them.

## Subscription client contract

`src/constants/oauth.ts` owns `ANTHROPIC_CLIENT_CONTRACT_VERSION` and `ANTHROPIC_CLIENT_CONTRACT_AS_OF`. This is contract data for the subscription endpoint, not Mercury's version or user-agent identity. A release-day change reads the vendor CLI's published version, updates the contract data if needed, stamps the check date and runs `scripts/ops/prove-client-contract-clock.ts`. Do not advance the date without that reading.

Use `scripts/api/authRetryFixture.ts` for authentication recovery and `scripts/lib/fixtureApi.ts` for captured Messages requests. Cache and replay changes also need the dialect and prefix proofs named in `proof-road.md`.
