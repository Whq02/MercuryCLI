# Custom, local and rented engines

Historical CODE map, 2026-10-26; paths relative to `src/services/providers/` unless prefixed with `src/`. Engine URLs and reading limits are in `live-sources.md`. Verify the installed engine version and model template, not just an OpenAI-compatible label.

`openaicompat/compatCallModel.ts`, `openaicompat/compatAccounts.ts`, `openaicompat/compatProbe.ts`, `openaicompat/compatWire.ts` and `openaicompat/compatPrefixCache.ts` own configured/rented endpoints, dialect detection and cache reuse. Responses uses `openaicompat/compatResponsesTransport.ts`; a chat decoder is not a Responses codec.

- vLLM: discovered models, template and supported reasoning effort decide the request.
- SGLang: Mercury's profile uses model_info and chat_template_kwargs for thinking/history. **UNRESOLVED** as universal template semantics: inspect the actual engine/model version.
- llama.cpp: slots/props, cache_prompt and template effort are profile facts; props' vision capability is distinct from a model name suggesting vision. A slot does not authorize cross-conversation replay.
- Ollama: `local/ollamaChatTransport.ts` owns native api/chat, think and context options. Historical truncate/num_batch settings are CODE choices, not established by the public chat page as a universal contract.
- LM Studio: model loading is a separate REST effect, not a chat completion. Discover the served model after load.

`local/localCallModel.ts`, `local/localDiscovery.ts` and `local/localWindow.ts` own served-model/window observations. `local/toolDialect.ts` and `local/toolCallMarkup.ts` provide tool markup when native calling is absent; local does not mean tools disappear.

`src/services/host/vendors/client.ts` and `src/services/host/costs.ts` own rented compute/storage observations. Separate them from token usage and prefix-cache reuse. Mercury's local token rate in `src/utils/modelCost.ts` is not zero hardware or rental cost; remote execution origins are not local merely because a compatibility URL serves them. A pricing-page link is not a current quote.
