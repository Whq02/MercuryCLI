import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { readStoredXaiApiKey, readStoredXaiManagementApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { keyLaneSlots } from './keyLane.js'
import { xaiStoredTokens, readPreferredXaiSource } from '../xai/xaiOauth.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function xaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.xaiEnvKey ? reads.xaiEnvKey() : hostEnv().XAI_API_KEY?.trim() || undefined
  const storedKey = (reads.xaiStoredKey ?? readStoredXaiApiKey)()
  const slots = keyLaneSlots({ family: 'xai', envVar: 'XAI_API_KEY', envKey, storedKey, storedRemoval: { route: 'xai-stored-key' } })
  const oauth = (reads.xaiOauth ?? xaiStoredTokens)()
  if (oauth) {
    const active = readPreferredXaiSource() !== 'api-key' || !(envKey || storedKey)
    if (active) for (const slot of slots) { slot.active = false; slot.stateNote = 'Grok subscription selected' }
    slots.unshift({ family: 'xai', id: 'xai:oauth', name: 'subscription', kind: 'oauth', kindLabel: 'Grok subscription',
      identity: oauth.email ?? 'Grok account', active, envPinned: false, signedIn: Boolean(oauth.refreshToken),
      ...(oauth.refreshToken ? {} : { expired: true, stateNote: 'sign-in expired — /logins xai reconnects it' }), removal: { route: 'xai-oauth' } })
  }
  const managementEnv = reads.xaiManagementEnvKey ? reads.xaiManagementEnvKey() : hostEnv().XAI_MANAGEMENT_API_KEY?.trim() || undefined
  const managementStored = (reads.xaiManagementStoredKey ?? readStoredXaiManagementApiKey)()
  for (const [source, key] of [['env', managementEnv], ['stored', managementStored]] as const) {
    if (!key) continue
    slots.push({
      family: 'xai', id: `xai:management-${source}`, name: 'management', kind: 'api-key',
      kindLabel: `Management key${source === 'env' ? ' · env' : ''}`,
      identity: source === 'env' ? 'XAI_MANAGEMENT_API_KEY (env)' : 'stored management key (auth-scoped)',
      active: false, envPinned: source === 'env', signedIn: true,
      stateNote: source === 'stored' && managementEnv ? 'usage only — shadowed by XAI_MANAGEMENT_API_KEY' : 'usage only — not an inference credential',
      removal: source === 'env' ? { route: 'env', envVar: 'XAI_MANAGEMENT_API_KEY' } : { route: 'xai-management-key' },
    })
  }
  return slots
}
