# The Anthropic Messages dialect

Mercury's home lane. POST {base}/v1/messages, where base is https://api.anthropic.com unless ANTHROPIC_BASE_URL overrides it.

## Auth and headers

- API key: `x-api-key: $ANTHROPIC_API_KEY`.
- OAuth bearer (subscription sign-in): `authorization: Bearer <access token>` plus the OAuth beta header the token flow requires.
- Always: `anthropic-version: 2023-06-01` and `content-type: application/json`.

## Request shape

```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 8192,
  "system": [
    { "type": "text", "text": "You are…", "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [
    { "role": "user", "content": [ { "type": "text", "text": "…" } ] }
  ],
  "tools": [
    { "name": "get_weather", "description": "…", "input_schema": { "type": "object", "properties": { "city": { "type": "string" } } } }
  ],
  "stream": true
}
```

Content is BLOCKS, not bare strings: text, image, tool_use, tool_result, thinking. The assistant's tool call arrives as a `tool_use` block ({ id, name, input }); the answer goes back as a user message carrying `tool_result` with the matching `tool_use_id`. Plain-string content is accepted but Mercury always sends block arrays.

## Prompt caching, as Mercury sends it

- A breakpoint is `"cache_control": { "type": "ephemeral" }` on the LAST block of the stable prefix (system tail, conversation tail). The marker means "cache everything up to and including this block".
- Optional `"ttl": "1h"` extends the default five-minute entry; Mercury latches the longer TTL only for query sources that stay hot. Optional `"scope": "global"` widens the entry beyond the session.
- Spend few markers deliberately rather than marking everything: each breakpoint is a cache entry, and an unstable prefix above a marker buys nothing.
- The usage object reports the effect: `cache_read_input_tokens` (hits), `cache_creation_input_tokens` (writes), with the per-TTL split under `cache_creation` (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`). A cold turn writes; a stable re-send reads.

## Streaming

`"stream": true` answers as SSE. The event vocabulary: message_start (carries the message shell and first usage), content_block_start / content_block_delta / content_block_stop per block (text arrives as text_delta payloads, tool arguments as input_json_delta fragments to accumulate), message_delta (stop_reason and closing usage), message_stop. Token counts ride the usage objects on message_start and message_delta.

## Shapes in three languages

curl:
```sh
curl -N https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1024,"stream":true,
       "messages":[{"role":"user","content":[{"type":"text","text":"Say hi"}]}]}'
```

Python (official SDK — the same client Mercury's home lane rides):
```python
import anthropic
client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
with client.messages.stream(
    model="claude-sonnet-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Say hi"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

TypeScript (official SDK):
```ts
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic() // reads ANTHROPIC_API_KEY
const stream = client.messages.stream({
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Say hi' }],
})
stream.on('text', t => process.stdout.write(t))
await stream.finalMessage()
```

## Failure notes

- 401 means the credential; 429 carries retry-after; 5xx retries with backoff (Mercury retries streaming requests with jittered backoff and honours retry-after).
- A stream that dies mid-flight is resumed by re-sending — the cache markers make the replay cheap.
