# Shared runtime and family-specific wires

Source map read 2026-10-08. All paths in the table are relative to `src/services/providers/`. These are owners to open, not a claim that every account uses one dialect.

`openaicompat/compatChatCallModel.ts` owns the shared call-model runtime. `openaicompat/compatChatClient.ts` owns Chat Completions HTTP/SSE and the `CompatStreamEvent`/`CompatFault` contracts. `openaicompat/compatWire.ts` builds family extras. `zai/zaiCodec.ts` maps shared chat messages and tools. Preserve role-labelled messages, nested function tools and `tool_call_id` correlation.

| Family | Dispatch and wire | Usage/billing owner |
|---|---|---|
| Moonshot/Kimi | `moonshot/moonshotCallModel.ts`; shared chat; credential resolution keeps platform-key and coding-sign-in endpoints distinct | `moonshot/moonshotUsageState.ts`: key balance and managed coding usage |
| DeepSeek | `deepseek/deepseekCallModel.ts`; shared chat and its own extras | `deepseek/deepseekUsageState.ts`: account balance |
| xAI | `xai/xaiCallModel.ts`; shared chat for keys, `xai/xaiResponsesTransport.ts` for subscription credentials | `xai/xaiUsageState.ts`: subscription credits; team usage and balance through a separate management key |
| Meta | `meta/metaCallModel.ts`; shared chat | `meta/metaUsageState.ts`, then the common usage facade; do not accept a missing account meter without checking current vendor management/billing documentation |
| Z.AI | `zai/zaiCallModel.ts`, `zai/zaiClient.ts`, `zai/zaiCodec.ts`: native chat road, not an Anthropic-compatible endpoint | `zai/zaiUsageState.ts`: Coding Plan quota |
| Gemini | `gemini/geminiCallModel.ts`: key road uses shared chat; OAuth road uses `gemini/geminiClient.ts` and `gemini/geminiCodec.ts` for native content streaming | `gemini/geminiUsageState.ts`: rate/window observations; inspect the project's current billing APIs before claiming no meter |
| Hugging Face | `huggingface/huggingfaceCallModel.ts`; shared chat with the resolved Hub credential and carrier slug | `huggingface/huggingfaceUsageState.ts`: account facts and rate observations; inspect current billing APIs for account spend |
| Custom endpoint | `openaicompat/compatCallModel.ts`; configured shared-chat endpoint, possibly keyless | `providerUsage.ts`: session spend and the configured endpoint's available facts |
| Local | `local/localCallModel.ts`: discovered server profile; `local/ollamaChatTransport.ts` for the native Ollama wire | `local/localDiscovery.ts` and `providerUsage.ts`: served-model facts and measured session usage, not an invented hosted balance |

The facade `providerUsage.ts` is the display owner. When adding a meter, read the family's account resolver too: the observation belongs to that credential and endpoint. xAI's inference key and management key have different jobs; follow the optional-management-key shape instead of sending inference credentials to a billing host.

## Stream contract

The shared transport emits `served-model`, `reasoning-delta`, `text-delta`, `tool-call-fragment`, `usage`, `finish` and `stream-fault`. Tool fragments are index-keyed and accumulate once. `finish` preserves the raw provider reason; an unknown reason stays observable rather than becoming a fabricated truncation.

Faults carry a typed kind, code, provider words, retryability and optional status/wait facts. In-stream errors can follow HTTP 200. Missing finish/terminal data and malformed tool calls remain failures even when text arrived. The runtime settles received content and reports the fault; do not discard either.

`streamIdleBudget.ts` owns `RequestWaitV1`. Wait notifications are separate from stream deltas and terminal faults. Respect the provider's explicit retry wait first; a usage/reset observation remains a displayed fact. Preserve effort and supported reasoning replay on continuation, with no thinking-time guard.

Open `scripts/provider-compat/prove-compat-chat-transport.ts` for injected-fetch SSE cases, pathological chunking, tool fragments, usage spellings and error envelopes. Use the appropriate loopback route proof as well: testing the decoder alone does not prove dispatch, auth refresh or settlement.
