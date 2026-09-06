import { logForDebugging } from '../debug.js'
import { getCanonicalName } from './model.js'

export const NEVER_HAIKU_FALLBACK = 'claude-sonnet-5'

export type FloorEvent = {
  ts: number
  origin: string
  blocked: string
  fallback: string
}

const FLOOR_EVENT_CAP = 20
const floorEvents: FloorEvent[] = []

export function isHaikuTier(model: string): boolean {
  if (!model) return false
  const { declaredRouteOf } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  if (declaredRouteOf(model) !== 'anthropic') return false
  if (model.toLowerCase().includes('haiku')) return true
  const canonical = getCanonicalName(model).toLowerCase()
  if (canonical.includes('haiku')) return true
  if (/claude-(?:opus|sonnet|fable)/.test(canonical)) return false
  return matchesHaikuSlotPin(model)
}

const HAIKU_SLOT_ENV_PINS = [
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_SMALL_FAST_MODEL',
] as const

const PIN_ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

function matchesHaikuSlotPin(model: string): boolean {
  const bare = model.trim().replace(PIN_ANNOTATION_RE, '').toLowerCase()
  if (bare === '') return false
  for (const pin of HAIKU_SLOT_ENV_PINS) {
    const value = process.env[pin]?.trim().replace(PIN_ANNOTATION_RE, '').toLowerCase()
    if (value !== undefined && value !== '' && value === bare) return true
  }
  return false
}

export function enforceSubagentModelFloor(
  resolved: string,
  origin: string,
): string {
  
  if (!isHaikuTier(resolved)) return resolved
  const event: FloorEvent = {
    ts: Date.now(),
    origin,
    blocked: resolved,
    fallback: NEVER_HAIKU_FALLBACK,
  }
  floorEvents.push(event)
  if (floorEvents.length > FLOOR_EVENT_CAP) {
    floorEvents.splice(0, floorEvents.length - FLOOR_EVENT_CAP)
  }
  logForDebugging(
    `[modelFloor] never-Haiku floor fired at ${origin}: '${resolved}' → '${NEVER_HAIKU_FALLBACK}'`,
  )
  return NEVER_HAIKU_FALLBACK
}

export function recentFloorEvents(): readonly FloorEvent[] {
  return floorEvents
}
