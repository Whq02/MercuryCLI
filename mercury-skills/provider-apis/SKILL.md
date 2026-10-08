---
name: provider-apis
description: Use when building or changing a Mercury model-provider road, or choosing its request shapes, streaming, tools, caching or usage reader. Not for account sign-in, choosing a model in the UI or unrelated SDKs.
argument-hint: "[provider road or task]"
---
# Provider APIs

Work from the checkout, not a remembered SDK example. First name the provider, account kind, configured endpoint, selected model and served model. Read the owning request builder, transport, replay codec and usage reader before changing any of them. Vendor documentation describes a protocol; the source tells you which protocol this account actually uses.

A request such as “fix encrypted reasoning replay on Mercury's OpenRouter road” loads this skill. “How do I sign in to an account?” does not: use Mercury's documentation and the `/logins` or `/accounts` surface.

## Resolve the road

- Start at `src/services/providers/callModelRouter.ts`; classification lives in `src/services/providers/idSpaces.ts` and `src/services/providers/routeLaw.ts`. Follow the resolved verdict to its call-model entry, never guess a provider from the displayed label.
- Qualified `compat/`, `openrouter/`, `huggingface/` and `local/` namespaces win before bare prefixes. `canonicalWireModelId` validates the inner grammar and removes Mercury's carrier prefix and context annotation, not the provider's own slug.
- Bare `gpt-` routes to OpenAI; `kimi-`/`moonshot-` to Moonshot; `deepseek-` to DeepSeek; `grok-` to xAI; `muse-spark-` to Meta; `glm-` to Z.AI; `gemini-` to Gemini. Read the current declarations for aliases and live-list admission.
- An unknown ID is not an Anthropic identity. `src/services/providers/homeLaneAdmission.ts` owns an explicitly configured gateway or model pin's admission. A failed route never falls through to another provider.
- Keep the endpoint and credential together across refresh. An API key and a subscription sign-in can use different transports, not merely different headers. Read `references/models.md` before naming an ID, capability, price or limit.

## Read the implementation you will change

All paths below are checkout paths, not paths under this skill's extracted base directory. Reference paths are relative to that supplied base.

| Road | Start here | Detail |
|---|---|---|
| Anthropic Messages | `src/services/providers/anthropic/streamCore.ts`, `requestParams.ts`, `cacheAndUsage.ts` in the same directory | `references/anthropic-messages.md` |
| OpenAI Responses | `src/services/providers/openai/openaiCallModel.ts`, `openaiClient.ts`, `openaiWire.ts`, `responsesBridge.ts` in the same directory | `references/openai-responses.md` |
| OpenRouter Responses and routing preferences | `src/services/providers/openrouter/openrouterResponsesTransport.ts`, `openrouterRoutingPolicy.ts` in the same directory | `references/openai-responses.md` |
| Shared chat runtime and native variants | `src/services/providers/openaicompat/compatChatCallModel.ts`, `compatChatClient.ts`, `compatWire.ts` in the same directory | `references/chat-completions.md` |
| Usage and billing | `src/services/providers/providerUsage.ts`; each family's reader is listed in the references | Never turn a reading into admission policy |

## Keep Mercury's laws

- The provider decides on usage. A usage window, balance or reset time is information for `/usage`, the status row and the model picker, never a door that prevents sending. On every retry or resume, refresh the sign-in when needed, refresh the usage reading, send the request and show the provider's answer. A served request clears a remembered refusal; a manual resume asks the provider now.
- A 429's words and wait follow the explicit `Retry-After` first. Say a plan window was reached only when the response body identifies that window; a distant band header alone cannot turn a seconds-long rate limit into a days-long pause. Read the family's classifier and `src/services/api/retryAfter.ts`, not a display countdown, to decide what the answer means.
- Every family must show a meter. Trace the current reader through `providerUsage.ts`; inspect the vendor's management, billing and admin APIs before claiming no account meter exists. A second credential is optional beside the inference key when the billing API needs one. Report an unmeasured or unavailable field honestly, never as zero or as permission to block work.
- Keep the selected effort and thinking capability. Do not add a thinking-time guard, cut the output ceiling to hide a fault, or downgrade effort on continuation. Preserve signed or encrypted reasoning only on the route that can replay it. Keep the full tool set available to local models too.
- Preserve tool/result identity, ordered replay, terminal-state truth and measured usage. A malformed tool call is refused before execution; a stream without its required terminal event is not success. Partial content and the provider's fault must both survive.
- `CompatStreamEvent` and `CompatFault` in `compatChatClient.ts` describe shared transport output; `RequestWaitV1` in `src/services/providers/streamIdleBudget.ts` describes waits. The call-model layer maps these to `src/types/wire.ts` and `src/types/message.ts`: transport events, waits and terminal faults are different facts, not free-form status strings. Read the selected road's equivalent union before adding an event.

## Prove the change

Read `references/proof-road.md`. Reproduce a product defect against the base, then prove the changed request and answer over a loopback fixture with a scratch home. Check the whole route, not only a JSON builder: tools, replay, termination, cancellation, refusal, retry and usage settlement. A fixture proof is not a live-provider compatibility claim; a live model call needs the operator's explicit authorisation.

Run the suites whose `# gate-watch:` lines name the touched files, the identity census for changed words and the generated-asset check when source assets move. Mechanical baselines and dialect request bytes move through their recorders only, with each changed expectation explained; never hand-edit a golden to make a red disappear.

## Vendor appendix

`references/live-sources.md` is a dated index to vendor references, not a frozen catalogue. Fetch the relevant current pages before making vendor claims and record the date, account kind and endpoint they cover. For the Anthropic subscription client contract, read the vendor CLI version on release day, then stamp `ANTHROPIC_CLIENT_CONTRACT_AS_OF` in `src/constants/oauth.ts` and run `scripts/ops/prove-client-contract-clock.ts`.
