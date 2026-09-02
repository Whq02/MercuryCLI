
import type { MercuryAppearanceSnapshot } from './appearanceSnapshot.js'
import type { HarnessProfileResolution } from '../../services/mission/harnessProfiles.js'

export type MercuryBehaviorProfile = {
  productName: 'Mercury'
  outcomeLoyalty: 'candid-completion'
  scopeFidelity: true
  communicationRegister: 'operator-native'
  completionPolicy: 'finish-or-name-real-blocker'
}

export const MERCURY_BEHAVIOR_PROFILE: MercuryBehaviorProfile = Object.freeze({
  productName: 'Mercury',
  outcomeLoyalty: 'candid-completion',
  scopeFidelity: true,
  communicationRegister: 'operator-native',
  completionPolicy: 'finish-or-name-real-blocker',
})

export type MercurySessionProfile = {
  identity: MercuryBehaviorProfile
  appearance: MercuryAppearanceSnapshot
  harness?: HarnessProfileResolution
  changedAt: number
}

export function resolveMercurySessionProfile(
  appearance: MercuryAppearanceSnapshot,
  harness?: HarnessProfileResolution | null,
): MercurySessionProfile {
  return Object.freeze({
    identity: MERCURY_BEHAVIOR_PROFILE,
    appearance,
    ...(harness ? { harness } : {}),
    changedAt: appearance.changedAt,
  })
}
