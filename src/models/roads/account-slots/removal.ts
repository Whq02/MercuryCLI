import { credentialStoreUnread, credentialsPath, getSecureStorage, removeSecureStorageField } from '../../../platform/secure-storage/index.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { saveGlobalConfig } from '../../../platform/config/globalConfig.js'
import { clearScopeIdentitySnapshot, forgetScopeIdentity } from '../../sign-in/account-ledger/accountIdentity.js'
import { removeApiKeySync } from '../../sign-in/credentials/auth.js'
import { dropCredentialMemos } from '../../sign-in/lifecycle/oauthLifecycle.js'
import { noteCredentialChange } from '../../sign-in/account-ledger/signInLedger.js'
import { resetUserCache } from '../../../platform/environment/user.js'
import { revokeOAuthToken } from '../../sign-in/oauth/client.js'
import type { AccountSlot, SlotRemovalOwners, AccountSlotKind } from './shapes.js'
import { disconnectOpenaiSubscription, openaiAuthPathForDisplay, resolveOpenaiApiKey } from '../openai/openaiAccounts.js'
import { writeStoredOpenaiApiKey, writeStoredZaiApiKey, writeStoredOpenrouterApiKey, writeStoredGeminiApiKey, writeStoredMoonshotApiKey, writeStoredMetaApiKey, writeStoredZenApiKey, writeStoredMinimaxApiKey, writeStoredTogetherApiKey, writeStoredCohereApiKey, writeStoredGroqApiKey, writeStoredMeliousApiKey, writeStoredOrcarouterApiKey, writeStoredCerebrasApiKey, writeStoredFireworksApiKey, writeStoredQwenApiKey, writeStoredDeepseekApiKey, writeStoredXaiApiKey, writeStoredXaiManagementApiKey, writeStoredNousApiKey, writeStoredCompatApiKey, writeStoredHuggingfaceApiKey, writeStoredLocalApiKey, writeStoredMistralApiKey, writeStoredMistralAdminApiKey, clearEveryStoredCompatKey, credentialFileUnwritten, probeCredentialJson, refuseUnreadSecretsStore, takeCredentialKeptAside } from '../../sign-in/account-ledger/providerSecrets.js'
import { disconnectOpenrouterOauthKey, openrouterAuthPathForDisplay } from '../openrouter/openrouterAccounts.js'
import { disconnectGeminiOauth, disconnectGeminiPlan, geminiAuthPathForDisplay } from '../gemini/geminiAccounts.js'
import { disconnectMoonshotOauth, moonshotAuthPathForDisplay } from '../moonshot/moonshotAccounts.js'
import { disconnectMetaMuseCode, metaAuthPathForDisplay } from '../meta/metaAccounts.js'
import { clearStoredXaiSubscription, xaiAuthPathForDisplay } from '../xai/xaiOauth.js'
import { clearStoredNousSignin, nousAuthPathForDisplay } from '../nous/nousOauth.js'
import { disconnectHuggingfaceOauth, huggingfaceAuthPathForDisplay } from '../huggingface/huggingfaceAccounts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export interface AnthropicSlotSignOutIo {
  revoke?: (refreshToken: string) => Promise<void>
}

export function credentialStoreLeftWords(where: 'keychain' | 'file'): string {
  return where === 'keychain'
    ? 'The keychain entry of Mercury could not be removed; the sign-ins it holds are still stored here. Unlock the keychain, then try again.'
    : `${credentialsPath()} could not be removed; the sign-ins it holds are still stored here. Close what holds the file, then try again.`
}

function refuseUnreadClaudeStore(): void {
  if (getSecureStorage().read()?.claudeAiOauth !== undefined) return
  const unread = credentialStoreUnread()
  if (unread !== null) throw Object.assign(new Error(unread.warning), { code: unread.code })
}

