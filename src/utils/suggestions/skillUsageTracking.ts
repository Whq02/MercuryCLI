import { getGlobalConfig, saveGlobalConfig } from '../config.js'

/**
 * Persisted skill usage counters and the recency-decayed ranking score.
 * The `skillUsage` record with `{ usageCount, lastUsedAt }` entries is
 * contract data — these field names live in users' existing global config,
 * and renaming them silently resets everyone's rankings.
 */

type SkillUsageRecord = Record<string, { usageCount: number; lastUsedAt: number }>

const RECORD_DEBOUNCE_MS = 60_000
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000
const RECENCY_FACTOR_FLOOR = 0.1

// Process-lifetime debounce marks: at most one persisted write per skill
// per minute — safe because the 7-day half-life makes sub-minute
// granularity irrelevant.
const lastRecordedAt = new Map<string, number>()

export function recordSkillUsage(skillName: string): void {
  const now = Date.now()
  const last = lastRecordedAt.get(skillName)
  if (last !== undefined && now - last < RECORD_DEBOUNCE_MS) return
  // Marked BEFORE the write — a failing write still consumes the window.
  lastRecordedAt.set(skillName, now)
  saveGlobalConfig(config => {
    const usage: SkillUsageRecord = { ...((config as { skillUsage?: SkillUsageRecord }).skillUsage ?? {}) }
    const entry = usage[skillName]
    usage[skillName] = { usageCount: (entry?.usageCount ?? 0) + 1, lastUsedAt: now }
    return { ...config, skillUsage: usage }
  })
}

/**
 * usageCount × an exponential 7-day-half-life recency factor, with the
 * FACTOR (not the product) floored at 0.1 so an old-but-heavily-used skill
 * is never dropped entirely. Unknown skills score 0.
 */
export function getSkillUsageScore(skillName: string): number {
  const usage = ((getGlobalConfig() as { skillUsage?: SkillUsageRecord }).skillUsage ?? {})[skillName]
  if (usage === undefined) return 0
  const ageMs = Date.now() - usage.lastUsedAt
  const recencyFactor = Math.max(RECENCY_FACTOR_FLOOR, Math.pow(0.5, ageMs / HALF_LIFE_MS))
  return usage.usageCount * recencyFactor
}
