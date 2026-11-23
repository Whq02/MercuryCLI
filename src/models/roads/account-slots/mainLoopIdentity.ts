import { type CallModelRoute, declaredRouteOf } from '../routeLaw.js'
import { type ProviderFamilyPresence, presenceIdentityWords } from '../providerUsage.js'
import { type SlotIdentityRead, familyDisplayName } from './signin.js'

export type MainLoopIdentityBasis =
  | 'verified-live'
  | 'credential-present'
  | 'discovered-live'
  | 'checking'
  | 'expired'
  | 'unverified'
  | 'not-signed-in'
  | 'excluded'

export interface MainLoopIdentity {
  route: CallModelRoute | 'unrecognised'
  family: string
  text: string
  basis: MainLoopIdentityBasis
}

export interface MainLoopIdentityInput {
  model: string
  presences: readonly ProviderFamilyPresence[]
  currentScopeIdentity?: SlotIdentityRead | undefined
  currentScopeClaudeFamily?: boolean
}

function connectHomeWords(route: CallModelRoute | string): string {
  const { subModelConnectHome } =
    require('../../catalogue/subModelSlots.js') as typeof import('../../catalogue/subModelSlots.js')
  const home = subModelConnectHome(route)
  return home.command ?? home.note
}

export function mainLoopIdentity(input: MainLoopIdentityInput): MainLoopIdentity {
  const route = declaredRouteOf(input.model) ?? 'unrecognised'
  const family = familyDisplayName(route)
  const presence = input.presences.find(candidate => (candidate.id as string) === route)
  const notSignedIn = (): MainLoopIdentity => ({
    route,
    family,
    text: `not signed in — ${connectHomeWords(route)}`,
    basis: 'not-signed-in',
  })
  if (presence === undefined || !presence.credentialed) return notSignedIn()
  const label = presence.credentialLabel ?? 'credential present'
  if (route !== 'anthropic') {
    const words = presenceIdentityWords(presence, true) ?? label
    return route === 'local'
      ? { route, family, text: `${words} · discovered live`, basis: 'discovered-live' }
      : { route, family, text: `${words} · credential present`, basis: 'credential-present' }
  }
  if (!label.startsWith('Claude subscription')) {
    return { route, family, text: `${label} · credential present`, basis: 'credential-present' }
  }
  if (input.currentScopeClaudeFamily) {
    return {
      route,
      family,
      text: "another tool's credential scope — never billable from Mercury",
      basis: 'excluded',
    }
  }
  const identity = input.currentScopeIdentity
  const own = presence.identity
  const memory = (recorded: string | undefined): string | undefined =>
    recorded !== undefined && recorded !== '' && recorded !== own ? `snapshot ${recorded}` : undefined
  switch (identity?.state) {
    case 'verified':
      return { route, family, text: `${identity.email} · verified live`, basis: 'verified-live' }
    case 'expired': {
      const recorded = memory(identity.snapshotEmail)
      return {
        route,
        family,
        text: `not signed in — credential expired${own !== undefined ? ` · ${own}` : ''}${recorded !== undefined ? ` (${recorded})` : ''} · ↵ on the Anthropic slot reauths`,
        basis: 'expired',
      }
    }
    case 'signed-out':
      return notSignedIn()
    case 'unverified': {
      const recorded = memory(identity.email)
      return {
        route,
        family,
        text: `${label} · unverified — ${identity.note}${own !== undefined ? ` · ${own}` : ''}${recorded !== undefined ? ` · ${recorded}` : ''}`,
        basis: 'unverified',
      }
    }
    default:
      return {
        route,
        family,
        text: `${label}${own !== undefined ? ` · ${own}` : ''} · verifying identity…`,
        basis: 'checking',
      }
  }
}
