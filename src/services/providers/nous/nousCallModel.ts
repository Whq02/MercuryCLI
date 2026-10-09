import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildOpenrouterExtras } from '../openaicompat/compatWire.js'
import { nousChatCompletionsUrl, resolveNousAccount, resolveNousCredential } from './nousAccounts.js'
import { NOUS_MODEL_PREFIX, nousDeclaresTools, nousEffortVocabularyFor, nousWireModelId, refreshNousCatalogue } from './nousCatalogue.js'
import { NOUS_KEY_LEG_OFFER } from './nousLogin.js'
import { NOUS_SIGNIN_EXPIRED_LINE, nousRefreshTrouble, refreshNousTokens } from './nousOauth.js'
import { refreshNousAccount } from './nousUsageState.js'

export const NOUS_SIGNIN_AUTH_REMEDY = `${NOUS_SIGNIN_EXPIRED_LINE}; the Portal refused the sign-in token.`

export function nousSigninCredentialHint(): string {
  const trouble = nousRefreshTrouble()
  return trouble === undefined ? `${NOUS_SIGNIN_EXPIRED_LINE}.` : `${trouble}. ${NOUS_KEY_LEG_OFFER}`
}

export const nousLaneProfile: CompatLaneProfile = {
  lane: 'nous',
  providerLabel: 'Nous Portal',
  resolveCredential: async () => {
    try {
      const credential = await resolveNousCredential()
      return credential ? { apiKey: credential.key, requestUrl: nousChatCompletionsUrl(undefined, credential.source) } : undefined
    } catch {
      return undefined
    }
  },
  credentialHint: 'no Nous Portal API key detected — /logins nous stores one (portal.nousresearch.com issues them), or set NOUS_API_KEY.',
  authRemedy: 'the Portal answers 401 for a key that is invalid, blocked, or out of funds — top up or renew the subscription at portal.nousresearch.com, or store another key at /logins nous (NOUS_API_KEY wins over the store).',
  billingRemedy: 'the Nous Portal account is out of credits — top up or renew the subscription at portal.nousresearch.com, then retry; /model picks another model meanwhile.',
  requestUrl: () => nousChatCompletionsUrl(),
  wireModelId: modelId => nousWireModelId(modelId),
  buildExtras: args =>
    buildOpenrouterExtras({
      ...args,
      vocabulary: nousEffortVocabularyFor(`${NOUS_MODEL_PREFIX}${args.wireModel}`),
    }),
  toolCapabilityRefusal: wireModel =>
    nousDeclaresTools(`${NOUS_MODEL_PREFIX}${wireModel}`) === false
      ? `the Nous Portal catalogue states that '${wireModel}' does not take tools — /model picks a row whose supported parameters list tools.`
      : undefined,
  onResponseHeaders: () => {
    void refreshNousAccount().catch(() => {})
    void refreshNousCatalogue().catch(() => {})
  },
}

export const nousSigninLaneProfile: CompatLaneProfile = {
  ...nousLaneProfile,
  resolveCredential: async () => {
    if (resolveNousAccount()?.kind !== 'signin') return undefined
    return nousLaneProfile.resolveCredential()
  },
  recoverCredential: async () => {
    if (resolveNousAccount()?.kind !== 'signin') return undefined
    try {
      const tokens = await refreshNousTokens(undefined, true)
      return tokens?.refreshToken ? { apiKey: tokens.accessToken, requestUrl: nousChatCompletionsUrl(undefined, 'signin') } : undefined
    } catch {
      return undefined
    }
  },
  credentialHint: `${NOUS_SIGNIN_EXPIRED_LINE}.`,
  authRemedy: NOUS_SIGNIN_AUTH_REMEDY,
}

function nousSigninProfileNow(): CompatLaneProfile {
  return { ...nousSigninLaneProfile, credentialHint: nousSigninCredentialHint() }
}

export function nousLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('nous')
}

export async function* nousCallModel(params: CallModelParams): CallModelStream {
  if (params.signal.aborted) return
  yield* compatChatCallModel(resolveNousAccount()?.kind === 'signin' ? nousSigninProfileNow() : nousLaneProfile, params)
}
