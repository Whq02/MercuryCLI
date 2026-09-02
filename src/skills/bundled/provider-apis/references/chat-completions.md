# The OpenAI-compatible chat-completions dialect

One dialect, many families. POST {base}/chat/completions with `authorization: Bearer <key>` (local servers accept any or no key), `content-type: application/json`. Mercury runs Moonshot/Kimi, DeepSeek, OpenRouter, Gemini, Hugging Face, the operator compat slot, and local servers through one shared streaming client; Z.AI rides the same shapes on its own proven client.

## Request shape

```json
{
  "model": "kimi-k3",
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user", "content": "…" }
  ],
  "tools": [
    { "type": "function", "function": {
        "name": "get_weather", "description": "…",
        "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } } }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

- Function tools are NESTED under function:{} — the opposite of the Responses flat spelling.
- A tool call arrives on the assistant message as tool_calls [{ id, type: "function", function: { name, arguments } }]; the reply is a { "role": "tool", "tool_call_id": …, "content": … } message.
- `stream_options.include_usage` is the documented opt-in for token counts in the final chunk — do not expect usage without it.

## Streaming

SSE `data:` lines, each a JSON chunk with choices[0].delta (role, content fragments, tool_calls fragments), closed by a `data: [DONE]` sentinel. The client laws Mercury holds: tool-call deltas are index-keyed fragments accumulated exactly once, and arguments that fail to parse at the end are a malformed call, never a silent half-call; a stream ending without finish_reason or [DONE] is a truncation fault.

## The families and their knobs

| Family | Base | Knobs Mercury sends |
|---|---|---|
| Moonshot/Kimi | https://api.moonshot.ai/v1 | reasoning_effort on kimi-k3 (nearest supported value); max_completion_tokens only on explicit override; NEVER temperature (K2.x/K3 fix their sampling) |
| DeepSeek | https://api.deepseek.com | thinking: { type, reasoning_effort: low|high|max }; max_tokens on explicit override |
| Z.AI | https://api.z.ai/api/paas/v4/chat/completions | its documented chat endpoint — never an anthropic-compat surface |
| OpenRouter | https://openrouter.ai/api/v1 | model ids are vendor/model slugs (qwen/qwen3-coder, openrouter/auto) |
| Gemini | https://generativelanguage.googleapis.com/v1beta/openai | Google's compat surface; bearer carries an API key or a refreshed OAuth access token |
| Hugging Face | https://router.huggingface.co/v1 | bearer access token; the router fans out to inference providers |
| Compat slot | operator-configured | any OpenAI-compatible server (vLLM, LM Studio, Ollama, proxies); key optional |
| Local | http://localhost:11434/v1 (Ollama), :1234 (LM Studio), … | discovered live; Ollama ignores the key and does not support tool_choice; served context is the server's setting, not a request knob |

## Cached-usage spellings (disjoint per family)

- Standard compat: usage.prompt_tokens_details.cached_tokens
- Moonshot: usage.cached_tokens (top level)
- DeepSeek: usage.prompt_cache_hit_tokens and usage.prompt_cache_miss_tokens

Read the one your family serves; the others will be absent.

## Shapes in three languages

curl (swap the base and key per family):
```sh
curl -N https://api.moonshot.ai/v1/chat/completions \
  -H "authorization: Bearer $MOONSHOT_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"kimi-k3","stream":true,"stream_options":{"include_usage":true},
       "messages":[{"role":"user","content":"Say hi"}]}'
```

Python (the OpenAI SDK pointed at any compat base):
```python
from openai import OpenAI
client = OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"])
stream = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Say hi"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

TypeScript:
```ts
import OpenAI from 'openai'
const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY })
const stream = await client.chat.completions.create({
  model: 'qwen/qwen3-coder',
  messages: [{ role: 'user', content: 'Say hi' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

## Failure notes

- GET {base}/models with the same bearer lists what the credential sees — the live answer to "what can I call here".
- Rate and quota errors differ per family; read the body, honour retry-after when present, and treat provider faults as data, not exceptions to hide.
