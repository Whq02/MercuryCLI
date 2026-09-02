// ============================================================================
//  seatSlots — validated per-seat model+effort slots for the routed harness.
//
//  The scribe router's 2 seats (scribe/implementer), wrapping the existing
//      MERCURY_SCRIBE_MODEL / MERCURY_IMPLEMENTER_MODEL / MERCURY_IMPLEMENTER_EFFORT
//      env overrides (which are never RAW pass-through — zero-validation is the guarded class).
//
//  Every slot value is validated against the ALLOWED seat families
//  (opus-4-x / opus-5 / sonnet-5 / fable-5; mythos folds to fable) — never Haiku —
//  plus, since (decision #6), EXPLICIT exact gpt ids (the pure
//  grammar parses them; LIVE qualification is the dispatch runtime's law —
//  the era ≥5.6 structural floor was removed with the generation
//  gate). Invalid values FAIL CLOSED to the seat's pinned default with an
//  honest note (never to nothing, never to the raw junk).
//
//  PERSISTED OPERATOR SLOTS: every resolver runs
//  the per-axis precedence law  env pin > persisted slot > ratified default —
//  the persisted tier is <configHome>/seat-slots.json (seatSlotStore.ts, the
//  /effort persisted-default pattern), written ONLY through
//  setOperatorSeatSlot() below (validated; junk never lands). Resolutions
//  carry provenance (modelOrigin/effortOrigin + the pinning env var) so
//  pickers render env-pinned axes LOCKED with the origin NAMED (the env-pin
//  override-origin lesson). An invalid value at any tier falls THROUGH the
//  ladder (env→persisted→default), never to the raw junk. Crew teammates are
//  deliberately NOT roles here: their model is a per-spawn wizard choice
//  (CREW_MODEL_CHOICES), not a standing seat identity.
//
//  Bun-loadability: imports model.js + modelFloor.js + seatSlotStore.js
//  (node builtins + envUtils + durablePublish) and effort.js — the old
//  "effort.ts is a value-import no-go under bun (featureGates)" claim is
//  RETIRED: bun provers value-import effort.js green, and the
//  effort-dial refusal below consults selectableEffortLevels live. The local
//  SEAT_EFFORTS vocabulary stays cross-checked against effort.ts
//  EFFORT_LEVELS by the proof suite.
// ============================================================================
import { selectableEffortLevels, type EffortValue } from '../effort.js'
import { getCanonicalName, parseUserSpecifiedModel } from './model.js'
import { isHaikuTier } from './modelFloor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
// the PURE gpt grammar (zero imports) —
// bun-loadability preserved (flagRegistry is import-free).
import { parseGptModelId } from '../../services/providers/openai/gptPins.js'
import {
  readPersistedSeatSlots,
  writePersistedSeatSlot,
  type SlotRole,
} from './seatSlotStore.js'

export { SLOT_ROLES, seatSlotsPath, readPersistedSeatSlots } from './seatSlotStore.js'
export type { SlotRole, PersistedSlots } from './seatSlotStore.js'


export type SeatSpec = {
  /** Resolved model id (post-alias), validated against SEAT_ALLOWED_FAMILIES. */
  model: string
  /** Effort floor for the seat. */
  effort: EffortValue
}

export type SeatResolution = SeatSpec & {
  /** Honest advisory when an override was refused/adjusted; absent when clean. */
  note?: string
}

/** Which precedence tier produced an axis value. */
export type SlotOrigin = 'env' | 'persisted' | 'default'

/** A resolution with per-axis provenance: pickers/boards render an
 *  env-pinned axis LOCKED and NAME its origin (modelEnvVar/effortEnvVar). */
export type SeatSlotView = SeatResolution & {
  modelOrigin: SlotOrigin
  effortOrigin: SlotOrigin
  /** Present iff modelOrigin === 'env'. */
  modelEnvVar?: string
  /** Present iff effortOrigin === 'env'. */
  effortEnvVar?: string
}

// ── per-axis precedence (env pin > persisted slot > ratified default) ────────
// Each tier is validated against the tier BELOW it as the fail-closed target,
// so an invalid value falls through the ladder — never to the raw junk, and
// never skipping a valid lower tier.

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

/**
 * CANONICAL model families a seat may run on (getCanonicalName folds ids to
 * these): 'claude-opus-4-6' is the canonical for the WHOLE Opus 4.x line —
 * opus-4-8 AND opus-4-7/4-6 fold there (model.ts:318-329), which deliberately
 * honors the standing "an earlier Opus can be restored without a rebuild"
 * swappability requirement (scribeModelPin doc); 'claude-opus-5' is its OWN
 * canonical (the current-generation ids never fold). Mythos is allowed
 * implicitly (folds → claude-fable-5). Haiku is refused before this list is
 * consulted.
 */
