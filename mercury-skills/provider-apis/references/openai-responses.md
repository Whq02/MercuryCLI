Checked: 2026-09-15
# OpenAI Responses

## Request and continuation
- POST `https://api.openai.com/v1/responses` with bearer API-key authentication.
- Keep Mercury's subscription backend separate; its OAuth route is not the public API-key endpoint.
- Send `model`, typed `input`, `stream:true`, `store:false` and `include:["reasoning.encrypted_content"]`.
- Add non-empty `instructions`; add tools, `tool_choice:"auto"` and `parallel_tool_calls:true` only when tools exist.
- Flatten function tools: `{type:"function",name,description,parameters}`; do not nest `function` as Chat Completions does.
- Use `input_text`, `input_image` and assistant `output_text` content items.
- Pair `function_call` and `function_call_output` by `call_id`; encode call arguments as JSON strings.
- Preserve settled output-item order, encrypted reasoning and assistant `phase` (`commentary` or `final_answer`) when replaying.
- Use Mercury's stateless replay, not `previous_response_id` storage.
- Send `reasoning.summary:"auto"` and catalogue-resolved effort when available.
- Supply a stable `prompt_cache_key`; do not infer a cache hit from its presence.
- Distinguish public `text.verbosity`/`max_output_tokens` support from Mercury: its builder sends neither.

## Streaming
- Decode `response.*` SSE events; accumulate text, reasoning and argument deltas.
- Settle each call once at `response.output_item.done`; use accumulated arguments when the item omits them.
- Refuse malformed arguments and streams missing a terminal event.
- Distinguish `response.completed`, `response.failed` and `response.incomplete`; record unknown event kinds.

Sources: [API](https://developers.openai.com/api/reference/resources/responses/methods/create), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Mercury](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/services/providers/openai).
