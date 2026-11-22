import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { notBuilt } from '../../pi/holes.js'


type SkillUsageRecord = Record<string, { usageCount: number; lastUsedAt: number }>

const RECORD_DEBOUNCE_MS = 60_000
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000
const RECENCY_FACTOR_FLOOR = 0.1

export function recordSkillUsage(skillName: string): void {
  return notBuilt('src/utils/suggestions/skillUsageTracking.ts:12')
}

export function getSkillUsageScore(skillName: string): number {
  return notBuilt('src/utils/suggestions/skillUsageTracking.ts:25')
}
