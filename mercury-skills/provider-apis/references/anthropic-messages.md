Checked: 2026-09-15
# Anthropic Messages

## Request
- POST `https://api.anthropic.com/v1/messages`; respect `ANTHROPIC_BASE_URL` overrides.
- Use the TypeScript `@anthropic-ai/sdk` client; Mercury dispatches `beta.messages.create` with `stream:true`.
- Supply API-key authentication or Mercury's subscription OAuth bearer; let the SDK set `anthropic-version: 2023-06-01` and JSON headers.
- Send `model`, required `max_tokens`, `system`, `messages` and applicable `tools`, `tool_choice`, `thinking` and `output_config`.
- Select optional fields and beta headers from the model's current contract.
- Put function parameters in `input_schema`.
- Preserve content-block arrays; answer assistant `tool_use` blocks with user `tool_result` blocks matching `tool_use_id`.

## Stream and cache
- Handle `message_start`, `content_block_start/delta/stop`, `message_delta` and `message_stop`.
- Accumulate text, thinking, signatures and tool-argument fragments; settle tool arguments at `content_block_stop`.
- Handle `ping`, errors within HTTP 200 streams and unknown events; treat cumulative usage as replacement, not addition.
- Apply `cache_control:{type:"ephemeral"}` to cacheable system blocks and the final conversation message; Mercury uses one message-level breakpoint.
- Use the default five-minute lifetime or `ttl:"1h"`; Mercury's cache clock selects the latter from latched account eligibility.
- Read `cache_read_input_tokens`, `cache_creation_input_tokens` and the five-minute/one-hour split under `cache_creation`.
- Do not send undocumented `scope:"global"`; Mercury's global-scope branch is disabled.
- Treat retry/fallback requests as new attempts, not resumed streams or guaranteed cheap replays.

Sources: [Messages](https://platform.claude.com/docs/en/api/messages), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Mercury](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/services/providers/anthropic).
