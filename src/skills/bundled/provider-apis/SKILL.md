---
name: provider-apis
description: Use when building or changing a Mercury model-provider road, or choosing its request shapes, streaming, tools, caching or usage reader. Not for account sign-in, choosing a model in the UI or unrelated SDKs.
argument-hint: "[provider road or task]"
---
# Provider APIs

Sign-in and account choice belong to `/logins` and `/accounts`. Start from the symptom and its identity (account kind, endpoint, selected and served model), trace `src/services/providers/callModelRouter.ts` to the owner (provider labels alone never identify the wire), and read only the touched request, replay, transport or usage module.

## References (read only the one needed, relative to this skill's base)

- `references/models.md` — model ID classification, route pins, capabilities, effort or pricing.
- `references/anthropic-messages.md` — Anthropic Messages requests, signed thinking, caching or workspace keys.
- `references/openai-responses.md` — OpenAI, OpenRouter, xAI, Zen or compat Responses roads and encrypted replay.
- `references/chat-completions.md` — shared OpenAI-compatible chat transport, tool-fragment assembly or SSE settlement.
- `references/chat-native.md` — Moonshot/Kimi, DeepSeek, xAI chat, Meta, Z.AI, Gemini, Mistral, Qwen, MiniMax or Cohere.
- `references/chat-hosted.md` — OpenRouter chat, Hugging Face, Nous, OpenCode Zen, Together, Groq, Cerebras, Fireworks, Melious or OrcaRouter.
- `references/chat-local.md` — custom compat endpoints, TensorFold, vLLM, SGLang, llama.cpp, Ollama, LM Studio or rental billing.
- `references/proof-road.md` — loopback fixture isolation and byte-parity checks.
- `references/live-sources.md` — vendor API URLs, reading limits and the Anthropic client-contract clock.

## Invariants

- Keep credential and endpoint bound across refresh. Classify routes via `src/services/providers/idSpaces.ts` and family pins; unknown IDs never default to Anthropic, and failed routes never fall through to another provider.
- The provider decides on usage. A reading is information, never a door that prevents sending. Retry/resume refreshes sign-in and usage before calling the provider; a served turn clears remembered refusals. Follow explicit `Retry-After` first; treat a refusal as a plan window only when the response body identifies that window.
- Every family must show a meter. Inspect management, billing and admin APIs before declaring one unavailable, keeping optional billing credentials separate from inference credentials. Unknown is never zero.
- Preserve selected effort, output capability and supported signed/encrypted replay without silent downgrade or thinking-time guards. `src/services/providers/toolEconomy.ts` restores the recorded roster; `src/utils/attachments/toolSchemaDelta.ts` delivers bound-tool deltas without moving that prefix. Under `src/constants/localPromptProfile.ts`, local models load core tools in full and defer the rest behind `ToolSearch`.
- `src/services/providers/toolCallGate.ts` answers malformed calls with an error tool result when ID/name are pairable, else a visible refusal note. Preserve tool/result pairing, replay order and the verbatim user turn (`src/utils/messages/apiPlan.ts`); never merge resume text into tool results.
- Require a terminal stream event, keeping partial output, fault and usage distinct (`src/services/providers/streamIdleBudget.ts`).
- Keep `allowH2: false` in `src/utils/proxy.ts` and `src/utils/mtls.ts`.

Reproduce on the base, then verify over a loopback fixture in a scratch home; a live model call needs the operator's explicit authorisation. Report observed outcomes and unverified limits.
