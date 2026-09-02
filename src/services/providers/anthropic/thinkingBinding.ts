// providers/anthropic/thinkingBinding — Mercury's preserved-thinking setting
// (the Claude Fable 5.1 conversation check) and the reading of what the API
// dropped. Mercury-owned.
//
// A Claude Fable 5.1 thinking block is bound to the exact prefix that
// produced it — the top-level system prompt, the tools set and every message
// before it. Where the check is enforced (organisations created on or after
// 2026-08-31 today; every account on later models), a request that replays a
// block after that prefix changed is a 400 unless the request opts into
// `drop_block`, in which case the API drops the block and every thinking
// block after it and names each one in the response's
// `input_transformations`. Mercury's history is append-only by design and
// the known client-side edits strip their own invalidated run
// (stripThinkingFromIndex), so a drop is a defect signal — never an outage:
// the production setting is `drop_block` under the controls header, and every
// drop reaches the operator as a transcript notice.
//
// MERCURY_THINKING_BINDING: unset ⇒ drop_block (production) · error ⇒ the
// API refuses instead (provers and CI, where an edit must fail the run) ·
// 0/off ⇒ no header, no field (the pre-controls request, byte-identical).
// The host rule: unset rides the FIRST-PARTY host only — the controls beta
// is a Claude API header a gateway or another platform may refuse; an
// EXPLICIT value rides every host, the operator's assertion that their
// gateway accepts the beta (the MERCURY_TOOL_SEARCH assertion's pattern),
// and the way a fixture-hosted prover sees the field on the wire.
import { THINKING_BINDING_CONTROLS_BETA_HEADER } from '../../../constants/betas.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { InputTransformation } from '../../../types/wire.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'

export type PrefixMismatchBehavior = 'drop_block' | 'error'

/** The wire field the controls beta unlocks (the SDK types lag it). */
export type ThinkingBlockBinding = {
  block_binding: { prefix_mismatch_behavior: PrefixMismatchBehavior }
}

/** The setting as read: the behavior (null = off) and whether the operator
 *  spelled it (an explicit value rides every host; unset is first-party only). */
export interface ThinkingBindingSetting {
  behavior: PrefixMismatchBehavior | null
  explicit: boolean
}

export function resolveThinkingBindingSetting(raw: string | undefined): ThinkingBindingSetting {
  if (raw === undefined || raw.trim() === '') return { behavior: 'drop_block', explicit: false }
  const value = raw.trim().toLowerCase()
  if (value === 'error') return { behavior: 'error', explicit: true }
  if (value === 'drop_block' || value === 'drop' || value === '1' || value === 'true') {
    return { behavior: 'drop_block', explicit: true }
  }
  if (value === '0' || value === 'off' || value === 'false' || value === 'none') {
    return { behavior: null, explicit: true }
  }
  logForDebugging(
    `MERCURY_THINKING_BINDING=${raw}: not a known value (drop_block · error · off) — riding drop_block`,
    { level: 'warn' },
  )
  return { behavior: 'drop_block', explicit: true }
}

export function resolveThinkingBindingBehavior(
  raw: string | undefined = flagEnv('MERCURY_THINKING_BINDING'),
): PrefixMismatchBehavior | null {
  return resolveThinkingBindingSetting(raw).behavior
}

/** Injectable reads for provers; production callers pass nothing. `env` is
 *  the raw MERCURY_THINKING_BINDING value — the KEY's presence injects it, so
 *  `{ env: undefined }` is the unset case. */
export interface ThinkingBindingReads {
  firstParty?: () => boolean
  env?: string | undefined
}

/**
 * Stamp the binding field onto a request's `thinking` object and admit the
 * controls header into `betas` (mutated in place — the caller's per-attempt
 * copy). Identity when the request carries no thinking (nothing to bind),
 * when the setting is unset off the first-party host, or when the operator
 * turned the setting off.
 */
export function applyThinkingBinding<T extends { type: string }>(
  thinking: T | undefined,
  betas: string[],
  reads?: ThinkingBindingReads,
): T | (T & ThinkingBlockBinding) | undefined {
  if (thinking === undefined) return thinking
  const raw = reads !== undefined && 'env' in reads ? reads.env : flagEnv('MERCURY_THINKING_BINDING')
  const setting = resolveThinkingBindingSetting(raw)
  if (setting.behavior === null) return thinking
  if (!setting.explicit) {
    const firstParty = (reads?.firstParty ?? isFirstPartyAnthropicBaseUrl)()
    if (!firstParty) return thinking
  }
  if (!betas.includes(THINKING_BINDING_CONTROLS_BETA_HEADER)) {
    betas.push(THINKING_BINDING_CONTROLS_BETA_HEADER)
  }
  return { ...thinking, block_binding: { prefix_mismatch_behavior: setting.behavior } }
}

/** The dropped-block list off a response message (streaming: the
 *  message_start envelope the minted assistant message spreads). Empty when
 *  absent, null, or not an array — the field is read, never trusted. */
export function inputTransformationsOf(message: unknown): InputTransformation[] {
  const list = (message as { input_transformations?: unknown } | null | undefined)?.input_transformations
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is InputTransformation =>
      typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string',
  )
}

/**
 * The operator's sentence for a non-empty drop list, or null for an empty
 * one. Names the count, the first path and the reason class; a drop is a
 * transcript row, never a silent degradation.
 */
export function describeInputTransformations(list: readonly InputTransformation[]): string | null {
  if (list.length === 0) return null
  const dropped = list.filter(entry => entry.type === 'thinking_dropped')
  const count = dropped.length > 0 ? dropped.length : list.length
  const first = list[0]!
  const reasons = new Set(list.map(entry => entry.reason))
  const noun = count === 1 ? 'thinking block' : 'thinking blocks'
  if (reasons.size === 1 && reasons.has('prefix_binding_mismatch')) {
    return `Preserved thinking: the API dropped ${count} ${noun} — the history before ${first.path} changed since they were written (a client-side edit); the model re-plans without that reasoning this turn.`
  }
  if (reasons.size === 1 && reasons.has('model_binding_mismatch')) {
    return `Preserved thinking: the API dropped ${count} ${noun} written by another model (the conversation switched models); the model re-plans without them this turn.`
  }
  return `Preserved thinking: the API dropped ${count} ${noun} (${[...reasons].join(', ')}; first at ${first.path}); the model re-plans without that reasoning this turn.`
}
