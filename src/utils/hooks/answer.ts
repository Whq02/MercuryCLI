import type { HookSource } from './hooksConfigSnapshot.js'
import { hookAnswerFieldsOf, hookAnswerSchema, hookEventTable, type HookAnswer, type HookAnswerField, type HookEvent } from './contract.js'

export type ReadAnswer =
  | { kind: 'answer'; answer: HookAnswer }
  | { kind: 'text'; text: string }
  | { kind: 'fault'; fault: string }

export function readAnswerObject(event: HookEvent, value: unknown): ReadAnswer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'fault', fault: 'the answer is not a JSON object' }
  }
  const fields = hookAnswerFieldsOf(event)
  const strangers = Object.keys(value).filter(key => !(fields as readonly string[]).includes(key))
  if (strangers.length > 0) {
    const readable = fields.length === 0 ? 'nothing' : fields.map(field => `\`${field}\``).join(', ')
    return { kind: 'fault', fault: `\`${strangers[0]}\` is not an answer ${event} reads (it reads ${readable})` }
  }
  const parsed = hookAnswerSchema(event).safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { kind: 'fault', fault: `\`${issue?.path.join('.') || 'the answer'}\`: ${issue?.message ?? 'does not fit the answer shape'}` }
  }
  return { kind: 'answer', answer: parsed.data as HookAnswer }
}

export function readStdoutAnswer(event: HookEvent, stdout: string): ReadAnswer {
  const trimmed = stdout.trim()
  if (trimmed === '') return { kind: 'answer', answer: {} }
  if (!trimmed.startsWith('{')) return { kind: 'text', text: trimmed }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { kind: 'fault', fault: 'stdout opens a JSON object that does not parse' }
  }
  return readAnswerObject(event, value)
}

export function plainTextIsContext(event: HookEvent): boolean {
  return hookEventTable[event].stdoutIsContext === true
}

export type HookOutcome = {
  id: string
  name: string
  event: HookEvent
  source: HookSource
  durationMs: number
  state:
    | { kind: 'answered'; answer: HookAnswer }
    | { kind: 'text'; text: string }
    | { kind: 'failed'; line: string }
    | { kind: 'background' }
}

export type FoldedAnswer = {
  block?: string
  stop?: string
  contexts: string[]
  notices: string[]
  conflicts: Array<{ field: string; earlier: string; winner: string; words: string }>
  permission?: 'allow' | 'ask'
  input?: Record<string, unknown>
  output?: unknown
  rules?: NonNullable<HookAnswer['rules']>
  instructions?: string
  prompt?: string
  watch?: string[]
}

const SINGLE_SETTER_FIELDS = ['input', 'output', 'prompt', 'instructions'] as const satisfies readonly HookAnswerField[]

export function foldAnswers(event: HookEvent, outcomes: readonly HookOutcome[]): FoldedAnswer {
  const folded: FoldedAnswer = { contexts: [], notices: [], conflicts: [] }
  const blocks: string[] = []
  const setters: Partial<Record<(typeof SINGLE_SETTER_FIELDS)[number], string>> = {}
  const contextFromText = plainTextIsContext(event)
  for (const outcome of outcomes) {
    if (outcome.state.kind === 'text') {
      if (contextFromText) folded.contexts.push(outcome.state.text)
      continue
    }
    if (outcome.state.kind !== 'answered') continue
    const answer = outcome.state.answer
    if (answer.block !== undefined) blocks.push(answer.block)
    if (answer.stop !== undefined && folded.stop === undefined) folded.stop = answer.stop
    if (answer.context !== undefined) folded.contexts.push(answer.context)
    if (answer.notice !== undefined) folded.notices.push(answer.notice)
    if (answer.permission !== undefined) folded.permission = folded.permission === 'ask' ? 'ask' : answer.permission
    if (answer.rules !== undefined) folded.rules = [...(folded.rules ?? []), ...answer.rules]
    if (answer.watch !== undefined) folded.watch = answer.watch
    for (const field of SINGLE_SETTER_FIELDS) {
      if (answer[field] === undefined) continue
      const earlier = setters[field]
      if (earlier !== undefined) folded.conflicts.push({ field, earlier, winner: outcome.name, words: `\`${field}\` on ${event} was answered by both ${earlier} and ${outcome.name}; ${outcome.name} wins` })
      setters[field] = outcome.name
      ;(folded as Record<string, unknown>)[field] = answer[field]
    }
  }
  if (blocks.length > 0) folded.block = blocks.join('\n')
  return folded
}
