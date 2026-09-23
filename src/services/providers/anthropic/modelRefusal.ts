import { describeAnthropicClientContract } from '../../../constants/oauth.js'
import { classifyAnthropicRefusal } from '../anthropicRefusal.js'
import { classifyCredentialWall } from '../credentialWall.js'

export type ModelRefusalKind = 'contract-floor' | 'tier' | 'not-served'

export interface ModelRefusal {
  id: string
  door: string
  kind: ModelRefusalKind
  words: string
  seenAtMs: number
}

export interface ModelRefusalFacts {
  status?: number | undefined
  errorType?: string | undefined
  wireText: string
  model: string
  door: string
  subscriber: boolean
  presented: string
  seenAtMs: number
}

export interface ClassifiedModelRefusal extends ModelRefusal {
  status: number
  floor?: string
  read?: string
  presented?: string
}

export function modelRefusalId(id: string): string {
  const { normalizeModelStringForAPI } =
    require('../../../utils/model/model.js') as typeof import('../../../utils/model/model.js')
  return normalizeModelStringForAPI(id).trim().toLowerCase()
}

export function clientContractGateText(text: string): boolean {
  return (
    (text.includes('does not support this model') && text.includes('or newer is required')) ||
    text.includes('claude_code_version_too_old')
  )
}

export function modelRefusalErrorType(error: unknown): string | undefined {
  const body = (error as { error?: { type?: unknown; error?: { type?: unknown } } } | null)?.error
  const type = body?.error?.type ?? body?.type
  return typeof type === 'string' ? type : undefined
}

export function activeModelRefusalDoor(): string | undefined {
  try {
    const { anthropicCredentialPresence } =
      require('../providerUsage.js') as typeof import('../providerUsage.js')
    return anthropicCredentialPresence().credentialLabel
  } catch {
    return undefined
  }
}

export function modelRefusalFix(refusal: Pick<ClassifiedModelRefusal, 'kind' | 'floor'>): string {
  if (refusal.kind === 'contract-floor') {
    return `set MERCURY_ANTHROPIC_CLIENT_CONTRACT=${refusal.floor ?? '<version>'} and restart Mercury, or pick another model with /model`
  }
  if (refusal.kind === 'tier') return 'pick another model with /model, or run /logout then /logins after a plan change'
  return 'pick a listed model with /model'
}

export function modelRefusalSentence(refusal: ClassifiedModelRefusal): string {
  const { renderModelName } =
    require('../../../utils/model/model.js') as typeof import('../../../utils/model/model.js')
  const name = renderModelName(refusal.id)
  if (refusal.kind === 'contract-floor') {
    return `${name} is refused on ${refusal.door}: it needs ${refusal.floor ? `client version ${refusal.floor}` : 'a newer client version'} and Mercury presents ${refusal.presented} — ${modelRefusalFix(refusal)}.`
  }
  if (refusal.kind === 'tier') {
    return `${name} is not available on the tier for ${refusal.door} — ${modelRefusalFix(refusal)}.`
  }
  return `${name} is not served on ${refusal.door} (the endpoint answered ${refusal.status}) — ${modelRefusalFix(refusal)}.`
}

function withWords(refusal: ClassifiedModelRefusal): ClassifiedModelRefusal {
  return { ...refusal, words: modelRefusalSentence(refusal) }
}

export function modelRefusalFromError(error: unknown, model: string): ClassifiedModelRefusal | null {
  const record = error as { status?: number; message?: string } | null
  const { isClaudeAISubscriber } = require('../../../utils/auth.js') as typeof import('../../../utils/auth.js')
  return classifyModelRefusal({
    status: record?.status,
    errorType: modelRefusalErrorType(error),
    wireText: record?.message ?? '',
    model,
    door: activeModelRefusalDoor() ?? 'an unknown door',
    subscriber: isClaudeAISubscriber(),
    presented: describeAnthropicClientContract().presented,
    seenAtMs: Date.now(),
  })
}

export function classifyModelRefusal(facts: ModelRefusalFacts): ClassifiedModelRefusal | null {
  const { status, wireText, errorType } = facts
  if (status !== 400 && status !== 403 && status !== 404) return null
  if (classifyAnthropicRefusal({ status, wireText }) !== 'other') return null
  if (classifyCredentialWall(status, wireText) !== undefined) return null
  if (status === 403 && (errorType === 'authentication_error' || /\b(?:token|credential|authentication|api[- ]?key|x-api-key)\b/i.test(wireText))) return null
  const id = modelRefusalId(facts.model)
  const base = { id, door: facts.door, words: '', seenAtMs: facts.seenAtMs, status }
  if (id === '' || facts.door.trim() === '') return null
  if (status === 400 && clientContractGateText(wireText)) {
    const floor = /version (\d+(?:\.\d+)+) or newer is required/.exec(wireText)?.[1]
    const read = /(\d+(?:\.\d+)+) does not support this model/.exec(wireText)?.[1]
    return withWords({
      ...base,
      kind: 'contract-floor',
      presented: facts.presented,
      ...(floor !== undefined ? { floor } : {}),
      ...(read !== undefined ? { read } : {}),
    })
  }
  if (status === 400 && facts.subscriber && wireText.toLowerCase().includes('invalid model name') && /^(?:claude-opus(?:-|$)|opus$)/.test(id)) {
    return withWords({ ...base, kind: 'tier' })
  }
  const named = (wireText.toLowerCase().match(/[a-z0-9_/-]+(?:\.[a-z0-9_/-]+)*/g) ?? []).includes(id)
  if (named && (status === 403 || (status === 404 && errorType === 'not_found_error'))) {
    return withWords({ ...base, kind: 'not-served' })
  }
  return null
}

export function standingModelRefusals(): readonly ModelRefusal[] {
  return []
}

export function modelRefusalWords(id: string): string | undefined {
  void id
  return undefined
}
