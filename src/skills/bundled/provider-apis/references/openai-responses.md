# The OpenAI Responses dialect

Mercury's native OpenAI lane. POST {base}/responses — base https://api.openai.com/v1 with an API key (`authorization: Bearer $OPENAI_API_KEY`); Mercury's subscription sign-in rides the same dialect against the vendor's subscription backend with OAuth bearer tokens.

## Request shape, as Mercury sends it

```json
{
  "model": "gpt-5.5",
  "instructions": "system-level guidance",
  "input": [
    { "type": "message", "role": "user",
      "content": [ { "type": "input_text", "text": "…" } ] }
  ],
  "tools": [
    { "type": "function", "name": "get_weather", "description": "…",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } }
  ],
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "store": false,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<stable conversation key>",
  "stream": true
}
```

The knobs that matter:

- Function tools are FLAT — name at the top level — unlike the chat-completions nested function:{} spelling.
- Message content items are typed: input_text, output_text (assistant history), input_image (data or URL, with a detail level).
- A tool call is a `function_call` item ({ call_id, name, arguments — a JSON-encoded string }); the answer is a `function_call_output` item carrying the same call_id.
- reasoning.effort sets thinking depth; reasoning.summary asks for streamable summaries.
- text.verbosity tunes answer length where the model supports it.

## The stateless-replay continuation law

Mercury sends `store: false` and includes `reasoning.encrypted_content`, then REPLAYS the encrypted reasoning items in order, each before its function call, on the next request. Do not build on `previous_response_id` server storage — statelessness is the contract that works on every lane, subscription included. `prompt_cache_key` keeps server-side prefix caching effective across stateless turns.

## Streaming

SSE events, every one carrying a sequence_number: response.created; response.output_item.added / .done; response.content_part.*; response.output_text.delta / .done; response.refusal.*; response.function_call_arguments.delta / .done; response.reasoning_summary_*; and a terminal response.completed / .failed / .incomplete. Two rules Mercury holds and any client should: settle each tool call exactly once from the DONE item (the argument deltas are for display, and a done call whose arguments do not parse is a malformed call, not a half-call); a stream that ends without a terminal event is a truncation fault, not a success.

## Shapes in three languages

curl:
```sh
curl -N https://api.openai.com/v1/responses \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","stream":true,"store":false,
       "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Say hi"}]}]}'
```

Python:
```python
from openai import OpenAI
client = OpenAI()  # reads OPENAI_API_KEY
with client.responses.stream(model="gpt-5.5", input="Say hi", store=False) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="")
```

TypeScript:
```ts
import OpenAI from 'openai'
const client = new OpenAI() // reads OPENAI_API_KEY
const stream = await client.responses.create({ model: 'gpt-5.5', input: 'Say hi', store: false, stream: true })
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta)
}
```

## Failure notes

- The GET {base}/models listing answers what the credential can see.
- Unknown event types and unknown output-item kinds should be recorded, never crashed on and never silently dropped — vocabularies grow.
