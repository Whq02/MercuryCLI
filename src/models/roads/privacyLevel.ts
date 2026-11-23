import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

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
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function getPrivacyLevel(): PrivacyLevel {
  return flagEnv(NONESSENTIAL_TRAFFIC_VAR) ? 'essential-traffic' : 'default'
}

export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

export function getEssentialTrafficOnlyReason(env: NodeJS.ProcessEnv = hostEnv()): string | null {
  return flagEnv(NONESSENTIAL_TRAFFIC_VAR, env) ? NONESSENTIAL_TRAFFIC_VAR : null
}
