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
    return {
      ...base,
      kind: 'contract-floor',
      presented: facts.presented,
      ...(floor !== undefined ? { floor } : {}),
      ...(read !== undefined ? { read } : {}),
    }
  }
  if (status === 400 && facts.subscriber && wireText.toLowerCase().includes('invalid model name') && /^(?:claude-opus(?:-|$)|opus$)/.test(id)) {
    return { ...base, kind: 'tier' }
  }
  const named = (wireText.toLowerCase().match(/[a-z0-9_/-]+(?:\.[a-z0-9_/-]+)*/g) ?? []).includes(id)
  if (named && (status === 403 || (status === 404 && errorType === 'not_found_error'))) {
    return { ...base, kind: 'not-served' }
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
