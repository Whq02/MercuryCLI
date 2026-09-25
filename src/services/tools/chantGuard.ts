export const CHANT_CHUNK_CHARS = 50
export const CHANT_REPEATS = 10
export const CHANT_HISTORY_CHARS = 1500
export const CHANT_MAX_GAP_FACTOR = 1.5
export const CHANT_RECOVERY_LIMIT = 1
export const CHANT_PREVIEW_CHARS = 80

export interface ChantDetection {
  chunk: string
  repeats: number
  span: number
  at: number
}

const FENCE = /^\s*(```|~~~)/
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)|^\s*([-*_]\s*){3,}\s*$/

export function proseOf(text: string): string {
  const kept: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || STRUCTURAL.test(line)) continue
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
        return { chunk, repeats: positions.length, span: span + CHANT_CHUNK_CHARS, at }
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

export function decideChantRecovery(input: { recoveryCount: number }): { kind: 'continue'; attempt: number } | { kind: 'exhausted' } {
  return input.recoveryCount < CHANT_RECOVERY_LIMIT ? { kind: 'continue', attempt: input.recoveryCount + 1 } : { kind: 'exhausted' }
}

function preview(detection: ChantDetection): string {
  const flat = detection.chunk.replace(/\s+/g, ' ').trim()
  return flat.length > CHANT_PREVIEW_CHARS ? `${flat.slice(0, CHANT_PREVIEW_CHARS)}...` : flat
}

export function chantNudgeText(detection: ChantDetection): string {
  return `Loop notice: your last reply repeated the same stretch of text ${detection.repeats} times within ${detection.span} characters ("${preview(detection)}"). The reply so far stands; do not write that stretch again. Continue from the first new step after it, or end the turn and report what you found.`
}

export function chantNoticeLine(detection: ChantDetection, tail: string): string {
  return `Loop guard: the reply repeated the same ${CHANT_CHUNK_CHARS}-character stretch ${detection.repeats} times within ${detection.span} characters — ${tail}`
}

export function chantStopText(detection: ChantDetection): string {
  return `The loop guard ended the turn: the reply repeated the same stretch of text ${detection.repeats} times ("${preview(detection)}") after the loop notice had already asked for something new. When the turn resumes, report what was found and continue with a different step.`
}
