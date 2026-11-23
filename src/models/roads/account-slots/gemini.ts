import { looksLikeProofFixtureKey, label } from './keyLane.js'
import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { geminiOauthConnected, geminiPlanFacts, resolveGeminiAccount, geminiPlanLabel } from '../gemini/geminiAccounts.js'
import { readStoredGeminiApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

function geminiStoredNote(storedKey: string, shadowed: boolean): string | undefined {
  const notes: string[] = []
  if (shadowed) notes.push('shadowed — an environment variable wins')
  if (looksLikeProofFixtureKey(storedKey)) notes.push('a test key (zz-SECRE…), not a real Gemini API key — ⌫ removes it')
  return notes.length > 0 ? notes.join(' · ') : undefined
}

export function geminiSlots(reads: AccountSlotReads): AccountSlot[] {
  const oauthConnected = (reads.geminiOauthConnected ?? geminiOauthConnected)()
  const plan = (reads.geminiPlanFacts ?? geminiPlanFacts)()
  const active = (reads.geminiActiveAccount ?? resolveGeminiAccount)()
  const envGoogle = reads.geminiEnvGoogleKey
    ? reads.geminiEnvGoogleKey()
    : hostEnv().GOOGLE_API_KEY?.trim() || undefined
  const envGemini = reads.geminiEnvGeminiKey
    ? reads.geminiEnvGeminiKey()
    : hostEnv().GEMINI_API_KEY?.trim() || undefined
  const storedKey = (reads.geminiStoredKey ?? readStoredGeminiApiKey)()
  const slots: AccountSlot[] = []
  if (plan) {
    slots.push({
      family: 'gemini',
      id: 'gemini:plan',
      name: 'google',
      kind: 'subscription',
      kindLabel: 'Google sign-in',
      identity: label([geminiPlanLabel(plan), plan.email]),
      ...(plan.email ? { signInEmail: plan.email } : {}),
      active: active?.kind === 'plan',
      envPinned: false,
      signedIn: true,
      removal: { route: 'gemini-plan' },
    })
  }
  if (oauthConnected) {
    slots.push({
      family: 'gemini',
      id: 'gemini:oauth',
      name: 'google',
      kind: 'oauth',
      kindLabel: 'OAuth',
      identity: 'Google account (OAuth)',
      active: active?.kind === 'oauth',
      envPinned: false,
      signedIn: true,
      removal: { route: 'gemini-oauth' },
    })
  }
  if (envGoogle) {
    slots.push({
      family: 'gemini',
      id: 'gemini:env-google-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['GOOGLE_API_KEY (env)', maskedKeyTail(envGoogle)]),
      active: active?.kind === 'api-key' && active.keySource === 'env-google',
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'GOOGLE_API_KEY' },
    })
  }
  if (envGemini) {
    slots.push({
      family: 'gemini',
      id: 'gemini:env-gemini-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['GEMINI_API_KEY (env)', maskedKeyTail(envGemini)]),
      active: active?.kind === 'api-key' && active.keySource === 'env-gemini',
      envPinned: true,
      signedIn: true,
      ...(envGoogle
        ? { stateNote: 'shadowed — GOOGLE_API_KEY wins (the documented precedence)' }
        : {}),
      removal: { route: 'env', envVar: 'GEMINI_API_KEY' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'gemini',
      id: 'gemini:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: active?.kind === 'api-key' && active.keySource === 'stored',
      envPinned: false,
      signedIn: true,
      ...(geminiStoredNote(storedKey, Boolean(envGoogle || envGemini)) !== undefined
        ? { stateNote: geminiStoredNote(storedKey, Boolean(envGoogle || envGemini))! }
        : {}),
      removal: { route: 'gemini-stored-key' },
    })
  }
  return slots
}
