import type { SlotRemoval, AccountSlot, AccountSlotReads } from './shapes.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'
import { readStoredMistralApiKey, readStoredMistralAdminApiKey, readStoredNousApiKey, readStoredZenApiKey, readStoredMinimaxApiKey, readStoredTogetherApiKey, readStoredCohereApiKey, readStoredGroqApiKey, readStoredMeliousApiKey, readStoredOrcarouterApiKey, readStoredCerebrasApiKey, readStoredFireworksApiKey, readStoredQwenApiKey, readStoredDeepseekApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { nousStoredTokens, readPreferredNousSource, nousSigninRefusal, NOUS_SIGNIN_EXPIRED_LINE } from '../nous/nousOauth.js'
import { qwenBoundPlanLabel } from '../qwen/qwenAccounts.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export const label = (parts: (string | undefined)[]): string => parts.filter(Boolean).join(' ')

export function keyLaneSlots(args: {
  family: string
  envVar: string
  envKey: string | undefined
  storedKey: string | undefined
  storedRemoval: SlotRemoval
}): AccountSlot[] {
  const slots: AccountSlot[] = []
  if (args.envKey) {
    slots.push({
      family: args.family,
      id: `${args.family}:env-key`,
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label([`${args.envVar} (env)`, maskedKeyTail(args.envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: args.envVar },
    })
  }
  if (args.storedKey) {
    slots.push({
      family: args.family,
      id: `${args.family}:stored-key`,
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(args.storedKey)]),
      active: !args.envKey,
      envPinned: false,
      signedIn: true,
      ...(args.envKey ? { stateNote: 'shadowed — the environment variable wins' } : {}),
      removal: args.storedRemoval,
    })
  }
  return slots
}

export function looksLikeProofFixtureKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith('zz-SECRETBYTES-')
}

export function mistralSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.mistralEnvKey ? reads.mistralEnvKey() : hostEnv().MISTRAL_API_KEY?.trim() || undefined
  const storedKey = (reads.mistralStoredKey ?? readStoredMistralApiKey)()
  const slots = keyLaneSlots({ family: 'mistral', envVar: 'MISTRAL_API_KEY', envKey, storedKey, storedRemoval: { route: 'mistral-stored-key' } })
  const adminEnv = reads.mistralAdminEnvKey ? reads.mistralAdminEnvKey() : hostEnv().MISTRAL_ADMIN_API_KEY?.trim() || undefined
  const adminStored = (reads.mistralAdminStoredKey ?? readStoredMistralAdminApiKey)()
  for (const [source, key] of [['env', adminEnv], ['stored', adminStored]] as const) {
    if (!key) continue
    slots.push({
      family: 'mistral', id: `mistral:admin-${source}`, name: 'admin', kind: 'api-key',
      kindLabel: `Admin API key${source === 'env' ? ' · env' : ''}`,
      identity: source === 'env' ? 'MISTRAL_ADMIN_API_KEY (env)' : 'stored Admin API key (auth-scoped)',
      active: false, envPinned: source === 'env', signedIn: true,
      stateNote: source === 'stored' && adminEnv ? 'usage only — shadowed by MISTRAL_ADMIN_API_KEY' : 'usage only — not an inference credential',
      removal: source === 'env' ? { route: 'env', envVar: 'MISTRAL_ADMIN_API_KEY' } : { route: 'mistral-admin-key' },
    })
  }
  return slots
}

export function nousSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.nousEnvKey ? reads.nousEnvKey() : hostEnv().NOUS_API_KEY?.trim() || undefined
  const storedKey = (reads.nousStoredKey ?? readStoredNousApiKey)()
  const slots = keyLaneSlots({ family: 'nous', envVar: 'NOUS_API_KEY', envKey, storedKey, storedRemoval: { route: 'nous-stored-key' } })
  const signin = (reads.nousSignin ?? nousStoredTokens)()
  if (signin) {
    const active = !envKey && (readPreferredNousSource() !== 'api-key' || !storedKey)
    const expired = !signin.refreshToken || nousSigninRefusal() !== undefined
    if (active) for (const slot of slots) { slot.active = false; slot.stateNote = 'Nous Portal sign-in selected' }
    slots.unshift({ family: 'nous', id: 'nous:signin', name: 'sign-in', kind: 'oauth', kindLabel: 'Nous Portal sign-in',
      identity: signin.accountId !== undefined ? `Nous Portal account ${signin.accountId}` : 'Nous Portal account', active: active && !expired, envPinned: false, signedIn: !expired,
      ...(expired ? { stateNote: NOUS_SIGNIN_EXPIRED_LINE } : {}), removal: { route: 'nous-signin' } })
  }
  return slots
}

export function zenSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.zenEnvKey ? reads.zenEnvKey() : hostEnv().OPENCODE_API_KEY?.trim() || undefined
  const storedKey = (reads.zenStoredKey ?? readStoredZenApiKey)()
  return keyLaneSlots({ family: 'zen', envVar: 'OPENCODE_API_KEY', envKey, storedKey, storedRemoval: { route: 'zen-stored-key' } })
}

