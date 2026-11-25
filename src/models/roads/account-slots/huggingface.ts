import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { huggingfaceSignInExpired, huggingfaceSignInRow, huggingfaceStoredTokenIdentity, huggingfaceOauthIdentity } from '../huggingface/huggingfaceAccounts.js'
import { readStoredHuggingfaceApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { label } from './keyLane.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'
import { signInWords } from '../../wallet/identityWords.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function huggingfaceSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.huggingfaceEnvKey ? reads.huggingfaceEnvKey() : hostEnv().HF_TOKEN?.trim() || undefined
  const oauth = (reads.huggingfaceOauth ?? huggingfaceSignInRow)()
  const expired = oauth !== undefined && huggingfaceSignInExpired(oauth)
  const storedKey = (reads.huggingfaceStoredKey ?? readStoredHuggingfaceApiKey)()
  const identityOf = reads.huggingfaceStoredKeyIdentity ?? huggingfaceStoredTokenIdentity
  const slots: AccountSlot[] = []
  if (envKey) {
    const identity = identityOf(envKey)
    slots.push({
      family: 'huggingface',
      id: 'huggingface:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'token · env',
      identity: label(['HF_TOKEN (env)', identity?.username, maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'HF_TOKEN' },
    })
  }
  if (oauth) {
    const identity = (reads.huggingfaceOauthIdentity ?? huggingfaceOauthIdentity)()
    slots.push({
      family: 'huggingface',
      id: 'huggingface:oauth',
      name: identity?.username ?? 'hf',
      kind: 'oauth',
      kindLabel: 'OAuth',
      identity: signInWords('huggingface', 'oauth', identity?.username?.trim() || undefined),
      active: !envKey && !expired,
      envPinned: false,
      signedIn: !expired,
      ...(expired
        ? { expired: true, stateNote: 'access token expired with no refresh route — /logins reconnects Hugging Face' }
        : envKey
          ? { stateNote: 'shadowed — the environment variable wins' }
          : {}),
      removal: { route: 'huggingface-oauth' },
    })
  }
  if (storedKey) {
    const identity = identityOf(storedKey)
    slots.push({
      family: 'huggingface',
      id: 'huggingface:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'token',
      identity: label(['stored token (auth-scoped)', identity?.username, maskedKeyTail(storedKey)]),
      active: !envKey && (!oauth || expired),
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the environment variable wins' }
        : oauth && !expired
          ? { stateNote: 'shadowed — the OAuth sign-in wins' }
          : {}),
      removal: { route: 'huggingface-stored-key' },
    })
  }
  return slots
}
