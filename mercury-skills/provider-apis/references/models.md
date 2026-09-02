# Model ids across the families

The live catalog is always the product surface, never this file: /model shows the pickable catalog with the 1M-context column, /submodels shows every signed-in family's rows, and the availableModels setting narrows what a session offers. This file records the id spaces and the ids the current Mercury build ships in its pins, as concrete, checkable examples.

## Id spaces

- Anthropic — claude-* ids, and anything no other family claims (the home lane).
- OpenAI — gpt-* (the bare alias gpt names the family).
- Moonshot — kimi-* and moonshot-* (bare alias kimi).
- DeepSeek — deepseek-*.
- Z.AI — glm-*.
- Gemini — gemini-*.
- OpenRouter — openrouter/<vendor-slug>; the slug itself is vendor/model (openrouter/qwen/qwen3-coder goes to the wire as qwen/qwen3-coder, and openrouter/openrouter/auto as openrouter/auto).
- Compat slot — compat/<id>, where <id> is whatever the operator's endpoint serves; the prefix never reaches the wire.
- Local — the servers' own names, discovered live from the running servers.

## Ids this build ships (examples, verified in-tree)

- Anthropic: claude-opus-5 (Opus 5), claude-sonnet-5 (Sonnet 5), claude-fable-5 (Fable 5, the frontier row), plus dated spellings such as claude-opus-4-1-20250805.
- OpenAI: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark.
- Moonshot: kimi-k3 (the reasoning_effort model), kimi-k2.7-code, kimi-k2.7-code-highspeed.
- DeepSeek: deepseek-v4-pro, deepseek-v4-flash.
- Z.AI: glm-5.2, glm-5.3.

Gemini, OpenRouter, Hugging Face, and local ids come from live catalogs (the vendors' /models listings and the local servers' own answers) — list them live rather than from memory.

## The currency law, applied to ids

An id you remember is a hypothesis. Confirm it against the live catalog surface, the family's /models endpoint, or the vendor page in live-sources.md before it lands in code, config, or advice.
