import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { resolveLocalAccount } from '../local/localAccounts.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredLocalApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { keyLaneSlots } from './keyLane.js'

export function localSlots(reads: AccountSlotReads): AccountSlot[] {
  const account = (reads.localAccount ?? resolveLocalAccount)()
  const envKey =
    reads.localEnvKey ? reads.localEnvKey() : flagEnv('MERCURY_LOCAL_API_KEY')?.trim() || undefined
  const storedKey = (reads.localStoredKey ?? readStoredLocalApiKey)()
  const slots: AccountSlot[] = []
  if (account) {
    slots.push({
      family: 'local',
      id: 'local:servers',
      name: 'servers',
      kind: 'api-key',
      kindLabel: account.kind === 'keyless' ? 'keyless' : 'key',
      identity: `${account.label} · discovered live`,
      active: true,
      envPinned: false,
      signedIn: true,
      removal: {
        route: 'owner',
        note: 'discovered live — stop the server (or unset MERCURY_LOCAL_BASE_URL) and the row leaves on the next probe',
      },
    })
  }
  slots.push(
    ...keyLaneSlots({
      family: 'local',
      envVar: 'MERCURY_LOCAL_API_KEY',
      envKey,
      storedKey,
      storedRemoval: { route: 'local-stored-key' },
    }),
  )
  return slots
}