export function minimaxSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.minimaxEnvKey ? reads.minimaxEnvKey() : hostEnv().MINIMAX_API_KEY?.trim() || undefined
  const storedKey = (reads.minimaxStoredKey ?? readStoredMinimaxApiKey)()
  return keyLaneSlots({ family: 'minimax', envVar: 'MINIMAX_API_KEY', envKey, storedKey, storedRemoval: { route: 'minimax-stored-key' } })
}

export function togetherSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.togetherEnvKey ? reads.togetherEnvKey() : hostEnv().TOGETHER_API_KEY?.trim() || hostEnv().TOGETHER_AI_API_KEY?.trim() || undefined
  const storedKey = (reads.togetherStoredKey ?? readStoredTogetherApiKey)()
  return keyLaneSlots({ family: 'together', envVar: hostEnv().TOGETHER_API_KEY?.trim() ? 'TOGETHER_API_KEY' : hostEnv().TOGETHER_AI_API_KEY?.trim() ? 'TOGETHER_AI_API_KEY' : 'TOGETHER_API_KEY', envKey, storedKey, storedRemoval: { route: 'together-stored-key' } })
}

export function cohereSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.cohereEnvKey ? reads.cohereEnvKey() : hostEnv().COHERE_API_KEY?.trim() || hostEnv().CO_API_KEY?.trim() || undefined
  const storedKey = (reads.cohereStoredKey ?? readStoredCohereApiKey)()
  return keyLaneSlots({ family: 'cohere', envVar: hostEnv().COHERE_API_KEY?.trim() ? 'COHERE_API_KEY' : hostEnv().CO_API_KEY?.trim() ? 'CO_API_KEY' : 'COHERE_API_KEY', envKey, storedKey, storedRemoval: { route: 'cohere-stored-key' } })
}

export function groqSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.groqEnvKey ? reads.groqEnvKey() : hostEnv().GROQ_API_KEY?.trim() || undefined
  const storedKey = (reads.groqStoredKey ?? readStoredGroqApiKey)()
  return keyLaneSlots({ family: 'groq', envVar: 'GROQ_API_KEY', envKey, storedKey, storedRemoval: { route: 'groq-stored-key' } })
}

export function meliousSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.meliousEnvKey ? reads.meliousEnvKey() : hostEnv().MELIOUS_API_KEY?.trim() || undefined
  const storedKey = (reads.meliousStoredKey ?? readStoredMeliousApiKey)()
  return keyLaneSlots({ family: 'melious', envVar: 'MELIOUS_API_KEY', envKey, storedKey, storedRemoval: { route: 'melious-stored-key' } })
}

export function orcarouterSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.orcarouterEnvKey ? reads.orcarouterEnvKey() : hostEnv().ORCAROUTER_API_KEY?.trim() || undefined
  const storedKey = (reads.orcarouterStoredKey ?? readStoredOrcarouterApiKey)()
  return keyLaneSlots({ family: 'orcarouter', envVar: 'ORCAROUTER_API_KEY', envKey, storedKey, storedRemoval: { route: 'orcarouter-stored-key' } })
}

export function cerebrasSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.cerebrasEnvKey ? reads.cerebrasEnvKey() : hostEnv().CEREBRAS_API_KEY?.trim() || undefined
  const storedKey = (reads.cerebrasStoredKey ?? readStoredCerebrasApiKey)()
  return keyLaneSlots({ family: 'cerebras', envVar: 'CEREBRAS_API_KEY', envKey, storedKey, storedRemoval: { route: 'cerebras-stored-key' } })
}

export function fireworksSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.fireworksEnvKey ? reads.fireworksEnvKey() : hostEnv().FIREWORKS_API_KEY?.trim() || undefined
  const storedKey = (reads.fireworksStoredKey ?? readStoredFireworksApiKey)()
  return keyLaneSlots({ family: 'fireworks', envVar: 'FIREWORKS_API_KEY', envKey, storedKey, storedRemoval: { route: 'fireworks-stored-key' } })
}

export function qwenSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.qwenEnvKey ? reads.qwenEnvKey() : hostEnv().DASHSCOPE_API_KEY?.trim() || undefined
  const storedKey = (reads.qwenStoredKey ?? readStoredQwenApiKey)()
  const slots = keyLaneSlots({ family: 'qwen', envVar: 'DASHSCOPE_API_KEY', envKey, storedKey, storedRemoval: { route: 'qwen-stored-key' } })
  const plan = qwenBoundPlanLabel()
  if (plan !== undefined) {
    for (const slot of slots) {
      slot.kindLabel = `${plan.kind} · ${slot.kindLabel}`
      slot.identity = label([slot.envPinned ? `DASHSCOPE_API_KEY (env, ${plan.endpoint})` : `${plan.kind} key (auth-scoped, ${plan.endpoint})`, maskedKeyTail(slot.envPinned ? envKey! : storedKey!)])
    }
  }
  return slots
}

export function deepseekSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.deepseekEnvKey ? reads.deepseekEnvKey() : hostEnv().DEEPSEEK_API_KEY?.trim() || undefined
  const storedKey = (reads.deepseekStoredKey ?? readStoredDeepseekApiKey)()
  return keyLaneSlots({
    family: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    envKey,
    storedKey,
    storedRemoval: { route: 'deepseek-stored-key' },
  })
}
