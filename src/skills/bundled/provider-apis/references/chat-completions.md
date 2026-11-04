# Chat and native runtime index

Open the selected family section, not the whole estate:

- [Native providers](chat-native.md): Moonshot/Kimi, DeepSeek, xAI, Meta, Z.AI, Gemini, Mistral, Qwen, MiniMax, Cohere.
- [Hosted providers](chat-hosted.md): OpenRouter, Hugging Face, Nous, OpenCode Zen, Together, Groq, Cerebras, Fireworks, Melious, OrcaRouter.
- [Local and rented engines](chat-local.md): custom compat endpoints, Ollama, LM Studio, vLLM, SGLang, llama.cpp and host billing.

Paths in these three maps are relative to `src/services/providers/` unless prefixed with `src/`. Historical source notes date to 2026-10-26 unless a claim carries a newer reading; inspect the owner before changing its behavior. A map is not a live account test.

`openaicompat/compatChatCallModel.ts` integrates the shared runtime; `openaicompat/compatChatClient.ts` owns HTTP/SSE, `CompatStreamEvent` and `CompatFault`; `openaicompat/compatWire.ts` and `openaicompat/compatEffort.ts` own family extras. Preserve role-labelled messages, nested function tools and `tool_call_id` correlation. Native variants such as `zai/zaiCodec.ts` and `gemini/geminiCodec.ts` still need their own codecs.

Tool fragments are index-keyed and accumulate once. Keep raw finish reasons observable; an unknown reason is not fabricated truncation. An error envelope can follow HTTP 200. `streamIdleBudget.ts` owns typed wait notifications, separate from deltas and terminal faults. The entry's identity, replay, refusal and usage invariants apply to every family.

`providerUsage.ts` presents account observations beside session spend. Open the account resolver with its usage reader: the observation belongs to a credential and endpoint. Inference and optional management credentials have different jobs.

`scripts/provider-compat/prove-compat-chat-transport.ts` covers injected-fetch SSE, chunking, fragments, usage spellings and error envelopes. A decoder proof does not establish dispatch, auth refresh or settlement; choose a loopback route fixture for those effects.
