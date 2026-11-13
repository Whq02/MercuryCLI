# Custom, local and rented engines

Paths are relative to `src/services/providers/` unless prefixed with `src/` (code map 2026-10-26; TensorFold **CODE inspected 2026-11-13**; engine URLs in `live-sources.md`). Verify the actual engine version and chat template rather than trusting an OpenAI-compatible label.

- **Compat & Responses:** `openaicompat/compatCallModel.ts`, `openaicompat/compatAccounts.ts`, `openaicompat/compatProbe.ts`, `openaicompat/compatWire.ts` and `openaicompat/compatPrefixCache.ts` own configured/rented endpoints, dialect probing and prefix-cache reuse; Responses uses `openaicompat/compatResponsesTransport.ts`.
- **TensorFold:** `local/localDiscovery.ts`, `local/tensorfoldHealth.ts`, `local/tensorfoldUsage.ts`, `src/services/tensorfold/serve.ts`, `src/services/tensorfold/adapter/serve.ts` (Windows `llama.cpp` adapter), `src/services/lan/pairing.ts`, `src/services/lan/announcer.ts` and `src/services/host/tensorfoldPod.ts` own Metal/CUDA servers, LAN pairing and rented pods.
- **vLLM:** discovered models, chat template and supported reasoning effort govern request assembly.
- **SGLang:** uses `model_info` and `chat_template_kwargs` for thinking/history (**UNRESOLVED** across all model templates; check engine/model version).
- **llama.cpp:** `slots`/`props`, `cache_prompt` and template effort come from the server profile (`props` vision support is distinct from model-name heuristics; slots never authorize cross-conversation replay).
- **Ollama:** `local/ollamaChatTransport.ts` owns native `/api/chat`, `think` and context options (`truncate`/`num_batch` are CODE choices).
- **LM Studio:** model loading is a separate REST call; discover the served model after load.

`local/localCallModel.ts`, `local/localDiscovery.ts`, `local/localWindow.ts` and `src/constants/localPromptProfile.ts` own served-model/window state and the local prompt profile; `local/toolDialect.ts` and `local/toolCallMarkup.ts` supply text tool-call markup when native tool calling is absent or deferred tools are text-declared. `src/services/host/vendors/client.ts` and `src/services/host/costs.ts` track rented compute/storage spend separately from token usage (`src/utils/modelCost.ts`) and prefix-cache reuse.
