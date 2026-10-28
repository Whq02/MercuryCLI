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
- Qualified `compat/`, `openrouter/`, `orcarouter/`, `huggingface/`, `local/`, `google/` (non-Gemini roster rows on a Google sign-in), `nous/`, `zen/`, `together/`, `groq/`, `melious/`, `cerebras/` and `fireworks/` namespaces win before bare prefixes. `canonicalWireModelId` validates the inner grammar and removes Mercury's carrier prefix and context annotation, not the provider's own slug; `src/services/providers/fireworks/fireworksPins.ts` expands bare `fireworks/<slug>` shorthand to `accounts/fireworks/models/<slug>` (or `accounts/fireworks/routers/<slug>`).
- Bare `gpt-` routes to OpenAI; `kimi-`/`moonshot-` to Moonshot; `deepseek-` to DeepSeek; `grok-` to xAI; `muse-` (and alias `muse`) to Meta; `glm-` to Z.AI; `gemini-` to Gemini; `mistral-`/`ministral-`/`codestral-` to Mistral; `minimax-` to MiniMax; `command-`/`north-`/`c4ai-aya-` to Cohere; `qwen-`/`qwen3`/`qwen2`/`qwq-`/`qvq-` to Qwen. Read `src/services/providers/idSpaces.ts` for family aliases, non-chat exclusions and `LIVE_LIST_FAMILIES` admission.
- An unknown ID is not an Anthropic identity. `src/services/providers/homeLaneAdmission.ts` owns an explicitly configured gateway or model pin's admission. A failed route never falls through to another provider.
- Keep the endpoint and credential together across refresh. An API key and a subscription sign-in can use different transports, not merely different headers. Read `references/models.md` before naming an ID, capability, price or limit.

## Read the implementation you will change

All paths below are checkout paths, not paths under this skill's extracted base directory. Reference paths are relative to that supplied base.

| Road | Start here | Detail |
|---|---|---|
| HTTP transport and dispatchers | `src/utils/proxy.ts` (`buildApiAgentOptions`, `buildProxyAgentOptions`, `getApiDispatcher`, `getProxyAgent`), `src/utils/mtls.ts` (`getTLSFetchOptions`) | Pins HTTP/1.1 (`allowH2: false`); no connection bound unless `MERCURY_MAX_CONNECTIONS` pins one |
| Anthropic Messages | `src/services/providers/anthropic/streamCore.ts`, `requestParams.ts`, `cacheAndUsage.ts`, `anthropicClient.ts`, `anthropicWorkspace.ts` in the same directory | `references/anthropic-messages.md` |
| OpenAI Responses | `src/services/providers/openai/openaiCallModel.ts`, `openaiClient.ts`, `openaiWire.ts`, `responsesBridge.ts` in the same directory | `references/openai-responses.md` |
| OpenRouter, xAI subscription, OpenCode Zen and `compat/` Responses | `src/services/providers/openrouter/openrouterResponsesTransport.ts`, `src/services/providers/openrouter/openrouterRoutingPolicy.ts`, `src/services/providers/xai/xaiResponsesTransport.ts`, `src/services/providers/zen/zenResponsesTransport.ts`, `src/services/providers/openaicompat/compatResponsesTransport.ts` | `references/openai-responses.md` |
| Shared chat runtime, native variants (`zai/`, `gemini/`), rented and local engines | `src/services/providers/openaicompat/compatChatCallModel.ts`, `compatChatClient.ts`, `compatWire.ts`, `compatProbe.ts` in the same directory; `src/services/providers/local/localCallModel.ts`; `src/services/host/vendors/client.ts` | `references/chat-completions.md` |
| Tool-call gating, live tool rosters and conversation plan | `src/services/providers/toolCallGate.ts`, `src/services/providers/toolEconomy.ts`, `src/utils/toolSchemaCache.ts`, `src/utils/attachments/toolSchemaDelta.ts`, `src/utils/messages/apiPlan.ts` | Shared across every wire |
| Usage and billing | `src/services/providers/providerUsage.ts`; each family's reader is listed in the references | Never turn a reading into admission policy |

## Keep Mercury's laws

