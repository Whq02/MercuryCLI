// ============================================================================
//  SetTier tool prompt — the mechanical contract. The use-case DOCTRINE
//  (when to move, ATLAS-grounded) lives in the autopilot modeSections
//  appendix (autopilotPrompt.ts); this text states what the tool does and
//  what the rails will refuse, so the model never wastes a call learning them.
// ============================================================================

export const SET_TIER_TOOL_DESCRIPTION =
  'Retune your own model/effort tier under autopilot rails (turn- or session-scoped)'

export const SET_TIER_TOOL_PROMPT = `Change your own model tier and/or reasoning effort. Available ONLY in autopilot mode, on the main session thread.

Input:
- model (optional): 'opus' | 'sonnet' | 'fable' | 'fable51' — a family key resolves to that family's default model with the session's 1M-context posture preserved; 'fable51' is Claude Fable 5.1 itself (natively 1M, no posture to carry). The operator allowlist (MERCURY_AUTOPILOT_MODELS, default "opus,sonnet,fable,fable51") gates which keys are accepted — a key the operator narrowed out is refused. Haiku is unrepresentable.
- effort (optional): 'low' | 'medium' | 'high' | 'xhigh' | 'max' — clamped to the target model's real ceiling. An active deepthink turn floor stays raise-only above whatever you set, and MERCURY_EFFORT_LEVEL remains supreme.
- scope (required): 'turn' reverts automatically when the current turn ends; 'session' persists until changed (the operator can always retune via /model — the picker shows the truth).
- reason (required): one line, surfaced to the operator verbatim.

Rails (mechanical, enforced): at most 8 switches per session; at least 3 full turns between switches; every switch is surfaced in the transcript and the mode band. A refusal names its rule — do not retry the same request; adapt or continue on the current tier.

Economics: a model switch invalidates the prompt cache (the next call re-reads the conversation uncached, then re-warms). Batch tier changes with natural phase boundaries — plan approved, long mechanical stretch starting, verification beginning. Near autocompact, prefer staying put. Effort-only moves on the same model are cheaper than model moves.`
