/**
 * The three-level privacy posture, least to most restrictive. The
 * environment is read LIVE on every call so tests and runtime mutations take
 * effect immediately.
 */

type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

const NONESSENTIAL_TRAFFIC_VAR = 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env[NONESSENTIAL_TRAFFIC_VAR]) return 'essential-traffic'
  if (process.env.DISABLE_TELEMETRY) return 'no-telemetry'
  return 'default'
}

/** True only at the most restrictive level — skip auto-updates, release-note fetches, capability refreshes, surveys, analytics. */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

/** The literal variable name, so "unset X to re-enable" guidance stays actionable. */
export function getEssentialTrafficOnlyReason(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[NONESSENTIAL_TRAFFIC_VAR] ? NONESSENTIAL_TRAFFIC_VAR : null
}
