import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { readMintedOpenrouterKey } from '../openrouter/openrouterAccounts.js'
import { readStoredOpenrouterApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { openrouterObservedKeyUsage } from '../openrouter/openrouterUsageState.js'
import { readSignInRefusal, signInRefusalWords } from '../signInRefusal.js'
import { label } from './keyLane.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function openrouterSlots(reads: AccountSlotReads = {}): AccountSlot[] {
  const envKey = reads.openrouterEnvKey
    ? reads.openrouterEnvKey()
    : hostEnv().OPENROUTER_API_KEY?.trim() || undefined
  const minted = (reads.openrouterMintedKey ?? readMintedOpenrouterKey)()
  const storedKey = (reads.openrouterStoredKey ?? readStoredOpenrouterApiKey)()
  const usableMinted = minted !== undefined && !minted.expiredMessage
  const observed = openrouterObservedKeyUsage()
  const refusal = readSignInRefusal('openrouter')
  const activeSource = envKey ? 'env' : usableMinted ? 'oauth' : storedKey ? 'stored' : undefined
  const failure = (source: 'env' | 'stored' | 'oauth') => {
    if (refusal !== undefined && source === activeSource) return signInRefusalWords(refusal, 'openrouter')
    return observed.errorSource === source ? observed.lastError : undefined
  }
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['OPENROUTER_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      ...(failure('env') ? { stateNote: failure('env')! } : {}),
      removal: { route: 'env', envVar: 'OPENROUTER_API_KEY' },
    })
  }
  if (minted) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:oauth-key',
      name: 'oauth',
      kind: 'oauth',
      kindLabel: 'OAuth-minted key',
      identity: label([
        `minted ${new Date(minted.mintedAtMs).toLocaleDateString()}`,
        maskedKeyTail(minted.key),
      ]),
      active: !envKey && usableMinted,
      envPinned: false,
      signedIn: usableMinted,
      ...(minted.expiredMessage
        ? { stateNote: `${minted.expiredMessage} · /logins openrouter: ⌫ removes it` }
        : envKey ? { stateNote: 'shadowed — the environment variable wins' }
          : failure('oauth') ? { stateNote: failure('oauth')! } : {}),
      removal: { route: 'openrouter-oauth-key' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: !envKey && !usableMinted,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the environment variable wins' }
        : usableMinted
          ? { stateNote: 'shadowed — the OAuth-minted key wins' }
          : failure('stored') ? { stateNote: failure('stored')! } : {}),
      removal: { route: 'openrouter-stored-key' },
    })
  }
  return slots
}
