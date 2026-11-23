# Chat and native runtime index

Open only the target family map (paths relative to `src/services/providers/` unless prefixed with `src/`):

- [Native providers](chat-native.md): Moonshot/Kimi, DeepSeek, xAI, Meta, Z.AI, Gemini, Mistral, Qwen, MiniMax, Cohere.
- [Hosted providers](chat-hosted.md): OpenRouter, Hugging Face, Nous, OpenCode Zen, Together, Groq, Cerebras, Fireworks, Melious, OrcaRouter.
- [Local and rented engines](chat-local.md): custom compat endpoints, TensorFold, Ollama, LM Studio, vLLM, SGLang, llama.cpp, host billing.

## Shared runtime

- `openaicompat/compatChatCallModel.ts` integrates shared chat; `openaicompat/compatChatClient.ts` owns HTTP/SSE, `CompatStreamEvent` and `CompatFault`; `openaicompat/compatWire.ts` and `openaicompat/compatEffort.ts` own family extras. Preserve role-labelled messages, nested `function` tools and `tool_call_id` pairing (`zai/zaiCodec.ts` and `gemini/geminiCodec.ts` own their native codecs).
- Accumulate index-keyed tool fragments once, preserve raw finish reasons without fabricating truncation, classify post-200 error envelopes, and keep `streamIdleBudget.ts` wait notices distinct from deltas and terminal faults.
- `providerUsage.ts` combines credential+endpoint account observations with session spend, keeping optional management credentials separate from inference keys.
- `scripts/provider-compat/prove-compat-chat-transport.ts` tests SSE chunking, tool fragments, usage spellings and error envelopes; use a loopback route fixture when testing dispatch, auth refresh or settlement.
