
import { EFFORT_LEVELS } from '../../entrypoints/sdk/runtimeTypes.js'

export const SET_TIER_TOOL_DESCRIPTION =
  'Retune your own model/effort tier under autopilot rails (turn- or session-scoped)'

export const SET_TIER_TOOL_PROMPT = `Change your own model tier and/or reasoning effort. Available ONLY in autopilot mode, on the main session thread.

Input:
- model (optional): a tier key of the session's own family — one of its family words, or the exact id of one of its live rows; a family word resolves to that family's default model with the session's 1M-context posture preserved. The operator allowlist (MERCURY_AUTOPILOT_MODELS) narrows which keys are accepted — a key the operator narrowed out is refused, and a refusal lists the keys.
- effort (optional): ${EFFORT_LEVELS.map(level => `'${level}'`).join(' | ')} — clamped to the target model's real ceiling. An active deepthink turn floor stays raise-only above whatever you set, and MERCURY_EFFORT_LEVEL remains supreme.
- scope (required): 'turn' reverts automatically when the current turn ends; 'session' persists until changed (the operator can always retune via /model — the picker shows the truth).
- reason (required): one line, surfaced to the operator verbatim.

Rails (mechanical, enforced): at most 8 switches per session; at least 3 full turns between switches; every switch is surfaced in the transcript and the mode band. A refusal names its rule — do not retry the same request; adapt or continue on the current tier.

Economics: a model switch invalidates the prompt cache (the next call re-reads the conversation uncached, then re-warms). Batch tier changes with natural phase boundaries — plan approved, long mechanical stretch starting, verification beginning. Near autocompact, prefer staying put. Effort-only moves on the same model are cheaper than model moves.`
