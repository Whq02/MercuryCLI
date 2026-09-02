import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome } from '../envUtils.js'

export const SLOT_ROLES = [
  'scribe',
  'implementer',
] as const
export type SlotRole = (typeof SLOT_ROLES)[number]

export type PersistedSlot = { model?: string; effort?: string }
export type PersistedSlots = Partial<Record<SlotRole, PersistedSlot>>

export function seatSlotsPath(): string {
  return join(getMercuryHome(), 'seat-slots.json')
}

let cache: {
  path: string
  mtimeMs: number
  size: number
  slots: PersistedSlots
  passengers: Record<string, unknown>
} | null = null

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
    JSON.stringify({ version: 1, slots: { ...passengers, ...slots }, updatedAt: Date.now() }, null, 2) + '\n',
  )
  cache = null
  return slots
}
