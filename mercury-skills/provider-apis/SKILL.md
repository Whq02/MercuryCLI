---
name: provider-apis
description: Use when building or changing a Mercury model-provider road, or choosing its request shapes, streaming, tools, caching or usage reader. Not for account sign-in, choosing a model in the UI or unrelated SDKs.
argument-hint: "[provider road or task]"
---
# Provider APIs

Account sign-in and account choice are the `/logins` and `/accounts` surfaces, not this skill. Start with the symptom and the identity it depends on: account kind, endpoint, selected and served model. Follow `src/services/providers/callModelRouter.ts` to the owning implementation; a provider label alone does not identify the wire. Read the changed request, replay, transport or usage owner, not every subsystem.

## Choose the relevant reference

Checkout paths start at the repository; references start at this skill's supplied base. Read only the relevant section.

- Identity, capabilities and prices: [models](references/models.md).
- Messages: [Anthropic](references/anthropic-messages.md).
- Responses, including carrier/account variants: [Responses](references/openai-responses.md).
- Shared runtime: [chat index](references/chat-completions.md). Family/account detail: [native providers](references/chat-native.md), [hosted providers](references/chat-hosted.md), [local and rented engines](references/chat-local.md).
- Verification: [proof road](references/proof-road.md). Dated source readings and refresh limits: [vendor index](references/live-sources.md).

## Invariants

- Keep credential and endpoint together across refresh. Resolve identity through the classifier and pins, not a copied prefix list; an unknown ID is not an Anthropic identity and a failed route never falls through to another provider.
- The provider decides on usage. A reading is information, never a door that prevents sending. Retry/resume refreshes the sign-in and reading as needed, then asks the provider; a served request clears the remembered refusal. Follow explicit `Retry-After` first; call it a plan window only when the response body identifies that window.
- Every family must show a meter. Inspect management, billing and admin APIs before declaring one unavailable; separate optional billing credentials from inference credentials. Unknown is not zero.
- Preserve selected effort, output capability and supported signed/encrypted replay. No thinking-time guard or silent downgrade. `src/services/providers/toolEconomy.ts` restores the recorded roster; `src/utils/attachments/toolSchemaDelta.ts` carries bound-tool changes without moving that prefix. Local models retain the full tool set.
- `src/services/providers/toolCallGate.ts` answers malformed calls with an error tool result when ID/name are pairable, otherwise a visible refusal note. Preserve tool/result identity, ordered replay and the operator's verbatim turn (`src/utils/messages/apiPlan.ts`); do not merge resume text into tool results.
- A missing terminal event is not success. Keep partial content, fault and measured usage distinct. Read the road's event/fault union and `src/services/providers/streamIdleBudget.ts` before changing settlement.
- API dispatchers retain `allowH2: false` in `src/utils/proxy.ts` and `src/utils/mtls.ts`; this is Mercury policy, not a vendor protocol requirement.

Reproduce the defect on the base, then capture the changed route over a loopback fixture with a scratch home. A fixture is not live compatibility; a live model call needs the operator's explicit authorisation. Report observed outcomes and unverified limits, not just valid request JSON.
