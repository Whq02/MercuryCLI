import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { readStoredMetaApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { keyLaneSlots, label } from './keyLane.js'

export function metaSlots(reads: AccountSlotReads): AccountSlot[] {
  const { metaEnvKey, metaMuseCodeFacts, resolveMetaAccount } = require('../meta/metaAccounts.js') as typeof import('../meta/metaAccounts.js')
  const ambient = reads.metaEnvKey ? undefined : metaEnvKey()
  const envKey = reads.metaEnvKey ? reads.metaEnvKey() : ambient?.key
  const storedKey = (reads.metaStoredKey ?? readStoredMetaApiKey)()
  const slots = keyLaneSlots({ family: 'meta', envVar: ambient?.name ?? 'MODEL_API_KEY', envKey, storedKey, storedRemoval: { route: 'meta-stored-key' } })
  const museCode = (reads.metaMuseCode ?? metaMuseCodeFacts)()
  if (museCode) {
    const active = (reads.metaActiveAccount ?? resolveMetaAccount)()?.kind === 'muse-code'
    if (active) {
      for (const slot of slots) {
        slot.active = false
        slot.stateNote = 'Muse Code sign-in selected'
      }
    }
    const tier = museCode.tierName ?? museCode.tierId ?? 'Muse Code'
    slots.unshift({
      family: 'meta',
      id: 'meta:muse-code',
      name: 'muse-code',
      kind: 'subscription',
      kindLabel: 'Muse Code sign-in',
      identity: label([tier, museCode.email]),
      ...(museCode.email ? { signInEmail: museCode.email } : {}),
      active,
      envPinned: false,
      signedIn: true,
      ...(active ? {} : { stateNote: 'API key selected' }),
      removal: { route: 'meta-muse-code' },
    })
  }
  return slots
}
