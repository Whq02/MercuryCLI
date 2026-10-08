# Anthropic Messages in Mercury

Source map read 2026-10-08. These are checkout paths; vendor links are in `live-sources.md` and must be checked for the account and date of the change.

## Owners

- `src/services/providers/anthropic/streamCore.ts` builds and consumes the streaming Messages call. `src/services/api/client.ts` constructs the `@anthropic-ai/sdk` client; keep that SDK on the Anthropic transport rather than introducing it into other families' HTTP roads.
- `src/services/providers/anthropic/requestParams.ts` owns extra-body assembly, model beta selection, effort and cache-lifetime decisions. `src/services/providers/anthropic/cacheAndUsage.ts` owns cache-breakpoint placement, system-block assembly and usage folds.
- `src/services/providers/anthropic/messageParams.ts` maps content blocks. `src/services/providers/anthropic/thinkingBinding.ts` and `src/services/providers/anthropic/boundPrefixRecord.ts` own signed thinking and the prefix it belongs to. Read these before changing history replay or a cached prefix.
- `src/services/providers/anthropic/anthropicUsageState.ts` refreshes subscription usage; `src/services/anthropicLimits.ts` owns observed windows. `src/services/providers/providerUsage.ts` presents those facts alongside session spend. Usage is information, not a dispatch lock.

## Request and settlement

Follow the actual `beta.messages.create` call: model, maximum output, system blocks, messages, tools, thinking and output configuration are assembled by Mercury. Preserve `tool_use`/`tool_result` pairing by `tool_use_id`. Preserve content-block arrays and the signed-thinking binding; text serialization is not interchangeable with replaying those blocks.

Read the current cache placement before editing it: the conversation has one message-level breakpoint, and the system prefix has its own cacheable blocks. The cache clock chooses the eligible lifetime. A retry is another request, not a guaranteed cheap continuation. Keep cache reads, cache writes and uncached input distinct; stream usage updates replace the matching counters while cross-turn settlement accumulates them.

## Subscription client contract

`src/constants/oauth.ts` owns `ANTHROPIC_CLIENT_CONTRACT_VERSION` and `ANTHROPIC_CLIENT_CONTRACT_AS_OF`. This is contract data for the subscription endpoint, not Mercury's version or user-agent identity. A release-day change reads the vendor CLI's published version, updates the contract data if needed, stamps the check date and runs `scripts/ops/prove-client-contract-clock.ts`. Do not advance the date without that reading.

Use `scripts/api/authRetryFixture.ts` for authentication recovery and `scripts/lib/fixtureApi.ts` for captured Messages requests. Cache and replay changes also need the dialect and prefix proofs named in `proof-road.md`.
