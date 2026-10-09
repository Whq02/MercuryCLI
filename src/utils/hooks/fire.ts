import { randomUUID } from 'node:crypto'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { hookEndingSentence, type HookEnding } from '../../rows/vocabulary.js'
import { hookEntryName, hookKindOf, type HookEntry } from '../../schemas/hooks.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { getTranscriptPathForSession } from '../sessionStorage/paths.js'
import { jsonStringify } from '../slowOperations.js'
import { foldAnswers, readAnswerObject, readStdoutAnswer, type FoldedAnswer, type HookOutcome, type ReadAnswer } from './answer.js'
import { startBackgroundHook } from './background.js'
import { startCommandHook, type CommandHookSource } from './commandRunner.js'
import { hookAnswerSchema, hookEventTable, hookKindsOf, HOOK_TIMEOUT_DEFAULT_S, type HookAnswer, type HookEvent, type HookPayload } from './contract.js'
import { runCrewmateHook } from './crewmateRunner.js'
import { emitHookResponse, emitHookStarted, getHookRunContext, hookProgressReporter } from './hookEvents.js'
import { markHookSpent, matchHooks, type MatchedHook } from './matching.js'
import type { HookScope } from './sessionHooks.js'
import { runQuestionHook, type ModelHookEnd } from './questionRunner.js'

export type HookFireOptions = {
  scope: HookScope
  signal?: AbortSignal
  budgetMs?: number
  toolUseContext?: ToolUseContext
  appState?: AppState
  permissionMode?: string
  crewmateType?: string
}

export type HookFireResult = {
  event: HookEvent
  answer: FoldedAnswer
  outcomes: HookOutcome[]
}

export type HookFields<E extends HookEvent> = Omit<HookPayload<E>, 'event' | 'session_id' | 'transcript_path' | 'cwd' | 'permission_mode' | 'crewmate_id' | 'crewmate_type'>

export function nothingFired(event: HookEvent): HookFireResult {
  return { event, answer: foldAnswers(event, []), outcomes: [] }
}

export function buildHookPayload<E extends HookEvent>(event: E, fields: HookFields<E>, options: HookFireOptions): HookPayload<E> {
  const context = getHookRunContext()
  const sessionId = context?.sessionId ?? options.scope.sessionId
  const crewmateId = options.scope.crewmateId ?? options.toolUseContext?.agentId
  const crewmateType = options.crewmateType ?? (crewmateId !== undefined ? options.toolUseContext?.agentType : undefined)
  const permissionMode = options.permissionMode ?? (options.toolUseContext ? options.toolUseContext.getAppState().toolPermissionContext.mode : undefined)
  return {
    session_id: sessionId,
    transcript_path: context?.transcriptPath ?? getTranscriptPathForSession(sessionId),
    cwd: options.scope.cwd ?? context?.cwd ?? getCwd(),
    ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
    ...(crewmateId !== undefined ? { crewmate_id: crewmateId } : {}),
    ...(crewmateType !== undefined ? { crewmate_type: crewmateType } : {}),
    event,
    ...fields,
  } as HookPayload<E>
}

function sourceOfMatch(match: MatchedHook): CommandHookSource {
  switch (match.source.kind) {
    case 'extension':
      return { kind: 'extension', id: match.source.id, root: match.source.root }
    case 'skill':
      return { kind: 'skill', root: match.source.root }
    case 'agent':
      return { kind: 'agent' }
    default:
      return { kind: 'settings' }
  }
}

function clockOf(entry: HookEntry, budgetMs: number | undefined): number {
  const own = entry.timeout !== undefined ? entry.timeout * 1000 : HOOK_TIMEOUT_DEFAULT_S[hookKindOf(entry)] * 1000
  return budgetMs !== undefined ? Math.min(own, budgetMs) : own
}

function failedLine(ending: Extract<HookEnding, { status: 'failed' }>, name: string, event: HookEvent): string {
  return hookEndingSentence(ending, { name, event })
}

function readToState(event: HookEvent, name: string, read: ReadAnswer): HookOutcome['state'] {
  if (read.kind === 'answer') return { kind: 'answered', answer: read.answer }
  if (read.kind === 'text') return { kind: 'text', text: read.text }
  return { kind: 'failed', line: failedLine({ status: 'failed', class: 'answer', exit_code: 0, detail: read.fault }, name, event) }
}

function modelEndToState(event: HookEvent, name: string, end: ModelHookEnd, timeoutMs: number): HookOutcome['state'] {
  switch (end.kind) {
    case 'answered':
      return readToState(event, name, readAnswerObject(event, end.answer))
    case 'timed_out':
      return { kind: 'failed', line: failedLine({ status: 'failed', class: 'timed_out', exit_code: 1, detail: `${Math.round(timeoutMs / 1000)}s` }, name, event) }
    case 'cancelled':
      return { kind: 'failed', line: failedLine({ status: 'failed', class: 'cancelled', exit_code: 1 }, name, event) }
    default:
      return { kind: 'failed', line: failedLine({ status: 'failed', class: 'spawn', exit_code: 1, detail: end.detail }, name, event) }
  }
}

function outputOf(state: HookOutcome['state']): string {
  switch (state.kind) {
    case 'answered':
      return jsonStringify(state.answer)
    case 'text':
      return state.text
    case 'failed':
      return state.line
    default:
      return ''
  }
}

