import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { readStoredZaiApiKey, readStoredZaiKeyPlan } from '../../sign-in/account-ledger/providerSecrets.js'
import { label } from './keyLane.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function zaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.zaiEnvKey ? reads.zaiEnvKey() : hostEnv().ZAI_API_KEY?.trim() || undefined
  const storedKey = (reads.zaiStoredKey ?? readStoredZaiApiKey)()
  const storedPlan = (reads.zaiStoredKeyPlan ?? readStoredZaiKeyPlan)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'zai',
      id: 'zai:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['ZAI_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'ZAI_API_KEY' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'zai',
      id: 'zai:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: storedPlan === 'coding' ? 'Coding Plan key' : 'API key',
      identity: label([
        storedPlan === 'coding' ? 'GLM Coding Plan key (auth-scoped)' : 'stored key (auth-scoped)',
        maskedKeyTail(storedKey),
      ]),
      active: !envKey,
      envPinned: false,
      signedIn: true,
      ...(envKey ? { stateNote: 'shadowed — the environment variable wins' } : {}),
      removal: { route: 'zai-stored-key' },
    })
  }
  return slots
}
