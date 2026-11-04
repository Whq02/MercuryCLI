# Native provider/account notes

Historical CODE map, 2026-10-26, except the dated Mistral correction. Paths are relative to `src/services/providers/`. Vendor readings and their limits are in `live-sources.md`; inspect the selected owner and current page before altering its contract.

## Moonshot / Kimi

`moonshot/moonshotCallModel.ts`, `moonshot/moonshotAccounts.ts`, `openaicompat/compatWire.ts`, `openaicompat/kimiReplay.ts`. API keys and regional coding sign-ins bind different endpoints. K3 always thinks, omits temperature and uses effort plus `max_completion_tokens`; K2.x uses `thinking` and its `keep` setting. Preserved Thinking replays historical `reasoning_content`. Dynamic tool declarations are a system row with tools and no content. Cache counters belong under `usage.prompt_tokens_details`, not an invented top-level cache-write field. `moonshot/moonshotUsageState.ts` separates API-key balance from managed coding windows/Extra Usage. Private subscription readers are CODE contracts, not proved by the public balance API.

## DeepSeek

`deepseek/deepseekCallModel.ts`, `openaicompat/compatWire.ts`: thinking toggle, effort only while thinking, `max_tokens`, streamed usage and separate cache hit/miss counters. `deepseek/deepseekUsageState.ts` reads account balance. Stripping historical `reasoning_content` is Mercury's replay policy; **UNRESOLVED** as a current vendor requirement. The old reasoning-guide URL now leads to a quickstart, not proof of that replay rule.

## xAI

`xai/xaiCallModel.ts` selects shared chat for API keys and `xai/xaiResponsesTransport.ts` for subscription credentials. Chat settlement reconciles reasoning outside `completion_tokens` using total minus input, and preserves `cost_in_usd_ticks`. `xai/xaiUsageState.ts` separates subscription credit from team billing through an optional management key. Public management docs establish a separate credential/host; subscription proxy and private quota fields remain CODE/account-specific, **UNRESOLVED** externally.

## Meta

`meta/metaCallModel.ts`, `meta/metaAccounts.ts`: chat has no readable/replayed reasoning; do not synthesize it. Model-specific effort matters: the reasoning page supports max on Standard Spark, not Contributor; none is refused. Structured output uses `json_schema`. `meta/metaLogin.ts` and `meta/metaUsageState.ts` own device sign-in and subscription fields. Public subscriptions/auth pages do not establish the `subs_tier_name`/`subs_usage` response shape (**UNRESOLVED**).

## Z.AI

`zai/zaiCallModel.ts`, `zai/zaiClient.ts`, `zai/zaiCodec.ts`: native chat, not Anthropic compatibility. General and Coding Plan keys have separate endpoints. Thinking/clear-thinking, effort and tool streaming are model-dependent; do not generalize one GLM generation's vocabulary. `zai/zaiUsageState.ts` owns coding windows and MCP quota. Public plan windows do not certify private quota response fields.

## Gemini

`gemini/geminiCallModel.ts`, `gemini/geminiClient.ts`, `gemini/geminiCodec.ts`: API-key, OAuth and Google-plan roads preserve native signed parts. A trailing empty thought-signature part is emitted as withheld reasoning before answer text so stop_reason remains on the answer. The OpenAI compatibility profile is not interchangeable with the native codec. `gemini/geminiPlanQuota.ts` and `gemini/geminiUsageState.ts` own Code Assist roster quota and observations. Current public signature guidance describes Interactions API state; the legacy generateContent codec and private quota fields remain CODE contracts. Exhaustive claims that API-key usage APIs do not exist are **UNRESOLVED**.

## Mistral

**CODE inspected 2026-11-04:** `mistral/mistralCallModel.ts` ([source](https://github.com/Whq02/MercuryCLI/blob/72f853cebbaf9c2c41cc8fd85c4232e08a4b0079/src/services/providers/mistral/mistralCallModel.ts)) builds effort from `mistral/mistralCatalogue.ts` model facts and the selected effort. Thinking off sends none only when supported, otherwise the first supported effort; unsupported effort is omitted. It is not a universal high/none toggle.

**LIVE page read 2026-11-04:** [Mistral reasoning](https://docs.mistral.ai/studio/conversations/reasoning) makes effort model-specific: hosted GLM 5.3 supports low/high/max, not none; Large 4 has a different ladder. An API-wide enum is not each model's vocabulary. `mistral/mistralPins.ts` holds dated per-model facts; do not change the user's selected effort to fit a copied recipe.

`openaicompat/compatChatClient.ts` decodes thinking/text chunks and string answer deltas. `mistral/mistralUsageState.ts` separates inference-key identity from optional Admin API spend/rate readings; the admin key is not an inference credential.

## Qwen

`qwen/qwenCallModel.ts`, `qwen/qwenAccounts.ts`, `qwen/qwenPins.ts`: preserve bound region/plan/workspace rather than replacing it with a generic compatible-mode URL. Thinking, preserved history, budget versus effort and dynamic tool-result declarations depend on that profile. `qwen/qwenUsageState.ts` presents session spend and region/plan facts. “Neither console has an API-key balance endpoint” is **UNRESOLVED**, not established by an inference page.

## MiniMax

`minimax/minimaxCallModel.ts`, `minimax/minimaxPins.ts`: `reasoning_split` separates reasoning content; replay retains historical reasoning. Toggle models use adaptive/disabled thinking, tunable models use effort without none. Classify `base_resp` even on HTTP 200: auth, balance and rate/window errors are not success envelopes. `minimax/minimaxUsageState.ts` owns token-plan windows plus session spend. The public M Plan page does not prove the private endpoint or an exhaustive console-only PAYG balance claim.

## Cohere

`cohere/cohereCallModel.ts`, `cohere/cohereAccounts.ts`, `cohere/coherePins.ts`: the compatibility API's high/none toggle is not a portable Mistral recipe. Structured output uses `json_object` with schema; omit unsupported parallel-tool controls. `providerUsage.ts` presents session spend. A missing balance endpoint on this compatibility API does not establish the absence of all organization billing APIs.
