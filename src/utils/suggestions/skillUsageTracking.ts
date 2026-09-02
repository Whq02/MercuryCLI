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
  saveGlobalConfig(config => {
    const usage: SkillUsageRecord = { ...((config as { skillUsage?: SkillUsageRecord }).skillUsage ?? {}) }
    const entry = usage[skillName]
    usage[skillName] = { usageCount: (entry?.usageCount ?? 0) + 1, lastUsedAt: now }
    return { ...config, skillUsage: usage }
  })
}

export function getSkillUsageScore(skillName: string): number {
  const usage = ((getGlobalConfig() as { skillUsage?: SkillUsageRecord }).skillUsage ?? {})[skillName]
  if (usage === undefined) return 0
  const ageMs = Date.now() - usage.lastUsedAt
  const recencyFactor = Math.max(RECENCY_FACTOR_FLOOR, Math.pow(0.5, ageMs / HALF_LIFE_MS))
  return usage.usageCount * recencyFactor
}
