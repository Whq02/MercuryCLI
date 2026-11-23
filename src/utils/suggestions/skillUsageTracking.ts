import { getGlobalConfig, saveGlobalConfig } from '../config.js'


type SkillUsageRecord = Record<string, { usageCount: number; lastUsedAt: number }>

const RECORD_DEBOUNCE_MS = 60_000
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000
const RECENCY_FACTOR_FLOOR = 0.1

const lastRecordedAt = new Map<string, number>()

export function recordSkillUsage(skillName: string): void {
  const now = Date.now()
  const last = lastRecordedAt.get(skillName)
  if (last !== undefined && now - last < RECORD_DEBOUNCE_MS) return
  lastRecordedAt.set(skillName, now)
  saveGlobalConfig(current => {
    const existing: SkillUsageRecord = current.skillUsage ?? {}
    const prev = existing[skillName]
    return {
      ...current,
      skillUsage: {
        ...existing,
        [skillName]: {
          usageCount: (prev?.usageCount ?? 0) + 1,
          lastUsedAt: now,
        },
      },
    }
  })
}

export function getSkillUsageScore(skillName: string): number {
  const entry = getGlobalConfig().skillUsage?.[skillName]
  if (!entry || entry.usageCount <= 0) return 0
  const ageMs = Math.max(0, Date.now() - entry.lastUsedAt)
  const recencyFactor = Math.max(RECENCY_FACTOR_FLOOR, Math.pow(0.5, ageMs / HALF_LIFE_MS))
  return entry.usageCount * recencyFactor
}
