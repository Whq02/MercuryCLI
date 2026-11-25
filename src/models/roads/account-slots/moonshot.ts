import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { moonshotSignInExpired, moonshotSignInRow, moonshotLoginRegion } from '../moonshot/moonshotAccounts.js'
import { readStoredMoonshotApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { label } from './keyLane.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'
import { signInWords, kimiHostWords } from '../../wallet/identityWords.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function moonshotSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.moonshotEnvKey ? reads.moonshotEnvKey() : hostEnv().MOONSHOT_API_KEY?.trim() || undefined
  const oauth = (reads.moonshotOauth ?? moonshotSignInRow)()
  const expired = oauth !== undefined && moonshotSignInExpired(oauth)
  const storedKey = (reads.moonshotStoredKey ?? readStoredMoonshotApiKey)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'moonshot',
      id: 'moonshot:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['MOONSHOT_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'MOONSHOT_API_KEY' },
    })
  }
  if (oauth) {
    const region = (reads.moonshotOauthRegion ?? moonshotLoginRegion)()
    slots.push({
      family: 'moonshot',
      id: 'moonshot:oauth',
      name: 'kimi',
      kind: 'oauth',
      kindLabel: 'Kimi sign-in',
      identity: signInWords('moonshot', 'oauth', undefined, kimiHostWords(region)),
      active: !envKey && !expired,
      envPinned: false,
      signedIn: !expired,
      ...(expired
        ? { stateNote: 'access token expired with no refresh route — /logins moonshot signs in again' }
        : envKey
          ? { stateNote: 'shadowed — the environment variable wins' }
          : {}),
      removal: { route: 'moonshot-oauth' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'moonshot',
      id: 'moonshot:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: !envKey && (!oauth || expired),
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the environment variable wins' }
        : oauth && !expired
          ? { stateNote: 'shadowed — the Kimi sign-in wins' }
          : {}),
      removal: { route: 'moonshot-stored-key' },
    })
  }
  return slots
}
