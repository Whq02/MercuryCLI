Checked: 2026-09-15
# Compatible Chat Completions

- POST `{base}/chat/completions` with JSON and the account's bearer credential; configured/local endpoints may be keyless.
- Send `model`, role-labelled `messages`, `stream:true` and nested tools: `{type:"function",function:{name,description,parameters}}`.
- Return each assistant `tool_calls` result as a `role:"tool"` message with matching `tool_call_id`.
- Accumulate indexed tool-argument fragments from SSE `choices[0].delta`; validate JSON before execution.
- Require a recognised finish reason or `[DONE]`; neither truncation nor malformed calls count as success.

## Bases and differences
| Family | Public API base | Mercury behaviour |
|---|---|---|
| Kimi | https://api.moonshot.ai/v1 | Model-gated `reasoning_effort`; no temperature; separate OAuth coding endpoint |
| DeepSeek | https://api.deepseek.com | `thinking.type`; explicit `max_tokens` override |
| Z.AI | https://api.z.ai/api/paas/v4 | Separate Coding Plan base; native chat, never Anthropic compatibility |
| OpenRouter | https://openrouter.ai/api/v1 | `reasoning.effort` from model vocabulary |
| Gemini | https://generativelanguage.googleapis.com/v1beta/openai | Model-gated `reasoning_effort`; key or OAuth |
| Hugging Face | https://router.huggingface.co/v1 | Access token; no generic effort dial |
| Compat/local | Configured/discovered | Server-specific capabilities; omit Ollama `tool_choice` |

- Do not copy Mercury's DeepSeek effort placement: `compatWire.ts` nests `reasoning_effort` inside `thinking`; the current API requires a top-level sibling.
- Request `stream_options.include_usage` where supported. Mercury sends it on the shared client, not Z.AI; OpenRouter and DeepSeek supply final usage regardless.
- Read standard `prompt_tokens_details.cached_tokens`, Kimi `cached_tokens`, or DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` under `usage`; spellings can coexist.
- Preserve reasoning history only for the selected model's supported replay contract; do not generalise one family's rule.

Sources: [Kimi](https://platform.kimi.ai/docs/api/chat), [DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/), [Z.AI](https://docs.z.ai/api-reference/llm/chat-completion), [OpenRouter](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [Gemini](https://ai.google.dev/gemini-api/docs/openai), [HF](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion), [Ollama](https://docs.ollama.com/api/openai-compatibility), [Mercury](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/services/providers).
