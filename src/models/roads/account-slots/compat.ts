import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { keyLaneSlots } from './keyLane.js'
import { readStoredCompatApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function compatSlots(reads: AccountSlotReads): AccountSlot[] {
  if (!reads.compatEnvKey && !reads.compatStoredKey) {
    const { configuredCompatEndpoints, compatKeyEnvName } = require('../openaicompat/compatAccounts.js') as typeof import('../openaicompat/compatAccounts.js')
    const endpoints = configuredCompatEndpoints().filter(endpoint => endpoint.named)
    if (endpoints.length > 0) return endpoints.flatMap(endpoint => {
      const envVar = endpoint.name === 'default' && flagEnv('MERCURY_COMPAT_API_KEY')?.trim() ? 'MERCURY_COMPAT_API_KEY' : compatKeyEnvName(endpoint.name)
      return keyLaneSlots({ family: 'openai-compat', envVar, envKey: hostEnv()[envVar]?.trim() || undefined, storedKey: readStoredCompatApiKey(endpoint.name), storedRemoval: { route: 'compat-stored-key', endpoint: endpoint.name } })
        .map(slot => ({ ...slot, id: `openai-compat:${endpoint.name}:${slot.id}`, name: endpoint.name, kindLabel: `${endpoint.label} · ${slot.kindLabel}` }))
    })
  }
  const envKey =
    reads.compatEnvKey ? reads.compatEnvKey() : flagEnv('MERCURY_COMPAT_API_KEY')?.trim() || undefined
  const storedKey = (reads.compatStoredKey ?? readStoredCompatApiKey)()
  return keyLaneSlots({
    family: 'openai-compat',
    envVar: 'MERCURY_COMPAT_API_KEY',
    envKey,
    storedKey,
    storedRemoval: { route: 'compat-stored-key' },
  })
}
