import type { ProviderFamilyPresence } from '../providerUsage.js'
import type { ProviderSnapshot } from '../modelRegistry.js'
import type { AccountSlot, AccountSlotKind } from './shapes.js'

export function genericSlots(
  family: ProviderFamilyPresence,
  provider: ProviderSnapshot['providers'][number] | undefined,
): AccountSlot[] {
  const account = provider?.description.account
  if (!account || account.kind === 'none') return []
  const kind: AccountSlotKind =
    account.kind === 'api-key' || account.kind === 'keyless'
      ? 'api-key'
      : account.kind === 'chatgpt-login'
        ? 'subscription'
        : 'oauth'
  return [
    {
      family: family.id,
      id: `${family.id}:account`,
      name: 'account',
      kind,
      kindLabel: kind === 'api-key' ? 'API key' : kind === 'subscription' ? 'subscription' : 'OAuth',
      identity: account.label,
      active: true,
      envPinned: false,
      signedIn: true,
      removal: {
        route: 'owner',
        note: `the ${family.id} credential lives with its owning store — see /capabilities for the route`,
      },
    },
  ]
}
