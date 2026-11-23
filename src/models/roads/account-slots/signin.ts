import { providerDisplayName } from '../routeLaw.js'
import type { ScopeIdentityState } from '../../sign-in/account-ledger/accountIdentity.js'
import type { AccountSlot } from './shapes.js'
import { PROVIDER_CREDENTIAL_ENV_VARS } from '../../sign-in/credentials/credentialEnvSpellings.js'

export function familyDisplayName(id: string): string {
  return providerDisplayName(id)
}

const FAMILY_SIGNIN_CEILINGS: Readonly<Record<string, number>> = {
  anthropic: 2,
  openai: 2,
}

export function familySigninCeiling(family: string): number | undefined {
  return FAMILY_SIGNIN_CEILINGS[family]
}

export type SlotIdentityRead = ScopeIdentityState | { state: 'checking' }

export type SlotIdentities = Readonly<Record<string, SlotIdentityRead | undefined>>

export type SlotSigninBasis =
  | 'verified-live'
  | 'credential-present'
  | 'checking'
  | 'expired'
  | 'signed-out'
  | 'unverified'
  | 'excluded'
  | 'absent'

export type SlotSigninState =
  | { signedIn: true; basis: 'verified-live' | 'credential-present' }
  | { signedIn: false; basis: Exclude<SlotSigninBasis, 'verified-live' | 'credential-present'> }

export function slotSigninState(slot: AccountSlot, identities: SlotIdentities): SlotSigninState {
  if (slot.scope === undefined) {
    return slot.signedIn
      ? { signedIn: true, basis: 'credential-present' }
      : { signedIn: false, basis: 'absent' }
  }
  if (slot.scope.foreignHarness) return { signedIn: false, basis: 'excluded' }
  if (!slot.signedIn) return { signedIn: false, basis: slot.expired === true ? 'expired' : 'signed-out' }
  const identity = identities[slot.id]
  switch (identity?.state) {
    case 'verified':
      return { signedIn: true, basis: 'verified-live' }
    case 'expired':
      return { signedIn: false, basis: 'expired' }
    case 'signed-out':
      return { signedIn: false, basis: 'signed-out' }
    case 'unverified':
      return { signedIn: false, basis: 'unverified' }
    default:
      return { signedIn: false, basis: 'checking' }
  }
}

export function scopeSlotTail(
  state: SlotSigninState,
  read: SlotIdentityRead | undefined,
  slot: Pick<AccountSlot, 'scope' | 'family' | 'signInEmail'>,
): string {
  const snapshot = slot.scope?.email
  const own = slot.signInEmail
  const memory = (recorded: string | undefined): string | undefined =>
    recorded !== undefined && recorded !== '' && recorded !== own ? `snapshot ${recorded}` : undefined
  const words = (...parts: Array<string | undefined>): string =>
    parts.filter((part): part is string => part !== undefined).join(' · ')
  switch (state.basis) {
    case 'excluded':
      return "another tool's credential scope — never billable from Mercury"
    case 'checking':
      return words(own, memory(snapshot), 'verifying identity…')
    case 'verified-live':
      return `${read?.state === 'verified' ? read.email : 'signed in'} · verified live · ↵ opens Logins to re-login · ⌫ signs out`
    case 'expired': {
      const recorded = memory(read?.state === 'expired' ? read.snapshotEmail : undefined)
      return words(`expired${own !== undefined ? ` — ${own}` : ''}${recorded !== undefined ? ` (${recorded})` : ''}`, 'not signed in', '↵ opens Logins to reauth')
    }
    case 'signed-out':
      return snapshot !== undefined
        ? `snapshot ${snapshot} — signed out · ↵ opens Logins to re-login · ⌫ clears the snapshot`
        : familyAbsentWords(slot.family)
    case 'absent':
      return familyAbsentWords(slot.family)
    case 'unverified':
      return read?.state === 'unverified'
        ? words(`unverified — ${read.note}`, own, memory(read.email), 'not counted as signed in')
        : 'unverified · not counted as signed in'
    case 'credential-present':
      return 'credential present'
  }
}

export function familyRouteWords(family: string): string {
  if (family === 'local') return 'Ollama · LM Studio · vLLM · llama.cpp, or MERCURY_LOCAL_BASE_URL'
  const { subModelConnectHome } =
    require('../../catalogue/subModelSlots.js') as typeof import('../../catalogue/subModelSlots.js')
  const home = subModelConnectHome(family)
  if (home.command === undefined) return home.note
  const envKey = (PROVIDER_CREDENTIAL_ENV_VARS as Partial<Record<string, readonly string[]>>)[family]?.[0]
  return envKey !== undefined ? `${home.command} or ${envKey}` : home.command
}

export function familyAbsentWords(family: string): string {
  const state = family === 'local' ? 'no server discovered' : 'not signed in'
  return `${state} · ↵ names the route — ${familyRouteWords(family)}`
}

export interface FamilySigninSummary {
  signedIn: number
  held: number
  checking: number
  unverified: number
}

export function familySigninSummary(
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): FamilySigninSummary {
  const summary: FamilySigninSummary = { signedIn: 0, held: 0, checking: 0, unverified: 0 }
  for (const slot of slots) {
    const state = slotSigninState(slot, identities)
    if (state.signedIn) {
      summary.signedIn += 1
      if (!slot.envPinned) summary.held += 1
    } else if (state.basis === 'checking') {
      summary.checking += 1
    } else if (state.basis === 'unverified') {
      summary.unverified += 1
    }
  }
  return summary
}

export function familySigninCount(
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): number {
  return familySigninSummary(slots, identities).held
}

export interface SigninCeilingRefusal {
  refused: true
  family: string
  ceiling: number
  current: number
  message: string
}

export function signinCeilingRefusal(
  family: string,
  currentSignins: number,
): SigninCeilingRefusal | undefined {
  const ceiling = familySigninCeiling(family)
  if (ceiling === undefined || currentSignins < ceiling) return undefined
  return {
    refused: true,
    family,
    ceiling,
    current: currentSignins,
    message: `${familyDisplayName(family)} is at its sign-in ceiling (${currentSignins}/${ceiling} concurrent) — sign out of one slot first (⌫ on /accounts); re-login of an existing slot is always allowed`,
  }
}