- The provider decides on usage. A usage window, balance or reset time is information for `/usage`, the status row and the model picker, never a door that prevents sending. On every retry or resume, refresh the sign-in when needed, refresh the usage reading, send the request and show the provider's answer. A served request clears a remembered refusal; a manual resume asks the provider now.
- A 429's words and wait follow the explicit `Retry-After` first. Say a plan window was reached only when the response body identifies that window; a distant band header alone cannot turn a seconds-long rate limit into a days-long pause. Read the family's classifier and `src/services/api/retryAfter.ts`, not a display countdown, to decide what the answer means.
- Every family must show a meter. Trace the current reader through `providerUsage.ts`; inspect the vendor's management, billing and admin APIs before claiming no account meter exists. A second credential is optional beside the inference key when the billing API needs one. Report an unmeasured or unavailable field honestly, never as zero or as permission to block work.
- Pin HTTP/1.1 on every API dispatcher (`allowH2: false` in `src/utils/proxy.ts` and `src/utils/mtls.ts`). Undici 8 defaults to HTTP/2 and provider edges accept it, multiplexing concurrent streams onto one session per origin where a refused stream, reset or `GOAWAY` under crewmate fan-out surfaces as `ERR_HTTP2_STREAM_ERROR` and a `fetch` request body is not replayable.
- Keep the selected effort and thinking capability. Do not add a thinking-time guard, cut the output ceiling to hide a fault, or downgrade effort on continuation. Preserve signed or encrypted reasoning only on the route that can replay it. Replay the recorded tool roster across restarts or resumes onto a new build (`src/services/providers/toolEconomy.ts`) so the bound prefix holds and signed thinking survives; deliver MCP `notifications/tools/list_changed` and `/mcp reconnect` schema changes for bound tools as `tool_schema_delta` attachments (`src/utils/attachments/toolSchemaDelta.ts`) while unreferenced deferred tools take the live schema (`src/utils/toolSchemaCache.ts`). Keep the full tool set available to local models too.
- Preserve tool/result identity, ordered replay, terminal-state truth and measured usage. `src/services/providers/toolCallGate.ts` gates every tool call before execution: a malformed call with a pairable call ID and tool name (`schema`, `unknown-tool`, `invalid-json`, `not-an-object` in `refusalAnswersAsToolResult`) is answered by an error `tool_result` on the next request instead of dropping the turn, while an unpairable call (`missing-id`, `duplicate-id`, `provider-malformed`) settles as a visible refusal note handed to the model on its next user turn. `src/utils/messages/apiPlan.ts` (`mergeAdjacentUsers`) merges consecutive user text rows only across a turn cut (`src/utils/messages/turnCut.ts`) so the operator's ask stays its own verbatim last item on every wire and resume text stays separate from tool results. A stream without its required terminal event is not success; partial content and the provider's fault must both survive.
- `CompatStreamEvent` and `CompatFault` in `compatChatClient.ts` describe shared transport output; `RequestWaitV1` in `src/services/providers/streamIdleBudget.ts` describes waits. The call-model layer maps these to `src/types/wire.ts` and `src/types/message.ts`: transport events, waits and terminal faults are different facts, not free-form status strings. Read the selected road's equivalent union before adding an event.

## Prove the change

Read `references/proof-road.md`. Reproduce a product defect against the base, then prove the changed request and answer over a loopback fixture with a scratch home. Check the whole route, not only a JSON builder: tools, replay, termination, cancellation, refusal, retry and usage settlement. A fixture proof is not a live-provider compatibility claim; a live model call needs the operator's explicit authorisation.

Run the suites whose `# gate-watch:` lines name the touched files, the identity census for changed words and the generated-asset check when source assets move. Mechanical baselines and dialect request bytes move through their recorders only, with each changed expectation explained; never hand-edit a golden to make a red disappear.

## Vendor appendix

`references/live-sources.md` is a dated index to vendor references, not a frozen catalogue. Fetch the relevant current pages before making vendor claims and record the date, account kind and endpoint they cover. For the Anthropic subscription client contract, read the vendor CLI version on release day, then stamp `ANTHROPIC_CLIENT_CONTRACT_AS_OF` in `src/constants/oauth.ts` and run `scripts/ops/prove-client-contract-clock.ts`.
