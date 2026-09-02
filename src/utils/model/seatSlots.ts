import { selectableEffortLevels, type EffortValue } from '../effort.js'
import { getCanonicalName, parseUserSpecifiedModel } from './model.js'
import { isHaikuTier } from './modelFloor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { parseGptModelId } from '../../services/providers/openai/gptPins.js'
import {
  readPersistedSeatSlots,
  writePersistedSeatSlot,
  type SlotRole,
} from './seatSlotStore.js'

export { SLOT_ROLES, seatSlotsPath, readPersistedSeatSlots } from './seatSlotStore.js'
export type { SlotRole, PersistedSlots } from './seatSlotStore.js'


export type SeatSpec = {
  model: string
  effort: EffortValue
}

export type SeatResolution = SeatSpec & {
  note?: string
}

export type SlotOrigin = 'env' | 'persisted' | 'default'

export type SeatSlotView = SeatResolution & {
  modelOrigin: SlotOrigin
  effortOrigin: SlotOrigin
  modelEnvVar?: string
  effortEnvVar?: string
}


function resolveModelAxis(args: {
  envRaw: string | undefined
  envVar: string
  persistedRaw: string | undefined
  def: string
}): { model: string; origin: SlotOrigin; envVar?: string; notes: string[] } {
  const notes: string[] = []
  let model = args.def
  let origin: SlotOrigin = 'default'
  if (args.persistedRaw !== undefined) {
    const pv = validateSeatModel(args.persistedRaw, args.def)
    if (pv.note) notes.push(`persisted slot: ${pv.note}`)
    else {
      model = pv.model
      origin = 'persisted'
    }
  }
  if (args.envRaw !== undefined && args.envRaw.trim() !== '') {
    const ev = validateSeatModel(args.envRaw, model)
    if (ev.note) notes.push(ev.note)
    else return { model: ev.model, origin: 'env', envVar: args.envVar, notes }
  }
  return { model, origin, notes }
}

function resolveEffortAxis(args: {
  envRaw?: string | undefined
  envVar?: string
  persistedRaw: string | undefined
  def: EffortValue
}): { effort: EffortValue; origin: SlotOrigin; envVar?: string; notes: string[] } {
  const notes: string[] = []
  let effort = args.def
  let origin: SlotOrigin = 'default'
  if (args.persistedRaw !== undefined) {
    const pv = validateSeatEffort(args.persistedRaw, args.def)
    if (pv.note) notes.push(`persisted slot: ${pv.note}`)
    else {
      effort = pv.effort
      origin = 'persisted'
    }
  }
  if (args.envRaw !== undefined && args.envRaw.trim() !== '' && args.envVar) {
    const ev = validateSeatEffort(args.envRaw, effort)
    if (ev.note) notes.push(ev.note)
    else return { effort: ev.effort, origin: 'env', envVar: args.envVar, notes }
  }
  return { effort, origin, notes }
}

export const SEAT_ALLOWED_FAMILIES: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
]

export type SeatDoctrineTier = 'orchestrator' | 'executor' | 'unknown'

export function seatDoctrineTier(modelId: string): SeatDoctrineTier {
  const canonical = getCanonicalName(modelId).toLowerCase()
  if (
    canonical.includes('opus-4') ||
    canonical.includes('opus-5') ||
    canonical.includes('fable')
  ) {
    return 'orchestrator'
  }
  if (canonical === 'claude-sonnet-5') return 'executor'
  return 'unknown'
}

export const SEAT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const SCRIBE_SEAT_DEFAULT_MODEL = 'claude-fable-5[1m]'
export const IMPLEMENTER_SEAT_DEFAULTS: SeatSpec = {
  model: 'claude-opus-5',
  effort: 'max',
}

