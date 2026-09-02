# Live sources — fetch before citing

Volatile facts — model ids, prices, context windows, rate limits, endpoint details — are verified against the provider's live pages at answer time. These are the roots:

- Anthropic: https://docs.claude.com (docs root) and https://docs.claude.com/en/api (API reference).
- OpenAI: https://platform.openai.com/docs
- Moonshot/Kimi: https://platform.moonshot.ai/docs
- DeepSeek: https://api-docs.deepseek.com
- Z.AI: https://docs.z.ai
- OpenRouter: https://openrouter.ai/docs
- Gemini: https://ai.google.dev/gemini-api/docs
- Hugging Face: https://huggingface.co/docs/inference-providers

Live /models listings answer "what exists right now" directly: every chat-completions family serves GET <base>/models with its Bearer credential; local servers answer their own discovery endpoints (Ollama GET /api/tags, LM Studio GET /api/v1/models).

A claim sourced from one of these pages carries its date; a claim that cannot be verified is presented as unverified, never as fact.
