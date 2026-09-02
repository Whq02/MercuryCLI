---
description: Use when the user is building against a model-provider API or asks which models, endpoints, or request shapes to use. The reference for every provider API Mercury itself speaks — the Anthropic Messages dialect, the OpenAI Responses dialect, and the OpenAI-compatible chat-completions dialect that carries Moonshot/Kimi, DeepSeek, Z.AI, OpenRouter, Gemini, Hugging Face, and local or self-hosted servers — with request shapes, streaming, tool calls, and caching exactly as Mercury's own transports send them. Model ids and pricing age fast — verify against the live sources before citing.
argument-hint: [question or task]
---

# Provider APIs — the dialects Mercury speaks

This reference is derived from Mercury's own provider transports, not from any vendor's marketing page. Mercury converses with every provider below in one of three wire dialects; a project that targets one of these providers can be built against the same shapes Mercury sends.

## The route law

Mercury resolves a model id to a provider family by its id space — qualified namespaces first (they are reserved and cannot be shadowed), then native prefixes; anything unrecognised is the Anthropic home lane:

| Id space | Family | Dialect | Base endpoint |
|---|---|---|---|
| everything unrecognised | Anthropic | Messages | https://api.anthropic.com |
| gpt-* | OpenAI | Responses | https://api.openai.com/v1 |
| kimi-*, moonshot-* | Moonshot/Kimi | chat-completions | https://api.moonshot.ai/v1 |
| deepseek-* | DeepSeek | chat-completions | https://api.deepseek.com |
| glm-* | Z.AI | chat-completions | https://api.z.ai/api/paas/v4 |
| openrouter/<vendor-slug> | OpenRouter | chat-completions | https://openrouter.ai/api/v1 |
| gemini-* | Gemini | chat-completions (compat surface) | https://generativelanguage.googleapis.com/v1beta/openai |
| (signed-in HF models) | Hugging Face | chat-completions | https://router.huggingface.co/v1 |
| compat/<id> | operator-named compat slot | chat-completions | the operator's own base URL |
| (discovered local models) | local servers | chat-completions | localhost (Ollama :11434, LM Studio :1234, vLLM, llama.cpp-server) |

The qualified prefixes (compat/, openrouter/) are Mercury addressing, stripped before the wire. No route ever falls through to another provider.

## The three dialects

- references/anthropic-messages.md — the Messages API: content blocks, tool_use/tool_result, SSE events, prompt caching with cache_control breakpoints.
- references/openai-responses.md — the Responses API: input items, flat function tools, encrypted-reasoning stateless replay, the response.* SSE vocabulary.
- references/chat-completions.md — the shared OpenAI-compatible dialect and every family that rides it, with per-family knobs and cached-usage spellings.

Read the file for the dialect in play; each carries curl, Python, and TypeScript shapes.

## Models

references/models.md lists the id spaces and the ids this Mercury build ships, and the in-product surfaces (/model, /submodels) that show the live catalog.

## Currency law

Model ids, prices, limits, and endpoint details go stale faster than any bundled text. Before citing a specific model id, price, or rate limit: check references/live-sources.md and fetch the provider's live page. Never present a remembered id or price as current.

## How Mercury itself connects (for orientation)

Anthropic: OAuth sign-in or an API key. OpenAI: OAuth (subscription lane) or an API key. Moonshot, DeepSeek, Z.AI: API keys. OpenRouter: OAuth key exchange. Gemini: Google OAuth or an API key. Hugging Face: an access token. The compat slot: an operator-configured base URL with an optional key (MERCURY_COMPAT_* environment variables win over config). Local servers: discovered on loopback, no credentials. /login and /accounts manage all of it — sign-in questions belong there, not in code.
