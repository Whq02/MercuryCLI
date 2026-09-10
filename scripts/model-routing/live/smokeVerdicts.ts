export type Block = { type?: string; text?: unknown; id?: string; name?: string }

export const API_ERROR = /^API Error|\b(rate limit|too many requests|quota|budget|exhausted|insufficient|expired|unauthori[sz]ed|invalid api key|error code)\b|\b(?:error|status|http)\b[^\d\n]{0,20}\b(4\d\d|5\d\d)\b/i

export function textOf(blocks: Block[]): string {
  return blocks.filter(b => b.type === 'text').map(b => String(b.text)).join(' ')
}

export function errorLines(blocks: Block[]): string[] {
  return blocks.filter(b => b.type === 'text' && API_ERROR.test(String(b.text))).map(b => String(b.text))
}

export type AgenticVerdict =
  | { ok: true; turns: number; reasoningReplayed: number }
  | { ok: false; reason: string }

export function agenticVerdict(input: {
  finalText: string | null
  turnsUsed: number
  maxTurns: number
  reasoningRecordedBeforeLastRequest: number
  reasoningReplayedInLastRequest: number
  expected: string
}): AgenticVerdict {
  if (input.finalText === null) return { ok: false, reason: `no final answer: every one of ${input.maxTurns} turns requested tools` }
  if (errorLines([{ type: 'text', text: input.finalText }]).length > 0) return { ok: false, reason: `the final text is an API error, not an answer: ${input.finalText.slice(0, 120)}` }
  if (!carriesNumber(input.finalText, input.expected)) return { ok: false, reason: `wrong final answer (expected ${input.expected})` }
  if (input.reasoningRecordedBeforeLastRequest === 0) return { ok: false, reason: 'no reasoning items were recorded before the final request, so replay is unproven' }
  if (input.reasoningReplayedInLastRequest === 0) return { ok: false, reason: 'the final request replayed no earlier reasoning item' }
  return { ok: true, turns: input.turnsUsed, reasoningReplayed: input.reasoningReplayedInLastRequest }
}

export type SimpleVerdict = { ok: true } | { ok: false; reason: string }

export function carriesNumber(text: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tail = expected.includes('.') ? '(?:\\d*)' : '(?!\\.?\\d)'
  return new RegExp(`(?<![\\d.])${escaped}${tail}(?![\\d])`).test(text)
}

export function imageVerdict(text: string): SimpleVerdict {
  if (text.trim() === '') return { ok: false, reason: 'empty answer' }
  if (errorLines([{ type: 'text', text }]).length > 0) return { ok: false, reason: `API error text, not an answer: ${text.slice(0, 120)}` }
  if (/\b(not|isn't|is not|no)\s+(\w+\s+)?red\b/i.test(text)) return { ok: false, reason: `the answer denies red: ${text.slice(0, 120)}` }
  if (!/\bred\b/i.test(text)) return { ok: false, reason: `the answer never names red: ${text.slice(0, 120)}` }
  return { ok: true }
}

export function turnAnswerVerdict(text: string, expected: string): SimpleVerdict {
  if (text.trim() === '') return { ok: false, reason: 'empty answer' }
  if (errorLines([{ type: 'text', text }]).length > 0) return { ok: false, reason: `API error text, not an answer: ${text.slice(0, 120)}` }
  if (!carriesNumber(text, expected)) return { ok: false, reason: `the answer does not carry ${expected} as a number: ${text.slice(0, 120)}` }
  return { ok: true }
}

export function latchVerdict(before: { at: number } | null, after: { at: number; model: string } | null, model: string): SimpleVerdict {
  if (after === null) return { ok: false, reason: 'the readiness latch never flipped' }
  if (after.model !== model) return { ok: false, reason: `the latch names ${after.model}, not ${model}` }
  if (before !== null && after.at <= before.at) return { ok: false, reason: 'the latch predates this run: it was set by an earlier request' }
  return { ok: true }
}