async function runOne(event: HookEvent, match: MatchedHook, payloadJson: string, index: number, options: HookFireOptions): Promise<HookOutcome> {
  const { entry } = match
  const name = hookEntryName(entry)
  const hookId = randomUUID()
  const kind = hookKindOf(entry)
  const timeoutMs = clockOf(entry, options.budgetMs)
  const startedAt = Date.now()
  emitHookStarted(hookId, name, event)
  const outcome = (state: HookOutcome['state'], durationMs = Date.now() - startedAt): HookOutcome => {
    const row: HookOutcome = { id: match.id, name, event, source: match.source, durationMs, state }
    const words = outputOf(state)
    emitHookResponse({ hookId, hookName: name, hookEvent: event, output: words, stdout: state.kind === 'text' ? state.text : '', stderr: state.kind === 'failed' ? state.line : '', outcome: state.kind === 'failed' ? 'error' : 'success' })
    return row
  }
  if (!hookKindsOf(event).includes(kind)) {
    return outcome({ kind: 'failed', line: failedLine({ status: 'failed', class: 'spawn', exit_code: 1, detail: `${event} runs ${hookKindsOf(event).join(' and ')} hooks only` }, name, event) })
  }
  if (kind === 'run') {
    const progress = hookProgressReporter({ hookId, hookName: name, hookEvent: event })
    const process = await startCommandHook({
      command: entry.run ?? '',
      shell: entry.shell ?? 'bash',
      name,
      event,
      index,
      payloadJson,
      timeoutMs,
      signal: entry.background || entry.wake ? undefined : options.signal,
      source: sourceOfMatch(match),
      onOutput: snapshot => progress({ ...snapshot, output: snapshot.stdout + snapshot.stderr }),
    })
    if (entry.background === true || entry.wake === true) {
      startBackgroundHook({ id: hookId, name, event, process, wake: entry.wake === true, scope: options.scope })
      if (entry.once) markHookSpent(match.id, options.scope)
      return { id: match.id, name, event, source: match.source, durationMs: 0, state: { kind: 'background' } }
    }
    const end = await process.result
    if (entry.once) markHookSpent(match.id, options.scope)
    if (end.kind === 'ended') return outcome({ kind: 'failed', line: failedLine(end.ending, name, event) }, end.durationMs)
    if (end.code === 0) return outcome(readToState(event, name, readStdoutAnswer(event, end.stdout)), end.durationMs)
    if (end.code === 2) {
      const words = end.stderr.trim() || `${name} blocked ${event} without a word`
      return outcome(readToState(event, name, readAnswerObject(event, { block: words })), end.durationMs)
    }
    return outcome({ kind: 'failed', line: failedLine({ status: 'failed', class: 'exit', exit_code: end.code, detail: end.stderr.trim() }, name, event) }, end.durationMs)
  }
  if (options.toolUseContext === undefined) {
    return outcome({ kind: 'failed', line: failedLine({ status: 'failed', class: 'spawn', exit_code: 1, detail: `a ${kind} hook needs a model seat, and ${event} fired without one here` }, name, event) })
  }
  const run = { text: entry.question ?? entry.crewmate ?? '', name, event, payloadJson, answerSchema: hookAnswerSchema(event), model: entry.model, timeoutMs, signal: options.signal, toolUseContext: options.toolUseContext }
  const end = kind === 'question' ? await runQuestionHook(run) : await runCrewmateHook(run)
  if (entry.once) markHookSpent(match.id, options.scope)
  return outcome(modelEndToState(event, name, end, timeoutMs), end.durationMs)
}

export type PreparedHooks = { names: string[]; run: () => Promise<HookFireResult> }

export async function prepareHooks<E extends HookEvent>(event: E, fields: HookFields<E>, options: HookFireOptions): Promise<PreparedHooks> {
  if (isEnvTruthy(process.env.MERCURY_BARE)) return { names: [], run: async () => nothingFired(event) }
  const payload = buildHookPayload(event, fields, options)
  const matched = await matchHooks(event, payload, options.scope, { appState: options.appState ?? options.toolUseContext?.getAppState() })
  if (matched.length === 0) return { names: [], run: async () => nothingFired(event) }
  const payloadJson = jsonStringify(payload)
  return {
    names: matched.map(match => hookEntryName(match.entry)),
    run: async () => {
      if (options.signal?.aborted) return nothingFired(event)
      const outcomes = await Promise.all(matched.map((match, index) => runOne(event, match, payloadJson, index, options).catch(error => {
        const name = hookEntryName(match.entry)
        const line = failedLine({ status: 'failed', class: 'spawn', exit_code: 1, detail: error instanceof Error ? error.message : String(error) }, name, event)
        logForDebugging(line, { level: 'error' })
        return { id: match.id, name, event, source: match.source, durationMs: 0, state: { kind: 'failed', line } } satisfies HookOutcome
      })))
      return { event, answer: foldAnswers(event, outcomes), outcomes }
    },
  }
}

export async function fireHooks<E extends HookEvent>(event: E, fields: HookFields<E>, options: HookFireOptions): Promise<HookFireResult> {
  const prepared = await prepareHooks(event, fields, options)
  return prepared.run()
}

export function answeredNothing(result: HookFireResult): boolean {
  return result.outcomes.every(outcome => outcome.state.kind === 'background' || (outcome.state.kind === 'answered' && Object.keys(outcome.state.answer).length === 0))
}

export type { FoldedAnswer, HookOutcome, HookAnswer }
export { hookEventTable }
