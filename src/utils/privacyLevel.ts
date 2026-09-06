import { flagEnabled } from '../substrate/flagRegistry.js'


type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

const NONESSENTIAL_TRAFFIC_VAR = 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env[NONESSENTIAL_TRAFFIC_VAR]) return 'essential-traffic'
  if (!flagEnabled('MERCURY_TELEMETRY')) return 'no-telemetry'
  return 'default'
}

export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

export function getEssentialTrafficOnlyReason(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[NONESSENTIAL_TRAFFIC_VAR] ? NONESSENTIAL_TRAFFIC_VAR : null
}
