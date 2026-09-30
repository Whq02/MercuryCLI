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
| xAI (Grok) | https://api.x.ai/v1 | `XAI_API_KEY` bearer; `reasoning_effort` on the reasoning models; usage carries `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` |
| Z.AI | https://api.z.ai/api/paas/v4 | Separate Coding Plan base; native chat, never Anthropic compatibility |
| OpenRouter | https://openrouter.ai/api/v1 | `reasoning.effort` from model vocabulary |
| Gemini | https://generativelanguage.googleapis.com/v1beta/openai | Model-gated `reasoning_effort`; key or OAuth |
| Hugging Face | https://router.huggingface.co/v1 | Access token; no generic effort dial |
| Compat/local | Configured/discovered | Server-specific capabilities; omit Ollama `tool_choice` |

- DeepSeek takes `reasoning_effort` (`low`/`high`/`max`) as a top-level field beside the `thinking` object, which carries `type` alone; Mercury sends it there, and omits the effort entirely when thinking is off.
- Request `stream_options.include_usage` where supported. Mercury sends it on the shared client, not Z.AI; OpenRouter and DeepSeek supply final usage regardless.
- xAI documents the OpenAI-shaped `POST /v1/chat/completions` (`model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `parallel_tool_calls`, `max_tokens`/`max_completion_tokens`, `reasoning_effort`, `response_format`) and `GET /v1/models` for the account's model list; its finish reasons are `stop`, `length` and `end_turn`. Team billing uses a separate bearer management key from the console's settings page (`Management Keys Read + Write` permission). Mercury accepts it through `/logins xai`, `/router key xai-management`, or `XAI_MANAGEMENT_API_KEY`; the inference key still serves inference.
- xAI billing (checked 2026-09-30): `GET https://api.x.ai/v1/api-key` with the inference bearer returns `team_id`. With the management bearer, `https://management-api.x.ai/v1/billing/teams/{team_id}` serves `GET /prepaid/balance` (`total.val`, signed USD cents: purchases are negative), `GET /postpaid/invoice/preview` (`billingCycle.year/month`, `coreInvoice.amountAfterVat`, `effectiveSpendingLimit`, amounts in cents), `GET /postpaid/spending-limits` (`spendingLimits.effectiveSl.val`, cents), and `POST /usage`. Usage takes `analyticsRequest` with `timeRange` (`startTime`/exclusive `endTime` in `YYYY-MM-DD HH:MM:SS`, IANA `timezone`), `timeUnit`, `values:[{name:"usd",aggregation:"AGGREGATION_SUM"}]`, `groupBy`, and `filters`; it returns `timeSeries[].dataPoints[].{timestamp,values}`. `limitReached` means query results were truncated, NOT that spending hit a limit. Prepaid credits are consumed before postpaid spending: never divide total team usage by a postpaid-only cap. Sources: [management keys](https://docs.x.ai/developers/rest-api-reference/management), [billing](https://docs.x.ai/developers/rest-api-reference/management/billing), [key metadata](https://docs.x.ai/developers/rest-api-reference/inference/other).
- Read standard `prompt_tokens_details.cached_tokens`, Kimi `cached_tokens`, or DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` under `usage`; spellings can coexist.
- Preserve reasoning history only for the selected model's supported replay contract; do not generalise one family's rule.

Sources: [Kimi](https://platform.kimi.ai/docs/api/chat), [DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/), [xAI](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions), [Z.AI](https://docs.z.ai/api-reference/llm/chat-completion), [OpenRouter](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [Gemini](https://ai.google.dev/gemini-api/docs/openai), [HF](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion), [Ollama](https://docs.ollama.com/api/openai-compatibility), [Mercury](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/services/providers).
