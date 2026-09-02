import { THINKING_BINDING_CONTROLS_BETA_HEADER } from '../../../constants/betas.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { InputTransformation } from '../../../types/wire.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'

export type PrefixMismatchBehavior = 'drop_block' | 'error'

export type ThinkingBlockBinding = {
  block_binding: { prefix_mismatch_behavior: PrefixMismatchBehavior }
}

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

export interface ThinkingBindingReads {
  firstParty?: () => boolean
  env?: string | undefined
}

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

export function inputTransformationsOf(message: unknown): InputTransformation[] {
  const list = (message as { input_transformations?: unknown } | null | undefined)?.input_transformations
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is InputTransformation =>
      typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string',
  )
}

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