export function signOutAnthropicSlot(
  dir: string,
  io: AnthropicSlotSignOutIo = {},
): { loginLeft: boolean } {
  refuseUnreadClaudeStore()
  let refreshToken: string | null = null
  try {
    const stored = getSecureStorage().read()?.claudeAiOauth?.refreshToken
    refreshToken = typeof stored === 'string' && stored.length > 0 ? stored : null
  } catch (error) {
    logError(error)
  }
  let loginLeft = false
  let removal: ReturnType<typeof removeSecureStorageField> | undefined
  try {
    removal = removeSecureStorageField('claudeAiOauth')
    loginLeft = removal.removed
  } catch (error) {
    logError(error)
  }
  if (removal !== undefined && !removal.success) {
    throw removal.kept === 0
      ? Object.assign(new Error((removal.left ?? []).map(credentialStoreLeftWords).join(' ')), { code: 'EUNKNOWN' })
      : credentialFileUnwritten(null, credentialsPath(), { code: removal.code })
  }
  try {
    saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
  } catch (error) {
    logError(error)
  }
  clearScopeIdentitySnapshot(dir)
  forgetScopeIdentity(dir)
  dropCredentialMemos()
  noteCredentialChange()
  resetUserCache()
  try {
    const { resetLimitsForCredentialSwitch } =
      require('../anthropic/anthropicLimits.js') as typeof import('../anthropic/anthropicLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    logError(error)
  }
  if (refreshToken !== null) {
    void (io.revoke ?? revokeOAuthToken)(refreshToken).catch(logError)
  }
  return { loginLeft }
}

function signOutRefusalOf(error: unknown): string | null {
  if (!(error instanceof Error) || typeof (error as NodeJS.ErrnoException).code !== 'string') return null
  return `Could not sign out: ${error.message}`
}

export function executeSlotRemoval(
  slot: AccountSlot,
  owners: SlotRemovalOwners = {},
): { note: string; mutated: boolean; refused?: true } {
  let outcome: { note: string; mutated: boolean }
  try {
    outcome = routeSlotRemoval(slot, owners)
  } catch (error) {
    const note = signOutRefusalOf(error)
    if (note === null) throw error
    return { note, mutated: false, refused: true }
  }
  if (outcome.mutated) afterCredentialLeft(slot)
  return outcome
}

const ACCOUNT_FILE_SIGN_OUTS: Readonly<Record<string, { path: () => string; signOuts: ReadonlyArray<() => void> }>> = {
  gemini: { path: geminiAuthPathForDisplay, signOuts: [disconnectGeminiOauth, disconnectGeminiPlan] },
  huggingface: { path: huggingfaceAuthPathForDisplay, signOuts: [disconnectHuggingfaceOauth] },
  moonshot: { path: moonshotAuthPathForDisplay, signOuts: [disconnectMoonshotOauth] },
  meta: { path: metaAuthPathForDisplay, signOuts: [disconnectMetaMuseCode] },
  openai: { path: openaiAuthPathForDisplay, signOuts: [disconnectOpenaiSubscription] },
  openrouter: { path: openrouterAuthPathForDisplay, signOuts: [disconnectOpenrouterOauthKey] },
  xai: { path: xaiAuthPathForDisplay, signOuts: [clearStoredXaiSubscription] },
  nous: { path: nousAuthPathForDisplay, signOuts: [clearStoredNousSignin] },
}

export function signOutAccountFileNoSlotReads(family: string): { refused: string } | { keptAside: string } | null {
  const refused: string[] = []
  const attempt = (signOut: () => void): boolean => {
    try {
      signOut()
      return true
    } catch (error) {
      const note = signOutRefusalOf(error)
      if (note === null) throw error
      refused.push(note)
      return false
    }
  }
  attempt(family === 'anthropic' ? refuseUnreadClaudeStore : refuseUnreadSecretsStore)
  const file = Object.hasOwn(ACCOUNT_FILE_SIGN_OUTS, family) ? ACCOUNT_FILE_SIGN_OUTS[family] : undefined
  const state = file === undefined ? 'absent' : probeCredentialJson(file.path()).state
  if (file !== undefined && state !== 'absent' && state !== 'ok') file.signOuts.every(attempt)
  if (refused.length > 0) return { refused: refused.join(' ') }
  const keptAside = file === undefined ? undefined : takeCredentialKeptAside(file.path())
  return keptAside === undefined ? null : { keptAside }
}

export function familiesRefusedIn(notes: readonly string[]): string[] | null {
  const families: string[] = []
  for (const note of notes) {
    const family = Object.keys(ACCOUNT_FILE_SIGN_OUTS).find(name => note.includes(ACCOUNT_FILE_SIGN_OUTS[name]!.path()))
    if (family === undefined) return null
    families.push(family)
  }
  return families
}

function afterCredentialLeft(slot: AccountSlot): void {
  forgetFamilyObservations(slot.family, slot.kind)
  try {
    const { clearCapHandoffForFamily } = require('../capFailover.js') as typeof import('../capFailover.js')
    clearCapHandoffForFamily(slot.family)
  } catch (error) {
    passedOver(error)
  }
}

function forgetFamilyObservations(family: string, kind: AccountSlotKind): void {
  try {
    switch (family) {
      case 'openai': {
        const { forgetOpenaiLimitSource } =
          require('../openai/openaiLimitState.js') as typeof import('../openai/openaiLimitState.js')
        forgetOpenaiLimitSource(kind === 'api-key' ? 'api-key' : 'chatgpt-subscription')
        return
      }
      case 'openrouter': {
        const { forgetOpenrouterObservedLimit } =
          require('../openrouter/openrouterUsageState.js') as typeof import('../openrouter/openrouterUsageState.js')
        forgetOpenrouterObservedLimit()
        return
      }
      case 'gemini': {
        const { forgetGeminiObservedLimit } =
          require('../gemini/geminiUsageState.js') as typeof import('../gemini/geminiUsageState.js')
        forgetGeminiObservedLimit()
        return
      }
      case 'huggingface': {
        const { forgetHuggingfaceObservedLimits } =
          require('../huggingface/huggingfaceUsageState.js') as typeof import('../huggingface/huggingfaceUsageState.js')
        forgetHuggingfaceObservedLimits()
        return
      }
      default:
        return
    }
  } catch (error) {
    passedOver(error)
  }
}

function routeSlotRemoval(
  slot: AccountSlot,
  owners: SlotRemovalOwners,
): { note: string; mutated: boolean } {
  const removal = slot.removal
  switch (removal.route) {
    case 'excluded':
    case 'owner':
    case 'settings':
      return { note: removal.note, mutated: false }
    case 'env':
      return {
        note: `${removal.envVar} is set in your shell — unset it in your shell to remove; Mercury never edits your environment`,
        mutated: false,
      }
    case 'anthropic-oauth': {
      const snapshot =
        slot.scope !== undefined && (slot.scope.uuid !== undefined || slot.scope.email !== undefined)
      if (!slot.signedIn && slot.expired !== true && !snapshot) {
        forgetScopeIdentity(removal.dir)
        return { note: 'not signed in — nothing to sign out (↵ signs in)', mutated: false }
      }
      let loginLeft = slot.signedIn
      if (owners.signOutAnthropicOauth) owners.signOutAnthropicOauth()
      else {
        loginLeft = signOutAnthropicSlot(removal.dir, {
          ...(owners.revokeAnthropicToken ? { revoke: owners.revokeAnthropicToken } : {}),
        }).loginLeft
      }
      return loginLeft
        ? {
            note: `signing out this Claude login — tokens ${slot.signedIn ? 'revoked and dropped' : 'dropped'}; the home, transcripts, and config stay (/logout stays the global verb)`,
            mutated: true,
          }
        : {
            note: 'no Claude login was stored here — the stale identity snapshot cleared; the home, transcripts, and config stay (↵ signs in)',
            mutated: true,
          }
    }
    case 'anthropic-managed-key':
      ;(owners.clearManagedAnthropicKey ?? removeApiKeySync)()
      return { note: 'clearing the /logins managed key (config + keychain)', mutated: true }
    case 'openai-subscription': {
      ;(owners.disconnectOpenaiSubscription ?? disconnectOpenaiSubscription)()
      const key = (owners.openaiApiKeyAfter ?? resolveOpenaiApiKey)()
      return {
        note: `ChatGPT subscription disconnected — tokens dropped.${key ? ` The OpenAI API key (${key.source}) still resolves as the api-key source.` : ''}`,
        mutated: true,
      }
    }
    case 'openai-stored-key':
      ;(owners.clearStoredOpenaiKey ?? (() => writeStoredOpenaiApiKey(null)))()
      return { note: 'stored OpenAI API key cleared from the auth-scoped store', mutated: true }
    case 'zai-stored-key':
      ;(owners.clearStoredZaiKey ?? (() => writeStoredZaiApiKey(null)))()
      return { note: 'stored Z.AI API key cleared from the auth-scoped store', mutated: true }
    case 'openrouter-oauth-key':
      ;(owners.disconnectOpenrouterOauthKey ?? disconnectOpenrouterOauthKey)()
      return {
        note: 'OAuth-minted OpenRouter key dropped locally — revoke it at openrouter.ai → Settings → Keys to kill it server-side',
        mutated: true,
      }
    case 'openrouter-stored-key':
      ;(owners.clearStoredOpenrouterKey ?? (() => writeStoredOpenrouterApiKey(null)))()
      return { note: 'stored OpenRouter API key cleared from the auth-scoped store', mutated: true }
    case 'gemini-oauth':
      ;(owners.disconnectGeminiOauth ?? disconnectGeminiOauth)()
      return {
        note: 'Google OAuth tokens dropped — full revocation lives at myaccount.google.com → Security → Third-party access',
        mutated: true,
      }
    case 'gemini-plan':
      ;(owners.disconnectGeminiPlan ?? disconnectGeminiPlan)()
      return {
        note: 'Google sign-in dropped — full revocation lives at myaccount.google.com → Security → Third-party access',
        mutated: true,
      }
    case 'gemini-stored-key':
      ;(owners.clearStoredGeminiKey ?? (() => writeStoredGeminiApiKey(null)))()
      return { note: 'stored Gemini API key cleared from the auth-scoped store', mutated: true }
    case 'moonshot-stored-key':
      ;(owners.clearStoredMoonshotKey ?? (() => writeStoredMoonshotApiKey(null)))()
      return { note: 'stored Moonshot API key cleared from the auth-scoped store', mutated: true }
    case 'moonshot-oauth':
      ;(owners.disconnectMoonshotOauth ?? disconnectMoonshotOauth)()
      return {
        note: 'Kimi sign-in disconnected — tokens dropped (the region choice stays remembered for the next /logins moonshot).',
        mutated: true,
      }
    case 'meta-muse-code':
      ;(owners.disconnectMetaMuseCode ?? disconnectMetaMuseCode)()
      return { note: 'Muse Code sign-in dropped — the minted key and account token are cleared locally', mutated: true }
    case 'meta-stored-key':
      ;(owners.clearStoredMetaKey ?? (() => writeStoredMetaApiKey(null)))()
      return { note: 'stored Meta API key cleared from the auth-scoped store', mutated: true }
    case 'zen-stored-key':
      ;(owners.clearStoredZenKey ?? (() => writeStoredZenApiKey(null)))()
      return { note: 'stored OpenCode Zen API key cleared from the auth-scoped store', mutated: true }
    case 'minimax-stored-key':
      ;(owners.clearStoredMinimaxKey ?? (() => writeStoredMinimaxApiKey(null)))()
      return { note: 'stored MiniMax API key cleared from the auth-scoped store', mutated: true }
    case 'together-stored-key':
      ;(owners.clearStoredTogetherKey ?? (() => writeStoredTogetherApiKey(null)))()
      return { note: 'stored Together AI API key cleared from the auth-scoped store', mutated: true }
    case 'cohere-stored-key':
      ;(owners.clearStoredCohereKey ?? (() => writeStoredCohereApiKey(null)))()
      return { note: 'stored Cohere API key cleared from the auth-scoped store', mutated: true }
    case 'groq-stored-key':
      ;(owners.clearStoredGroqKey ?? (() => writeStoredGroqApiKey(null)))()
      return { note: 'stored Groq API key cleared from the auth-scoped store', mutated: true }
    case 'melious-stored-key':
      ;(owners.clearStoredMeliousKey ?? (() => writeStoredMeliousApiKey(null)))()
      return { note: 'stored Melious AI API key cleared from the auth-scoped store', mutated: true }
    case 'orcarouter-stored-key':
      ;(owners.clearStoredOrcarouterKey ?? (() => writeStoredOrcarouterApiKey(null)))()
      return { note: 'OrcaRouter API key removed', mutated: true }
    case 'cerebras-stored-key':
      ;(owners.clearStoredCerebrasKey ?? (() => writeStoredCerebrasApiKey(null)))()
      return { note: 'stored Cerebras API key cleared from the auth-scoped store', mutated: true }
    case 'fireworks-stored-key':
      ;(owners.clearStoredFireworksKey ?? (() => writeStoredFireworksApiKey(null)))()
      return { note: 'stored Fireworks API key cleared from the auth-scoped store', mutated: true }
    case 'qwen-stored-key':
      ;(owners.clearStoredQwenKey ?? (() => writeStoredQwenApiKey(null)))()
      return { note: 'stored QwenCloud or Model Studio API key and its endpoint cleared from the auth-scoped store', mutated: true }
    case 'deepseek-stored-key':
      ;(owners.clearStoredDeepseekKey ?? (() => writeStoredDeepseekApiKey(null)))()
      return { note: 'stored DeepSeek API key cleared from the auth-scoped store', mutated: true }
    case 'xai-oauth':
      ;(owners.clearXaiSubscription ?? clearStoredXaiSubscription)()
      return { note: 'Grok sign-in forgotten locally; revoke the shared grant in your xAI account to end it server-side', mutated: true }
    case 'xai-stored-key':
      ;(owners.clearStoredXaiKey ?? (() => writeStoredXaiApiKey(null)))()
      return { note: 'stored xAI API key cleared from the auth-scoped store', mutated: true }
    case 'xai-management-key':
      ;(owners.clearStoredXaiManagementKey ?? (() => writeStoredXaiManagementApiKey(null)))()
      return { note: 'stored xAI management key cleared; the inference key stays', mutated: true }
    case 'nous-stored-key':
      ;(owners.clearStoredNousKey ?? (() => writeStoredNousApiKey(null)))()
      return { note: 'stored Nous Portal API key cleared from the auth-scoped store', mutated: true }
    case 'nous-signin':
      ;(owners.clearNousSignin ?? clearStoredNousSignin)()
      return { note: 'Nous Portal sign-in forgotten locally; the Portal account page ends it server-side', mutated: true }
    case 'compat-stored-key':
      ;(owners.clearStoredCompatKey ?? (() => writeStoredCompatApiKey(null, removal.endpoint)))()
      return { note: 'stored endpoint API key cleared from the auth-scoped store', mutated: true }
    case 'huggingface-oauth':
      ;(owners.disconnectHuggingfaceOauth ?? disconnectHuggingfaceOauth)()
      return {
        note: 'Hugging Face OAuth tokens dropped — revoke the grant at huggingface.co → Settings → Connected applications to kill it server-side',
        mutated: true,
      }
    case 'huggingface-stored-key':
      ;(owners.clearStoredHuggingfaceKey ?? (() => writeStoredHuggingfaceApiKey(null)))()
      return { note: 'stored Hugging Face token cleared from the auth-scoped store', mutated: true }
    case 'local-stored-key':
      ;(owners.clearStoredLocalKey ?? (() => writeStoredLocalApiKey(null)))()
      return { note: 'stored local-server key cleared from the auth-scoped store', mutated: true }
    case 'mistral-stored-key':
      ;(owners.clearStoredMistralKey ?? (() => writeStoredMistralApiKey(null)))()
      return { note: 'stored Mistral API key cleared from the auth-scoped store', mutated: true }
    case 'mistral-admin-key':
      ;(owners.clearStoredMistralAdminKey ?? (() => writeStoredMistralAdminApiKey(null)))()
      return { note: 'stored Mistral Admin API key cleared; the inference key stays', mutated: true }
  }
}

export function signOutEveryEngineCredential(owners: SlotRemovalOwners = {}): string[] {
  const steps: Array<[AccountSlot['removal']['route'], () => void]> = [
    ['openai-subscription', owners.disconnectOpenaiSubscription ?? disconnectOpenaiSubscription],
    ['openai-stored-key', owners.clearStoredOpenaiKey ?? (() => writeStoredOpenaiApiKey(null))],
    ['zai-stored-key', owners.clearStoredZaiKey ?? (() => writeStoredZaiApiKey(null))],
    ['openrouter-oauth-key', owners.disconnectOpenrouterOauthKey ?? disconnectOpenrouterOauthKey],
    ['openrouter-stored-key', owners.clearStoredOpenrouterKey ?? (() => writeStoredOpenrouterApiKey(null))],
    ['gemini-oauth', owners.disconnectGeminiOauth ?? disconnectGeminiOauth],
    ['gemini-plan', owners.disconnectGeminiPlan ?? disconnectGeminiPlan],
    ['gemini-stored-key', owners.clearStoredGeminiKey ?? (() => writeStoredGeminiApiKey(null))],
    ['moonshot-oauth', owners.disconnectMoonshotOauth ?? disconnectMoonshotOauth],
    ['moonshot-stored-key', owners.clearStoredMoonshotKey ?? (() => writeStoredMoonshotApiKey(null))],
    ['deepseek-stored-key', owners.clearStoredDeepseekKey ?? (() => writeStoredDeepseekApiKey(null))],
    ['xai-oauth', owners.clearXaiSubscription ?? clearStoredXaiSubscription],
    ['xai-stored-key', owners.clearStoredXaiKey ?? (() => writeStoredXaiApiKey(null))],
    ['xai-management-key', owners.clearStoredXaiManagementKey ?? (() => writeStoredXaiManagementApiKey(null))],
    ['meta-muse-code', owners.disconnectMetaMuseCode ?? disconnectMetaMuseCode],
    ['meta-stored-key', owners.clearStoredMetaKey ?? (() => writeStoredMetaApiKey(null))],
    ['zen-stored-key', owners.clearStoredZenKey ?? (() => writeStoredZenApiKey(null))],
    ['minimax-stored-key', owners.clearStoredMinimaxKey ?? (() => writeStoredMinimaxApiKey(null))],
    ['together-stored-key', owners.clearStoredTogetherKey ?? (() => writeStoredTogetherApiKey(null))],
    ['cohere-stored-key', owners.clearStoredCohereKey ?? (() => writeStoredCohereApiKey(null))],
    ['groq-stored-key', owners.clearStoredGroqKey ?? (() => writeStoredGroqApiKey(null))],
    ['melious-stored-key', owners.clearStoredMeliousKey ?? (() => writeStoredMeliousApiKey(null))],
    ['orcarouter-stored-key', owners.clearStoredOrcarouterKey ?? (() => writeStoredOrcarouterApiKey(null))],
    ['cerebras-stored-key', owners.clearStoredCerebrasKey ?? (() => writeStoredCerebrasApiKey(null))],
    ['fireworks-stored-key', owners.clearStoredFireworksKey ?? (() => writeStoredFireworksApiKey(null))],
    ['qwen-stored-key', owners.clearStoredQwenKey ?? (() => writeStoredQwenApiKey(null))],
    ['compat-stored-key', owners.clearStoredCompatKey ?? clearEveryStoredCompatKey],
    ['huggingface-oauth', owners.disconnectHuggingfaceOauth ?? disconnectHuggingfaceOauth],
    ['huggingface-stored-key', owners.clearStoredHuggingfaceKey ?? (() => writeStoredHuggingfaceApiKey(null))],
    ['local-stored-key', owners.clearStoredLocalKey ?? (() => writeStoredLocalApiKey(null))],
    ['mistral-stored-key', owners.clearStoredMistralKey ?? (() => writeStoredMistralApiKey(null))],
    ['mistral-admin-key', owners.clearStoredMistralAdminKey ?? (() => writeStoredMistralAdminApiKey(null))],
    ['nous-stored-key', owners.clearStoredNousKey ?? (() => writeStoredNousApiKey(null))],
    ['nous-signin', owners.clearNousSignin ?? clearStoredNousSignin],
  ]
  const refused: string[] = []
  for (const [, step] of steps) {
    try {
      step()
    } catch (error) {
      logError(error)
      const note = signOutRefusalOf(error)
      if (note !== null && !refused.includes(note)) refused.push(note)
    }
  }
  for (const [family, kind] of [
    ['openai', 'subscription'],
    ['openai', 'api-key'],
    ['openrouter', 'api-key'],
    ['gemini', 'oauth'],
    ['huggingface', 'oauth'],
  ] as const) {
    forgetFamilyObservations(family, kind)
  }
  return refused
}