export function validateSeatModel(
  raw: string | undefined,
  fallback: string,
): { model: string; note?: string } {
  const trimmed = raw?.trim()
  if (!trimmed) return { model: fallback }
  if (isHaikuTier(trimmed)) {
    return {
      model: fallback,
      note: `'${trimmed}' is Haiku-tier — never allowed for a seat; using '${fallback}'`,
    }
  }
  const gptIdentity = parseGptModelId(trimmed)
  if (gptIdentity) {
    return { model: gptIdentity.canonicalId }
  }
  const resolved = parseUserSpecifiedModel(trimmed)
  if (isHaikuTier(resolved)) {
    return {
      model: fallback,
      note: `'${trimmed}' resolves Haiku-tier — never allowed for a seat; using '${fallback}'`,
    }
  }
  const canonical = getCanonicalName(resolved)
  if (SEAT_ALLOWED_FAMILIES.includes(canonical)) {
    return { model: resolved }
  }
  return {
    model: fallback,
    note: `'${trimmed}' (→ ${canonical}) is not an allowed seat family [${SEAT_ALLOWED_FAMILIES.join(', ')}]; using '${fallback}'`,
  }
}

export function validateSeatEffort(
  raw: string | undefined,
  fallback: EffortValue,
): { effort: EffortValue; note?: string } {
  const trimmed = raw?.trim().toLowerCase()
  if (!trimmed) return { effort: fallback }
  if (SEAT_EFFORTS.includes(trimmed)) return { effort: trimmed as EffortValue }
  return {
    effort: fallback,
    note: `'${trimmed}' is not an effort level [${SEAT_EFFORTS.join(', ')}]; using '${String(fallback)}'`,
  }
}

export function resolveImplementerSeat(): SeatSlotView {
  const persisted = readPersistedSeatSlots().implementer
  const m = resolveModelAxis({
    envRaw: flagEnv('MERCURY_IMPLEMENTER_MODEL'),
    envVar: 'MERCURY_IMPLEMENTER_MODEL',
    persistedRaw: persisted?.model,
    def: IMPLEMENTER_SEAT_DEFAULTS.model,
  })
  const e = resolveEffortAxis({
    envRaw: flagEnv('MERCURY_IMPLEMENTER_EFFORT'),
    envVar: 'MERCURY_IMPLEMENTER_EFFORT',
    persistedRaw: persisted?.effort,
    def: IMPLEMENTER_SEAT_DEFAULTS.effort,
  })
  const notes = [...m.notes, ...e.notes]
  const note = notes.length ? notes.join(' · ') : undefined
  return {
    model: m.model,
    effort: e.effort,
    modelOrigin: m.origin,
    effortOrigin: e.origin,
    ...(m.envVar ? { modelEnvVar: m.envVar } : {}),
    ...(e.envVar ? { effortEnvVar: e.envVar } : {}),
    ...(note ? { note } : {}),
  }
}

export const SCRIBE_SEAT_DEFAULT_EFFORT: EffortValue = 'xhigh'

export function resolveScribeSeat(): SeatSlotView {
  const persisted = readPersistedSeatSlots().scribe
  const m = resolveModelAxis({
    envRaw: flagEnv('MERCURY_SCRIBE_MODEL'),
    envVar: 'MERCURY_SCRIBE_MODEL',
    persistedRaw: persisted?.model,
    def: SCRIBE_SEAT_DEFAULT_MODEL,
  })
  const e = resolveEffortAxis({
    persistedRaw: persisted?.effort,
    def: SCRIBE_SEAT_DEFAULT_EFFORT,
  })
  const notes = [...m.notes, ...e.notes]
  const note = notes.length ? notes.join(' · ') : undefined
  return {
    model: m.model,
    effort: e.effort,
    modelOrigin: m.origin,
    effortOrigin: e.origin,
    ...(m.envVar ? { modelEnvVar: m.envVar } : {}),
    ...(note ? { note } : {}),
  }
}

export function resolveScribeSeatModel(): { model: string; note?: string } {
  const v = resolveScribeSeat()
  return v.note ? { model: v.model, note: v.note } : { model: v.model }
}

export function resolveSeatSlot(role: SlotRole): SeatSlotView {
  if (role === 'scribe') return resolveScribeSeat()
  return resolveImplementerSeat()
}


export function seatRoleDefaults(role: SlotRole): SeatSpec {
  if (role === 'scribe') {
    return { model: SCRIBE_SEAT_DEFAULT_MODEL, effort: SCRIBE_SEAT_DEFAULT_EFFORT }
  }
  return IMPLEMENTER_SEAT_DEFAULTS
}

function refusalReason(note: string): string {
  const i = note.lastIndexOf('; using ')
  return i > 0 ? note.slice(0, i) : note
}

