
import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function isAutopilotEnabled(): boolean {
  
  return isEnvTruthy(flagEnv('MERCURY_AUTOPILOT'))
}

export const AUTOPILOT_TIER_KEYS = ['opus', 'sonnet', 'fable', 'fable51'] as const
export type AutopilotTierKey = (typeof AUTOPILOT_TIER_KEYS)[number]

const DEFAULT_ALLOWED: readonly AutopilotTierKey[] = ['opus', 'sonnet', 'fable', 'fable51']

export function autopilotAllowedModels(): readonly AutopilotTierKey[] {
  const raw = flagEnv('MERCURY_AUTOPILOT_MODELS')
  if (!raw || !raw.trim().replace(/^["']+|["']+$/g, '').trim()) return DEFAULT_ALLOWED
  const parsed = raw
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter((s): s is AutopilotTierKey =>
      (AUTOPILOT_TIER_KEYS as readonly string[]).includes(s),
    )
  return parsed
}