export const SEAT_ALLOWED_FAMILIES: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  // Claude Fable 5.1 keeps its own canonical (model.ts canonicalMatch) —
  // the frontier family's second member, allowed on the same terms.
  'claude-fable-5-1',
]

/** The doctrine tier a resolved seat model runs the mode packs at. */
export type SeatDoctrineTier = 'orchestrator' | 'executor' | 'unknown'

/**
 * Classify a resolved slot model into a doctrine tier (relocated from the
 * retired wrapper-pack tier overlay — the
 * classification is unchanged). Opus (4.x AND 5) + Fable/Mythos are
 * orchestrator-tier (the packs' authored default: wide decide-thresholds at
 * deep effort); Sonnet-5 is executor-tier (the packs swap in the tighter
 * executor doctrine). Anything else — including Haiku, which seat validation
 * refuses upstream — is 'unknown': the authored base prose, no false
 * doctrine.
 */
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

/** Mirrors effort.ts EFFORT_LEVELS (value-import is not bun-loadable there);
 *  the seat-slots proof cross-checks this against the effort.ts source text. */
export const SEAT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Scribe-router seat defaults (the same two-tier doctrine: refining front on
 *  the frontier @xhigh; the ONE deep executor on Opus 5 @max — effort-payoff
 *  doctrine unchanged from, models repinned per). */
export const SCRIBE_SEAT_DEFAULT_MODEL = 'claude-fable-5[1m]'
export const IMPLEMENTER_SEAT_DEFAULTS: SeatSpec = {
  model: 'claude-opus-5',
  effort: 'max',
}

/**
 * Validate a raw operator-supplied model string against the seat allowlist.
 * - empty/undefined ⇒ fallback, silently (unset means "use the default")
 * - haiku tier (any spelling) ⇒ fallback + note (the never-Haiku rule)
 * - bare 'sonnet' resolves through the tier owner like any alias — on
 *   firstParty that is claude-sonnet-5 (an allowed family) since the catalog
 *   took the sonnet default; a 3P resolution to 4.5 still refuses off-list.
 *   (The old special-case refusal claimed 'sonnet' resolves to sonnet-4-6 —
 *   stale copy.)
 * an EXACT gpt id: accepted when the id parses
 *   under the PURE grammar — LIVE qualification stays the dispatch runtime's
 *   law, which refuses an unqualified id honestly at dispatch (never here
 *   from a remembered fact). The 'gpt'/'glm' class aliases and GLM ids never
 *   slot.
 * - off-list/junk ⇒ fallback + note
 * - allowed family ⇒ the RESOLVED id (aliases like 'fable'/'sonnet5' work)
 * FAIL CLOSED: the fallback is always a pinned seat default, never the input.
 */
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

/** Validate a raw effort token; invalid ⇒ fallback + note. */
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

/** 
 * The Implementer seat (scribe router) under the precedence law
 * (MERCURY_IMPLEMENTER_MODEL/_EFFORT > persisted slot > pinned default), per
 * axis, with provenance. Defaults: IMPLEMENTER_SEAT_DEFAULTS (claude-opus-5@max).
 */
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

/** The Scribe seat's ratified default effort — the refining FRONT runs xhigh
 * */
export const SCRIBE_SEAT_DEFAULT_EFFORT: EffortValue = 'xhigh'

/**
 * The Scribe seat (the foreground refining front) under the precedence law:
 * model — MERCURY_SCRIBE_MODEL > persisted slot > opus[1m] pin; effort — the
 * persisted slot > the xhigh pin (no env tier exists for scribe effort — we
 * never invent a new env var). scribeModelPin.ts consumes this LIVE so a
 * picker reslot reaches the pin without a process restart.
 */
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

/**
 * The Scribe seat MODEL — kept as the historical narrow projection
 * (scribeModelPin.ts + proofs). Validation semantics unchanged; the body now
 * rides the full precedence resolver.
 */
export function resolveScribeSeatModel(): { model: string; note?: string } {
  const v = resolveScribeSeat()
  return v.note ? { model: v.model, note: v.note } : { model: v.model }
}

/** Resolve any role seat by name — the ONE dispatcher pickers/boards use. */
export function resolveSeatSlot(role: SlotRole): SeatSlotView {
  if (role === 'scribe') return resolveScribeSeat()
  return resolveImplementerSeat()
}

// ── the operator write path ────

/** Ratified default spec for a role (the fail-closed anchor + write target). */
export function seatRoleDefaults(role: SlotRole): SeatSpec {
  if (role === 'scribe') {
    return { model: SCRIBE_SEAT_DEFAULT_MODEL, effort: SCRIBE_SEAT_DEFAULT_EFFORT }
  }
  return IMPLEMENTER_SEAT_DEFAULTS
}

/** Strip the trailing "; using '<pin>'" clause off a validation note — a WRITE
 *  refusal saves nothing, so the fallback clause would be a false claim. */
