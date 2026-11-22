import { flagEnv } from '../substrate/flagRegistry.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'
import { notBuilt } from '../pi/holes.js'


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
  return notBuilt('src/utils/privacyLevel.ts:29')
}

export function isEssentialTrafficOnly(): boolean {
  return notBuilt('src/utils/privacyLevel.ts:34')
}

export function getEssentialTrafficOnlyReason(env: NodeJS.ProcessEnv = hostEnv()): string | null {
  return flagEnv(NONESSENTIAL_TRAFFIC_VAR, env) ? NONESSENTIAL_TRAFFIC_VAR : null
}
