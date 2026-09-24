---
name: provider-apis
description: Use when building against model-provider APIs or choosing request shapes, streaming, tools or caching for Mercury's providers. Not for account sign-in or unrelated SDKs.
argument-hint: "[question or task]"
---
# Provider APIs

- Identify the provider, account route and served model before writing a request.
- Check `references/live-sources.md` for current documentation and `references/models.md` for catalogue guidance.
- Separate public API requirements from Mercury's implementation; retain documented differences rather than copying a transport defect.

## Choose the dialect
- Read `references/anthropic-messages.md` for Anthropic Messages: block content, tool results and cache breakpoints.
- Read `references/openai-responses.md` for OpenAI Responses: input/output items, stateless replay and response events.
- Read `references/chat-completions.md` for Moonshot/Kimi, DeepSeek, Z.AI, OpenRouter, Gemini, Hugging Face and local/compatible servers.

## Resolve Mercury's route
- Resolve `compat/`, `openrouter/`, `huggingface/` and `local/` namespaces before native prefixes.
- Strip Mercury's carrier prefix, not the provider's own model slug, before sending.
- Route `gpt-` to OpenAI; `kimi-`/`moonshot-` to Moonshot; `deepseek-` to DeepSeek; `glm-` to Z.AI; `gemini-` to Gemini.
- Use Anthropic's declared IDs and aliases for Messages; do not treat arbitrary unknown IDs as Anthropic models.
- Preserve explicit gateway/model-pin admission; never fall through to another provider after a route failure.
- Use `/logins` and `/accounts` for credentials; select the actual API-key or subscription endpoint rather than substituting one for the other.

## Verify
- Check every model ID, capability, price and limit against today's catalogue or provider page.
- Test tool/result pairing, stream termination and usage against a fixture before a live request.
- Report unsupported parameters and code/documentation differences explicitly.

Checked: 2026-09-15. [Mercury transports](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/services/providers); provider sources are in the references.