export type SlotWriteResult = {
  ok: boolean
  message: string
  applied?: { model?: string; effort?: EffortValue }
  envShadow?: string
}

export function setOperatorSeatSlot(
  role: SlotRole,
  patch: { model?: string | null; effort?: string | null },
): SlotWriteResult {
  const def = seatRoleDefaults(role)
  const write: { model?: string | null; effort?: string | null } = {}
  const applied: string[] = []
  const appliedValues: { model?: string; effort?: EffortValue } = {}
  if (patch.model !== undefined) {
    if (patch.model === null) {
      write.model = null
      applied.push('model cleared')
    } else {
      const v = validateSeatModel(patch.model, def.model)
      if (v.note) return { ok: false, message: `Refused: ${refusalReason(v.note)} — nothing saved` }
      write.model = v.model
      appliedValues.model = v.model
      applied.push(v.model)
    }
  }
  if (patch.effort !== undefined) {
    if (patch.effort === null) {
      write.effort = null
      applied.push('effort cleared')
    } else {
      const v = validateSeatEffort(patch.effort, def.effort)
      if (v.note) return { ok: false, message: `Refused: ${refusalReason(v.note)} — nothing saved` }
      const effModel = write.model ?? resolveSeatSlot(role).model
      let servable: readonly string[] = []
      try {
        servable = selectableEffortLevels(effModel)
      } catch {
        servable = []
      }
      if (servable.length > 0 && !servable.includes(v.effort as (typeof servable)[number])) {
        return {
          ok: false,
          message: `Refused: '@${String(v.effort)}' — ${effModel} serves [${servable.join(' ')}]; nothing saved`,
        }
      }
      write.effort = v.effort as string
      appliedValues.effort = v.effort
      applied.push(`@${String(v.effort)}`)
    }
  }
  if (applied.length === 0) return { ok: false, message: 'Nothing to save — no model/effort given' }
  try {
    writePersistedSeatSlot(role, write)
  } catch (e) {
    return { ok: false, message: `Slot NOT saved — write failed: ${String(e).split('\n')[0]}` }
  }
  const now = resolveSeatSlot(role)
  const shadows: string[] = []
  if (patch.model !== undefined && now.modelOrigin === 'env' && now.modelEnvVar) {
    shadows.push(now.modelEnvVar)
  }
  if (patch.effort !== undefined && now.effortOrigin === 'env' && now.effortEnvVar) {
    shadows.push(now.effortEnvVar)
  }
  const shadowText = shadows.length
    ? `${[...new Set(shadows)].join(' + ')} overrides this session; the slot applies when it clears`
    : ''
  return {
    ok: true,
    message: `Saved ${role} slot: ${applied.join(' ')} · persists for future engagements${shadowText ? ` — note: ${shadowText}` : ''}`,
    applied: appliedValues,
    ...(shadowText ? { envShadow: shadowText } : {}),
  }
}

export function clearOperatorSeatSlot(role: SlotRole): SlotWriteResult {
  try {
    writePersistedSeatSlot(role, { model: null, effort: null })
  } catch (e) {
    return { ok: false, message: `Slot NOT cleared — write failed: ${String(e).split('\n')[0]}` }
  }
  return { ok: true, message: `Cleared ${role} slot — back to env pin / ratified default` }
}


export const SEAT_MODEL_CYCLE: readonly string[] = [
  'claude-fable-5[1m]',
  'claude-fable-5-1',
  'claude-sonnet-5',
  'claude-opus-5',
]

export function seatModelCycleFor(_role: SlotRole): readonly string[] {
  return SEAT_MODEL_CYCLE
}

function seatFamilyOf(m: string): 'opus' | 'sonnet' | 'fable' | 'other' {
  const l = m.toLowerCase()
  if (l.includes('opus')) return 'opus'
  if (l.includes('sonnet')) return 'sonnet'
  if (l.includes('fable') || l.includes('mythos')) return 'fable'
  return 'other'
}

export function nextSeatModel(role: SlotRole, current: string): string {
  const cycle = seatModelCycleFor(role)
  const exact = cycle.indexOf(current)
  const fam = seatFamilyOf(current)
  const idx = exact >= 0 ? exact : cycle.findIndex(m => seatFamilyOf(m) === fam)
  return cycle[idx < 0 ? 0 : (idx + 1) % cycle.length]!
}
