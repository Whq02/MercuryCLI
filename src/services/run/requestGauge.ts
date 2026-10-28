import { createHash } from 'node:crypto'
import type { AssistantMessage, Message } from '../../types/message.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { messageContextFill } from '../../utils/tokens.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages/systemMessages.js'

export type RequestGaugeFixed = { digest: string; tokens: number }
type RequestGaugeDensity = { ratio: number; samples: number; residuals: number[] }
export type RequestGaugeAnchor = {
  version: 1
  key: string
  epoch: number
  digest: string
  sourceDigest?: string
  rebase?: boolean
  rawTokens: number
  fixed: RequestGaugeFixed
  density: RequestGaugeDensity
  sample: { eligible: boolean; denominator: number; measured: number; reason: string }
}
export type RequestGaugeView = {
  key: string
  epoch: number
  digest: string
  sourceDigest?: string
  rebase?: boolean
  rawTokens: number
  fixed: RequestGaugeFixed
  density: RequestGaugeDensity
  tokens: number
  source: 'usage' | 'estimate'
  transition: 'cold' | 'continued' | 'rebased'
  tailTokens: number
  tailCalibratable: boolean
  anchorTokens: number
}

const bindings = new WeakMap<readonly Message[], { key: string; epoch: number; fixed: RequestGaugeFixed; rebase: boolean }>()
const freshDensity = (): RequestGaugeDensity => ({ ratio: 1, samples: 0, residuals: [] })

function hasMedia(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasMedia)
  const record = value as Record<string, unknown>
  return record.type === 'image' || record.type === 'document' || Object.values(record).some(hasMedia)
}

export function estimateRequestGauge(messages: readonly Message[], fixed: RequestGaugeFixed, density: RequestGaugeDensity, model?: string): number {
  const raw = roughTokenCountEstimationForMessages(messages, model)
  return Math.ceil(fixed.tokens + raw * (hasMedia(messages) ? 1 : density.ratio))
}

export function requestGaugeFixed(material: unknown): RequestGaugeFixed {
  const text = JSON.stringify(material) ?? ''
  return { digest: createHash('sha256').update(text).digest('hex'), tokens: Math.ceil(text.length / 4) }
}

export function requestGaugeDigest(messages: readonly Message[]): string {
  const hash = createHash('sha256')
  for (const message of messages) {
    if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'attachment') continue
    hash.update(message.type).update('\0')
    hash.update(JSON.stringify(message.type === 'attachment' ? message.attachment : message.message.content)).update('\u0001')
  }
  return hash.digest('hex')
}

function lastAnchor(messages: readonly Message[], key?: string): { row: AssistantMessage; index: number; anchor: RequestGaugeAnchor } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (row?.type !== 'assistant' || !row.message.stop_reason || !row.contextGauge) continue
    const anchor = row.contextGauge
    if (anchor.version !== 1 || (key !== undefined && anchor.key !== key)) return null
    if (!Number.isFinite(anchor.density.ratio) || anchor.density.ratio <= 0) return null
    return { row, index, anchor }
  }
  return null
}

function foldSeed(messages: readonly Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]
    if (row?.type === 'system' && row.subtype === 'compact_boundary') return row.compactMetadata.requestGauge
  }
  return undefined
}

export function bindRequestGauge(messages: readonly Message[], key: string, epoch: number, fixed: RequestGaugeFixed, rebase = false): RequestGaugeView {
  bindings.set(messages, { key, epoch, fixed, rebase })
  return requestGaugeView(messages, key, epoch, fixed, rebase)
}

