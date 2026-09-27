import type { EffortStampV1 } from '../fabric/record.js'

export type { EffortStampV1 }

export const EFFORT_STAMP_NONE = 'none'
export const EFFORT_STAMP_THINKING_OFF = 'thinking off'
export const EFFORT_STAMP_THINKING_ON = 'thinking on'
export const EFFORT_STAMP_UNSUPPORTED = 'not supported by this model'

export type EffortWireValue = string | number | boolean

export type EffortWireFact =
  | {
      kind: 'sent'
      parameter: string
      value: EffortWireValue
      applied?: string
      beside?: ReadonlyArray<{ parameter: string; value: EffortWireValue }>
    }
  | { kind: 'omitted' }
  | { kind: 'unsupported' }

export function effortAskedWord(asked: string | number | undefined | null): string {
  if (asked === undefined || asked === null || asked === '') return EFFORT_STAMP_NONE
  return String(asked)
}

export function effortWireSpelling(parameter: string, value: EffortWireValue): string {
  return `${parameter}=${String(value)}`
}

export function effortStampOf(asked: string | number | undefined | null, fact: EffortWireFact): EffortStampV1 {
  const askedWord = effortAskedWord(asked)
  switch (fact.kind) {
    case 'sent': {
      const spellings = [effortWireSpelling(fact.parameter, fact.value), ...(fact.beside ?? []).map(b => effortWireSpelling(b.parameter, b.value))]
      return { asked: askedWord, applied: fact.applied ?? String(fact.value), wire: spellings.join(', ') }
    }
    case 'omitted':
      return { asked: askedWord, applied: EFFORT_STAMP_NONE, wire: EFFORT_STAMP_NONE }
    case 'unsupported':
      return { asked: askedWord, applied: EFFORT_STAMP_UNSUPPORTED, wire: EFFORT_STAMP_NONE }
  }
}

export function effortNotOnWire(asked?: string | number | undefined | null): EffortStampV1 {
  return effortStampOf(asked, { kind: 'omitted' })
}

export function isEffortStamp(value: unknown): value is EffortStampV1 {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.asked === 'string' && typeof v.applied === 'string' && typeof v.wire === 'string'
}

export function effortStampLine(stamp: EffortStampV1 | undefined): string {
  if (stamp === undefined) return 'effort unstamped'
  return `effort asked ${stamp.asked} · applied ${stamp.applied} · wire ${stamp.wire}`
}
