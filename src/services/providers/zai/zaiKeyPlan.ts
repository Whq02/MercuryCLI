import { credentialFingerprint } from '../credentialIdentity.js'

const ZAI_KEY_PLAN_ENV = 'ZAI_KEY_PLAN'
export type ZaiKeyPlanWord = 'general' | 'coding'
export type ZaiPlanSource = 'stored' | 'env' | 'learned' | 'assumed'

const PLAN_WORDS: ReadonlySet<string> = new Set<ZaiKeyPlanWord>(['general', 'coding'])

function planWordOf(env: Record<string, string | undefined>): string | undefined {
  const raw = env[ZAI_KEY_PLAN_ENV]?.trim().toLowerCase()
  return raw ? raw : undefined
}

function explicitZaiKeyPlan(env: Record<string, string | undefined> = process.env): ZaiKeyPlanWord | undefined {
  const word = planWordOf(env)
  return word !== undefined && PLAN_WORDS.has(word) ? (word as ZaiKeyPlanWord) : undefined
}

export function zaiKeyPlanUnknownWord(env: Record<string, string | undefined> = process.env): string | undefined {
  const word = planWordOf(env)
  if (word === undefined || PLAN_WORDS.has(word)) return undefined
  return `${ZAI_KEY_PLAN_ENV}=${word} is not a plan Mercury knows — coding (a GLM Coding Plan key) or general; unset it and the plan is read from the key's own models list`
}

const learnedPlans = new Map<string, ZaiKeyPlanWord>()

export function rememberZaiKeyPlan(key: string, plan: ZaiKeyPlanWord): void {
  learnedPlans.set(credentialFingerprint(key), plan)
}

function learnedZaiKeyPlan(key: string): ZaiKeyPlanWord | undefined {
  return learnedPlans.get(credentialFingerprint(key))
}

export function forgetZaiKeyPlans(): void {
  learnedPlans.clear()
}

export function planlessZaiKeyPlan(
  key: string,
  env: Record<string, string | undefined> = process.env,
): { plan: ZaiKeyPlanWord; planSource: 'env' | 'learned' | 'assumed' } {
  const explicit = explicitZaiKeyPlan(env)
  if (explicit) return { plan: explicit, planSource: 'env' }
  const learned = learnedZaiKeyPlan(key)
  if (learned) return { plan: learned, planSource: 'learned' }
  return { plan: 'general', planSource: 'assumed' }
}

export function otherZaiKeyPlan(plan: ZaiKeyPlanWord): ZaiKeyPlanWord {
  return plan === 'coding' ? 'general' : 'coding'
}