function refusalReason(note: string): string {
  const i = note.lastIndexOf('; using ')
  return i > 0 ? note.slice(0, i) : note
}

export type SlotWriteResult = {
  ok: boolean
  message: string
  /** The VALIDATED values that were persisted (resolved model id / folded
   *  effort) — apply paths reuse them so live pins and receipt expectations
   *  carry exactly what the store now holds. Absent on refusal. */
  applied?: { model?: string; effort?: EffortValue }
  /** The env-shadow warning ("VAR overrides this session; the slot applies
   *  when it clears") as a bare sentence — callers that compose their OWN
   *  ACK line must append this instead of dropping it (F3: the
   *  reconfigure ACK discarded it and claimed a clean reslot). */
  envShadow?: string
}

/**
 * Persist an operator seat slot (the ONE write path — pickers, boards, and
 * the reconfigure callers all land here). Validates BEFORE writing: a refused
 * model/effort writes NOTHING and answers honestly (never-Haiku, the closed
 * seat families + explicit exact gpt ids — decision #6).
 * `null` clears an axis. On success the message says the slot persists, and
 * NAMES any env pin that shadows the written axis this session (the /effort
 * env-conflict pattern).
 */
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
      // Operator-ruled (logic-flaw F9): a dial position the seat's
      // EFFECTIVE model cannot run is REFUSED at save time — the board and
      // receipt would otherwise claim @max while the wire silently stepped down. The
      // effective model is the one this same patch writes, else the live
      // resolution. An empty selectable list (no live vocabulary to check
      // against) skips the refusal — structural validation already passed.
      const effModel = write.model ?? resolveSeatSlot(role).model
      // Fail-open: a config/vocabulary failure must never brick a seat write —
      // the vocabulary refusal is a courtesy check on top of the structural
      // validation that already passed.
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
  // Env-shadow honesty: after the write, name any env pin that still owns an
  // axis this session — the slot is saved, but it applies when the pin clears.
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

/** Clear a role's persisted slot entirely (back to env pin / ratified default). */
export function clearOperatorSeatSlot(role: SlotRole): SlotWriteResult {
  try {
    writePersistedSeatSlot(role, { model: null, effort: null })
  } catch (e) {
    return { ok: false, message: `Slot NOT cleared — write failed: ${String(e).split('\n')[0]}` }
  }
  return { ok: true, message: `Cleared ${role} slot — back to env pin / ratified default` }
}

// ── the ONE seat-model cycle (pickers/boards; no local tables) ───────────────

/** Display cycle for seat reslotting — the ratified Anthropic families in
 *  their ratified spellings (frontier first, then execution tier, then the
 *  current Opus; the 4.x line stays reachable by typed input). The CYCLE
 *  never grows engines or Haiku (provers pin it): a qualified gpt id (
 *  decision #6) slots only by EXPLICIT typed input through
 *  setOperatorSeatSlot — cycling can never land an operator on a third-party
 *  engine by accident. */
export const SEAT_MODEL_CYCLE: readonly string[] = [
  'claude-fable-5[1m]',
  // Fable 5.1 rides bare: 1M is its default and maximum, no rider.
  'claude-fable-5-1',
  'claude-sonnet-5',
  'claude-opus-5',
]

/** The cycle a role may slot through (the retired orchestration seats took
 *  their sonnet-skip rule with them — both surviving roles cycle whole). */
export function seatModelCycleFor(_role: SlotRole): readonly string[] {
  return SEAT_MODEL_CYCLE
}

/** Family discriminator for cycle matching (the retired seat board's rule,
 *  centralized — mythos rides the fable family). */
function seatFamilyOf(m: string): 'opus' | 'sonnet' | 'fable' | 'other' {
  const l = m.toLowerCase()
  if (l.includes('opus')) return 'opus'
  if (l.includes('sonnet')) return 'sonnet'
  if (l.includes('fable') || l.includes('mythos')) return 'fable'
  return 'other'
}

/** The next model in the role's cycle after `current` (family-matched;
 *  unknown current ⇒ the cycle head). Byte-parity with the retired
*  the retired seat board's nextModelOf. */
export function nextSeatModel(role: SlotRole, current: string): string {
  const cycle = seatModelCycleFor(role)
  // An exact cycle spelling steps to its neighbour; any other spelling
  // matches by family (the retired board's rule). Exact-first matters since
  // the frontier family has two cycle members: a family-only match from
  // Fable 5.1 would re-land on the family's first entry and never move on.
  const exact = cycle.indexOf(current)
  const fam = seatFamilyOf(current)
  const idx = exact >= 0 ? exact : cycle.findIndex(m => seatFamilyOf(m) === fam)
  return cycle[idx < 0 ? 0 : (idx + 1) % cycle.length]!
}
