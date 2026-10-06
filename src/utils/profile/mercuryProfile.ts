
import type { MercuryAppearanceSnapshot } from './appearanceSnapshot.js'

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
  changedAt: number
}

export function resolveMercurySessionProfile(
  appearance: MercuryAppearanceSnapshot,
): MercurySessionProfile {
  return Object.freeze({
    identity: MERCURY_BEHAVIOR_PROFILE,
    appearance,
    changedAt: appearance.changedAt,
  })
}
