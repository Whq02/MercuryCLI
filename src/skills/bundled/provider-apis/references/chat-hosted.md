# Hosted provider/account notes

Historical CODE map, 2026-10-26. Paths are relative to `src/services/providers/`; dated vendor URLs and reading limits are in `live-sources.md`. These are implementation notes, not account-access guarantees. Identity grammar belongs to the classifier/canonicalizer, not this list.

## OpenRouter

`openrouter/openrouterCallModel.ts`, `openrouter/openrouterCache.ts`, `openrouter/openrouterRoutingPolicy.ts`: select Responses or shared chat before editing. Chat attaches explicit cache breakpoints only for supported upstream models; effort comes from the catalogue. `openrouter/openrouterUsageState.ts` reads active-key budgets and inline cost. The Responses reference covers mixed-upstream replay recovery and Mercury's stricter provider preferences.

## Hugging Face

`huggingface/huggingfaceCallModel.ts`: Hub router credentials, provider/policy-qualified slug, optional `X-HF-Bill-To`, token ceiling and streamed usage. Billing can target an organization or resource group. `huggingface/huggingfaceUsageState.ts` reads identity/plan facts and rates; whoami is not a complete spend meter. Inspect current billing sources before asserting no account-spend API exists.

## Nous Portal

`nous/nousCallModel.ts`, `nous/nousCatalogue.ts`, `nous/nousOauth.ts`: inference host, qualified slug and catalogue-supported efforts are separate from OAuth account credit. `nous/nousUsageState.ts` owns that credit reader. **UNRESOLVED:** Portal OpenAPI was robots-refused; public Hermes auth constants corroborate the host defaults only, not catalogue effort or subscription-credit fields.

## OpenCode Zen

`zen/zenCallModel.ts`, `zen/zenPins.ts`, `zen/zenResponsesTransport.ts`: per-model chat/Responses selection, session header and preserved Kimi history. `zen/zenUsageState.ts` owns Go windows and session spend. The public page lists newer `/inference/...` URLs; this does not authorize migrating Mercury's legacy `/zen/v1` endpoint or prove it still serves every account. Legacy admission/header and private Go meters remain CODE contracts, **UNRESOLVED** externally.

## Together

`together/togetherCallModel.ts`, `together/togetherAccounts.ts`, `together/togetherPins.ts`: hybrid reasoning toggle versus effort, streamed usage, and flat/nested cache counters. `providerUsage.ts` presents recorded session spend. Organization billing usage is a per-org beta, with 404 when access is absent; session spend is not account balance.

## Groq

`groq/groqCallModel.ts`, `groq/groqPins.ts`: include_reasoning versus parsed reasoning_format is model-specific. `groq/groqUsageState.ts` reads separate request/day and token/minute limits with their reset/remaining headers. Its 400 spend-cap classification is CODE policy, not established by the public reasoning/rate pages.

## Cerebras

`cerebras/cerebrasCallModel.ts`, `cerebras/cerebrasPins.ts`: cache key, effort and streamed usage. Mercury omits the max-output field to avoid reserving the full ceiling; the provider can still reserve an estimate. Omission does not mean zero reservation. `cerebras/cerebrasUsageState.ts` owns observed retry waits and session spend; uncached and total TPM buckets differ.

## Fireworks

`fireworks/fireworksCallModel.ts`, `fireworks/fireworksPins.ts`: canonical model/router IDs, session affinity, reasoning replay, token ceiling and streamed usage. Mercury's minimal→low mapping is implementation policy, not a universal model guarantee. `fireworks/fireworksUsageState.ts` distinguishes prompt, cache-adjusted prompt, generated and uncached-prompt limit headers; cache-adjusted limits are not interchangeable with Elastic Burst.

## Melious

`melious/meliousCallModel.ts`, `melious/meliousCatalogue.ts`: send the selected catalogue-supported effort and retain requested flavor. The vendor folds some levels on some models; do not fold them globally in Mercury. Streaming requires DONE, preserves railguard finish reasons and classifies in-stream errors. `billing_hold_creation_failed` is transient before output, not permission to retry arbitrary billing/quota refusals. `melious/meliousUsageState.ts` owns rate observations, EUR billing_cost and environment_impact; do not settle EUR into a USD cost field.

## OrcaRouter

`orcarouter/orcarouterCallModel.ts`, `orcarouter/orcarouterCatalogue.ts`: opt in to per-request cost, retain affinity and model-resolution observations. `orcarouter/orcarouterUsageState.ts` owns dashboard usage/subscription readers. Public compatibility and cost docs establish opt-in usage.cost_usd; exact dashboard JSON and fallback-model headers are CODE/account contracts, **UNRESOLVED** publicly. No reported cost means unknown, not free.