function requestGaugeView(messages: readonly Message[], key: string, epoch: number, fixed: RequestGaugeFixed, rebase = false): RequestGaugeView {
  messages = getMessagesAfterCompactBoundary(messages as Message[])
  const previous = lastAnchor(messages, key)
  const seed = foldSeed(messages)
  const density = previous?.anchor.density ?? (seed?.key === key ? seed.density : freshDensity())
  const model = key.slice(key.indexOf(':') + 1, key.lastIndexOf(':c'))
  const rawTokens = roughTokenCountEstimationForMessages(messages, model)
  const digest = requestGaugeDigest(messages)
  const base: RequestGaugeView = {
    key, epoch, fixed, rawTokens, digest, density, rebase,
    tokens: Math.ceil(fixed.tokens + rawTokens * (hasMedia(messages) ? 1 : density.ratio)), source: 'estimate',
    transition: previous ? 'rebased' : 'cold', tailTokens: 0, tailCalibratable: false, anchorTokens: 0,
  }
  if (rebase) return { ...base, transition: 'rebased' }
  if (!previous) {
    const unstamped = messageContextFill(messages, model)
    return unstamped.source === 'usage' ? { ...base, tokens: unstamped.tokens, source: 'usage' } : base
  }
  let first = previous.index
  for (let i = first - 1; i >= 0; i--) {
    const row = messages[i]
    if (row?.type !== 'assistant') continue
    if (row.message.id !== previous.row.message.id) break
    first = i
  }
  const prefix = messages.slice(0, first)
  const prefixDigest = requestGaugeDigest(prefix)
  if (previous.anchor.epoch !== epoch || (prefixDigest !== previous.anchor.digest && prefixDigest !== previous.anchor.sourceDigest)) return base
  const tail = messages.slice(first).filter(row => row.type !== 'assistant' || row.message.id !== previous.row.message.id)
  const tailTokens = roughTokenCountEstimationForMessages(tail, model)
  const usage = previous.row.message.usage
  const anchorTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
  const fixedMatched = previous.anchor.fixed.digest === fixed.digest
  const tailCalibratable = fixedMatched && tailTokens >= 1000 && !hasMedia(tail)
  const fixedDelta = fixed.tokens - previous.anchor.fixed.tokens
  return { ...base, tokens: Math.max(0, anchorTokens + fixedDelta + Math.round(tailTokens * (tailCalibratable ? density.ratio : 1))), source: 'usage', transition: 'continued', tailTokens, tailCalibratable, anchorTokens }
}

export function readRequestGauge(messages: readonly Message[], model?: string): RequestGaugeView | null {
  const bound = bindings.get(messages)
  messages = getMessagesAfterCompactBoundary(messages as Message[])
  const previous = lastAnchor(messages)
  const seed = foldSeed(messages)
  const key = bound?.key ?? previous?.anchor.key ?? seed?.key
  if (!key || (model !== undefined && key.slice(key.indexOf(':') + 1, key.lastIndexOf(':c')) !== model)) return null
  const epoch = bound?.epoch ?? previous?.anchor.epoch ?? seed?.epoch
  const fixed = bound?.fixed ?? previous?.anchor.fixed ?? seed?.fixed
  if (epoch === undefined || !fixed) return null
  return requestGaugeView(messages, key, epoch, fixed, bound?.rebase)
}

function learnRequestGauge(density: RequestGaugeDensity, denominator: number, measured: number): RequestGaugeDensity {
  if (!(denominator >= 1000) || !(measured > 0) || !Number.isFinite(measured)) return density
  const ratio = density.ratio * 0.8 + (measured / denominator) * 0.2
  const residual = measured - denominator * density.ratio
  return { ratio, samples: density.samples + 1, residuals: [...density.residuals.slice(-31), residual] }
}

export function settleRequestGauge(view: RequestGaugeView, response: AssistantMessage): RequestGaugeAnchor | null {
  if (!response.message.stop_reason || response.isApiErrorMessage) return null
  const usage = response.message.usage
  const measured = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  if (!(measured > 0)) return null
  const residual = measured - view.anchorTokens
  const eligible = view.transition === 'continued' && view.tailCalibratable && residual > 0
  const density = eligible ? learnRequestGauge(view.density, view.tailTokens, residual) : view.density
  const anchor: RequestGaugeAnchor = {
    version: 1, key: view.key, epoch: view.epoch, digest: view.digest, sourceDigest: view.sourceDigest, rawTokens: view.rawTokens, fixed: view.fixed, density,
    sample: { eligible, denominator: view.tailTokens, measured: residual, reason: eligible ? 'matched-request-tail' : view.transition !== 'continued' ? view.transition : 'insufficient-tail-evidence' },
  }
  response.contextGauge = anchor
  return anchor
}
