import { randomUUID } from 'node:crypto'
import type { AssistantMessage } from '../../types/message.js'
import type { ApiStreamEvent, ContentBlock } from '../../types/wire.js'
import { createAssistantMessage } from '../../utils/messages/factories.js'

const CHANT_CHUNK_CHARS = 50
const CHANT_REPEATS = 10
const CHANT_HISTORY_CHARS = 1500
const CHANT_MAX_GAP_FACTOR = 1.5
export const CHANT_RECOVERY_LIMIT = 1
const CHANT_PREVIEW_CHARS = 80

export interface ChantDetection {
  chunk: string
  repeats: number
  span: number
  at: number
  channel?: 'text' | 'thinking'
}

const FENCE = /^\s*(```|~~~)/
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)|^\s*([-*_]\s*){3,}\s*$/

function proseOf(text: string): string {
  const kept: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced
      kept.push(' '.repeat(line.length))
      continue
    }
    if (fenced || STRUCTURAL.test(line)) {
      kept.push(' '.repeat(line.length))
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

export function detectChant(text: string): ChantDetection | null {
  const prose = proseOf(text)
  if (prose.length < CHANT_CHUNK_CHARS * CHANT_REPEATS) return null
  const seen = new Map<string, number[]>()
  const maxGap = CHANT_CHUNK_CHARS * CHANT_MAX_GAP_FACTOR
  for (let at = 0; at + CHANT_CHUNK_CHARS <= prose.length; at++) {
    const chunk = prose.slice(at, at + CHANT_CHUNK_CHARS)
    if (chunk.trim().length < CHANT_CHUNK_CHARS / 2) continue
    const positions = seen.get(chunk) ?? []
    while (positions.length > 0 && at - positions[0]! > CHANT_HISTORY_CHARS) positions.shift()
    positions.push(at)
    seen.set(chunk, positions)
    if (positions.length >= CHANT_REPEATS) {
      const span = positions[positions.length - 1]! - positions[0]!
      if (span / (positions.length - 1) <= maxGap) {
        return { chunk, repeats: positions.length, span: span + CHANT_CHUNK_CHARS, at: positions[0]! }
      }
    }
    if (at % 1000 === 999) {
      for (const [key, list] of seen) {
        if (list.length === 0 || at - list[list.length - 1]! > CHANT_HISTORY_CHARS) seen.delete(key)
      }
    }
  }
  return null
}

const STREAM_CHANT_START = 8_000
const STREAM_CHANT_PERIOD = 60
const OMITTED = '[repeated text omitted]'

function detectStreamChant(text: string): ChantDetection | null {
  const start = Math.max(0, text.length - STREAM_CHANT_START)
  const tail = text.slice(start)
  const seen = new Map<string, { at: number; repeats: number; chars: number; end: number }>()
  let offset = start
  const lines = tail.split('\n')
  for (const line of lines) {
    const at = offset
    offset += line.length + 1
    const normalized = line.trim().replace(/\s+/g, ' ')
    if (!normalized || at === start && start > 0 && text[start - 1] !== '\n') continue
    const row = seen.get(normalized) ?? { at, repeats: 0, chars: 0, end: at }
    row.repeats++
    row.chars += line.length + 1
    row.end = at + line.length
    seen.set(normalized, row)
    if (row.repeats >= CHANT_REPEATS && row.chars >= tail.length / 2) {
      let first = row.at
      while (first > 0) {
        const previous = text.lastIndexOf('\n', first - 2) + 1
        if (text.slice(previous, first).trim().replace(/\s+/g, ' ') !== normalized) break
        first = previous
      }
      return { chunk: normalized, at: first, repeats: row.repeats, span: row.end - first }
    }
  }
  for (let period = STREAM_CHANT_PERIOD; period <= tail.length / CHANT_REPEATS; period++) {
    let equal = 0
    for (let at = period; at < tail.length; at++) {
      equal = tail[at] === tail[at - period] ? equal + 1 : 0
      const span = equal + period
      if (span < period * CHANT_REPEATS || span < tail.length / 2) continue
      const chunk = tail.slice(at - period + 1, at + 1)
      if (chunk.trim().length < STREAM_CHANT_PERIOD / 2) continue
      let first = start + at + 1 - span
      while (first > 0 && text[first - 1] === text[first - 1 + period]) first--
      return { chunk, at: first, span: start + at + 1 - first, repeats: Math.floor((start + at + 1 - first) / period) }
    }
  }
  return null
}

export class StreamChantWatch {
  private readonly channels = {
    text: { value: '', next: STREAM_CHANT_START },
    thinking: { value: '', next: STREAM_CHANT_START },
  }

  feed(event: ApiStreamEvent): ChantDetection | null {
    const block = event.type === 'content_block_delta' ? event.delta : event.type === 'content_block_start' ? event.content_block : undefined
    if (!block) return null
    const channel = block.type === 'text_delta' || block.type === 'text' ? 'text' : block.type === 'thinking_delta' || block.type === 'thinking' ? 'thinking' : null
    if (channel === null) return null
    const text = 'text' in block ? block.text : 'thinking' in block ? block.thinking : ''
    if (typeof text !== 'string' || text === '') return null
    const state = this.channels[channel]
    state.value += text
    if (state.value.length < state.next) return null
    while (state.next <= state.value.length) state.next *= 2
    const detection = detectStreamChant(state.value)
    return detection === null ? null : { ...detection, channel }
  }
}

export function trimChantedReplyMessages(replyMessages: readonly AssistantMessage[], detection: ChantDetection): AssistantMessage[] {
  const channel = detection.channel ?? 'text'
  let offset = 0
  let omitted = false
  const result: AssistantMessage[] = []
  for (const original of replyMessages) {
    if (original.isApiErrorMessage === true) continue
    let changed = false
    const content: ContentBlock[] = []
    for (const block of original.message.content) {
      if (block.type !== channel) {
        content.push(block)
        continue
      }
      const value = block.type === 'text' ? block.text : block.thinking
      const remaining = Math.max(0, detection.at - offset)
      offset += value.length
      if (remaining >= value.length) {
        content.push(block)
        continue
      }
      changed = true
      if (block.type === 'text' && remaining > 0) content.push({ ...block, text: value.slice(0, remaining) })
      if (!omitted) {
        content.push({ type: 'text', text: OMITTED, citations: null })
        omitted = true
      }
    }
    if (!changed) {
      result.push(original)
      continue
    }
    const replacement = { ...original, uuid: randomUUID(), message: { ...original.message, content } }
    delete replacement.geminiProviderTurn
    delete replacement.kimiProviderTurn
    delete replacement.apexProviderTurn
    delete replacement.openrouterProviderTurn
    delete replacement.compatProviderTurn
    delete replacement.xaiProviderTurn
    delete replacement.zenProviderTurn
    result.push(replacement)
  }
  if (!omitted) result.push(createAssistantMessage({ content: OMITTED }))
  return result
}
export function decideChantRecovery(input: { recoveryCount: number }): { kind: 'continue'; attempt: number } | { kind: 'exhausted' } {
  return input.recoveryCount < CHANT_RECOVERY_LIMIT ? { kind: 'continue', attempt: input.recoveryCount + 1 } : { kind: 'exhausted' }
}

function preview(detection: ChantDetection): string {
  const flat = detection.chunk.replace(/\s+/g, ' ').trim()
  return flat.length > CHANT_PREVIEW_CHARS ? `${flat.slice(0, CHANT_PREVIEW_CHARS)}...` : flat
}

export function chantNudgeText(detection: ChantDetection): string {
  return `Loop notice: your last reply repeated the same stretch of text ${detection.repeats} times within ${detection.span} characters ("${preview(detection)}"). The repeated text was omitted; do not write that stretch again. Continue from the first new step after it, or end the turn and report what you found.`
}

export function chantNoticeLine(detection: ChantDetection, tail: string): string {
  return `Loop guard: the reply repeated the same ${detection.chunk.length}-character stretch ${detection.repeats} times within ${detection.span} characters — ${tail}`
}

export function chantStopText(detection: ChantDetection): string {
  return `The loop guard ended the turn: the reply repeated the same stretch of text ${detection.repeats} times ("${preview(detection)}") after the loop notice had already asked for something new. When the turn resumes, report what was found and continue with a different step.`
}
