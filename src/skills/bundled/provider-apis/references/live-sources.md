# Vendor reference appendix

Index assembled 2026-10-08. The URLs below are reference starting points, not a claim that every page was fetched on that date. Before using a vendor fact, fetch its current page and record the reading date, account kind and endpoint. Do not copy a historical model list or infer billing availability from inference documentation alone.

| Provider | Protocol and catalogue references | Usage research |
|---|---|---|
| Anthropic | [Messages](https://platform.claude.com/docs/en/api/messages), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [models](https://platform.claude.com/docs/en/about-claude/models/overview) | Check subscription usage separately from API organisation administration |
| OpenAI | [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [caching](https://developers.openai.com/api/docs/guides/prompt-caching), [models](https://developers.openai.com/api/docs/models) | Check the API's organisation administration and the subscription account's usage separately |
| Moonshot/Kimi | [Chat](https://platform.kimi.ai/docs/api/chat), [balance](https://platform.kimi.ai/docs/api/balance) | API-key balance and coding-plan usage are separate account roads |
| DeepSeek | [Chat](https://api-docs.deepseek.com/api/create-chat-completion/), [balance](https://api-docs.deepseek.com/api/get-user-balance/) | Read the documented balance response and currency |
| xAI | [Chat](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions), [models](https://docs.x.ai/developers/models), [subscription sign-in](https://x.ai/news/grok-openclaw) | [Management keys](https://docs.x.ai/developers/rest-api-reference/management), [billing](https://docs.x.ai/developers/rest-api-reference/management/billing), [key metadata](https://docs.x.ai/developers/rest-api-reference/inference/other) |
| Meta | [Quickstart](https://dev.meta.ai/docs/quickstart), [chat](https://dev.meta.ai/docs/protocols/chat-completions), [reasoning](https://dev.meta.ai/docs/reasoning), [models](https://dev.meta.ai/docs/models) | [Pricing](https://dev.meta.ai/docs/pricing-rate-limits), [subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions); check account and management APIs before an absence claim |
| Z.AI | [Chat](https://docs.z.ai/api-reference/llm/chat-completion) | Check Coding Plan quota and platform-key billing separately |
| OpenRouter | [Models](https://openrouter.ai/docs/guides/overview/models), [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) | Check account/key limits, credits and provider-stated per-turn cost |
| Gemini | [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) | Check Google Cloud billing and quota for the credential's project as well as inference headers |
| Hugging Face | [Chat](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion) | Check Hub account, provider billing and rate-limit documentation |
| Local/custom | [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), plus the configured server's current documentation | Distinguish measured local usage and served capacity from hosted account credit |

The Anthropic subscription contract's release clock reads the vendor CLI's published version from [its package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest). The source owner and clock proof are in `anthropic-messages.md`; a metadata reading is not a live model request.
