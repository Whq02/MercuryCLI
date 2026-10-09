import { flagEnv } from '../substrate/flagRegistry.js'


type PrivacyLevel = 'default' | 'essential-traffic'

const NONESSENTIAL_TRAFFIC_VAR = 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'
const PROOF_SHAPE_VAR = 'MERCURY_LOCAL_PROBE_TARGETS'

export function isProofShapeRun(): boolean {
  return flagEnv(PROOF_SHAPE_VAR) !== undefined
}

export function proofShapeReason(): string {
  return `${PROOF_SHAPE_VAR} is set — a proof run reaches no host off the box`
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.')
  } catch {
    return false
  }
}

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env[NONESSENTIAL_TRAFFIC_VAR]) return 'essential-traffic'
  return 'default'
}

export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

export function getEssentialTrafficOnlyReason(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[NONESSENTIAL_TRAFFIC_VAR] ? NONESSENTIAL_TRAFFIC_VAR : null
}
