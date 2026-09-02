// ============================================================================
//  seatSlotStore — the PERSISTED operator seat-slot file.
//
//  Dumb, tiny IO owner for <configHome>/seat-slots.json — the operator's
//  standing per-role model/effort slots (the /effort persisted-default pattern:
//  an explicit picker/board choice is the spend consent, and it SURVIVES
//  sessions). VALIDATION DOES NOT LIVE HERE: seatSlots.ts (the ONE
//  validation/resolution owner) validates on write (setOperatorSeatSlot) and
//  again on read inside the resolvers — a hand-edited junk value fails CLOSED
//  there with the honest note. This module only moves the raw shape.
//
//  Precedence law (resolved in seatSlots.ts): env pin > persisted slot >
//  ratified default — this file is the MIDDLE tier.
//
//  Import discipline: node builtins + envUtils + durablePublish only.
//  seatSlots.ts imports us, and the seat-slots proof suite loads the pair
//  under `bun run` (the effort.ts featureGates value-import class must never
//  creep in here).
// ============================================================================
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome } from '../envUtils.js'

/** Every persistable role seat: the scribe router's two. The retired party
 *  seats (tank/healer/dps1-3) left with the multiplayer estate — their old
 *  persisted rows ride the file as opaque passengers (preserved on write,
 *  never applied, never repainted). Crew teammates are deliberately ABSENT —
 *  their model is a per-spawn wizard choice (CREW_MODEL_CHOICES), not a
 *  standing seat identity. */
export const SLOT_ROLES = [
  'scribe',
  'implementer',
] as const
export type SlotRole = (typeof SLOT_ROLES)[number]

export type PersistedSlot = { model?: string; effort?: string }
export type PersistedSlots = Partial<Record<SlotRole, PersistedSlot>>

/** The store file — config-home scoped (the getMercuryHome resolver),
 *  read LIVE per call so proofs/fixtures re-point it via env. */
export function seatSlotsPath(): string {
  return join(getMercuryHome(), 'seat-slots.json')
}

// mtime+size read cache — resolvers run per render/spawn; a stat per call is
// the cost, a parse only on change. Keyed by path so an env re-point (proofs,
// the seamless account switch) never serves the old home's slots.
let cache: {
  path: string
  mtimeMs: number
  size: number
  slots: PersistedSlots
  /** Raw entries under keys that are NOT live slot roles (e.g. the retired
   *  party seats): preserved verbatim through the write path so a scribe/
   *  implementer reslot never repaints an operator's historical rows away. */
  passengers: Record<string, unknown>
} | null = null

/** Test seam: drop the read cache (proofs that rewrite the file in-place). */
export function __resetSeatSlotStoreCache(): void {
  cache = null
}

const isSlotRole = (v: unknown): v is SlotRole =>
  typeof v === 'string' && (SLOT_ROLES as readonly string[]).includes(v)

function decodeSlots(raw: unknown): { slots: PersistedSlots; passengers: Record<string, unknown> } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { slots: {}, passengers: {} }
  const slots = (raw as Record<string, unknown>).slots
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) return { slots: {}, passengers: {} }
  const out: PersistedSlots = {}
  const passengers: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(slots as Record<string, unknown>)) {
    if (!isSlotRole(k)) {
      // Not a live role (retired party seats, forward-compat keys): the
      // TYPED read exposes nothing, but the raw entry rides the write path
      // untouched — an operator's file is never repainted.
      passengers[k] = v
      continue
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
    const e = v as Record<string, unknown>
    const entry: PersistedSlot = {
      ...(typeof e.model === 'string' && e.model.trim()
        ? { model: e.model.trim().slice(0, 80) }
        : {}),
      ...(typeof e.effort === 'string' && e.effort.trim()
        ? { effort: e.effort.trim().slice(0, 16) }
        : {}),
    }
    if (entry.model !== undefined || entry.effort !== undefined) out[k] = entry
  }
  return { slots: out, passengers }
}

/**
 * Read the persisted slots, RAW (unvalidated — the seatSlots resolvers fail
 * junk closed with notes). Absent or damaged file ⇒ {} — the middle tier
 * simply contributes nothing; the resolvers fall to the ratified defaults.
 */
export function readPersistedSeatSlots(): PersistedSlots {
  const path = seatSlotsPath()
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(path)
  } catch {
    cache = null
    return {}
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.slots
  }
  let decoded: { slots: PersistedSlots; passengers: Record<string, unknown> } = { slots: {}, passengers: {} }
  try {
    decoded = decodeSlots(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    decoded = { slots: {}, passengers: {} }
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, slots: decoded.slots, passengers: decoded.passengers }
  return decoded.slots
}

/**
 * Merge-write one role's slot (RMW over the live file; durable atomic
 * publish). `null` clears an axis; a slot with neither axis left is removed.
 * Callers validate BEFORE calling (seatSlots.setOperatorSeatSlot is the one
 * write path). Returns the written slot map. Throws only on a publish fault
 * (DurablePublishError) — callers surface it honestly.
 */
export function writePersistedSeatSlot(
  role: SlotRole,
  patch: { model?: string | null; effort?: string | null },
): PersistedSlots {
  const current = readPersistedSeatSlots()
  const passengers = cache?.passengers ?? {}
  const prev = current[role] ?? {}
  const next: PersistedSlot = { ...prev }
  if (patch.model === null) delete next.model
  else if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim()
  if (patch.effort === null) delete next.effort
  else if (typeof patch.effort === 'string' && patch.effort.trim()) next.effort = patch.effort.trim()
  const slots: PersistedSlots = { ...current }
  if (next.model === undefined && next.effort === undefined) delete slots[role]
  else slots[role] = next
  durableAtomicPublishSync(
    seatSlotsPath(),
    // Passenger keys (retired/unknown roles) re-emit first so a live role can
    // never be shadowed; the operator's historical rows survive every write.
    JSON.stringify({ version: 1, slots: { ...passengers, ...slots }, updatedAt: Date.now() }, null, 2) + '\n',
  )
  cache = null
  return slots
}
