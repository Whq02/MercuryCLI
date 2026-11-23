import type { Message, SystemInformationalMessage } from '../../engine/message-shapes/message.js'
import type { Tool } from '../../tools/kit/tool.js'
import { createCombinedAbortSignal } from '../../platform/async/combinedAbortSignal.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { createSystemMessage } from '../../engine/message-shapes/systemMessages.js'
import { afterMicrotask } from '../../platform/async/timers.js'

export type ToolCallUnderGuard = {
  tool: string
  input: Record<string, unknown>
  callId: string
  messages: Message[]
  toolRef?: Tool
  asksAnswerable?: boolean
  offeredTools?: readonly string[]
}

type ToolGuardVerdict =
  | { allow: true; note?: SystemInformationalMessage }
  | { allow: false; reason: string }

type ToolGuard = {
  id: string
  tools?: readonly string[]
  timeoutMs?: number
  judge: (call: ToolCallUnderGuard, signal: AbortSignal) => Promise<ToolGuardVerdict> | ToolGuardVerdict
}

type TurnUnderGuard = {
  messages: Message[]
}

export type TurnNote = { level: 'suggestion' | 'warning'; text: string }

type TurnGuardVerdict = { hold: false; note?: TurnNote } | { hold: true; words: string; note?: TurnNote }

type TurnGuard = {
  id: string
  timeoutMs?: number
  silent?: boolean
  judge: (turn: TurnUnderGuard, signal: AbortSignal) => Promise<TurnGuardVerdict> | TurnGuardVerdict
}

type ToolCallJudgement =
  | { refused: false; notes: SystemInformationalMessage[] }
  | { refused: true; guard: string; reason: string; notes: SystemInformationalMessage[] }

type TurnHold = { guard: string; words: string; silent: boolean }

const DEFAULT_GUARD_TIMEOUT_MS = 5_000

const toolGuards = new Map<string, ToolGuard[]>()
const turnGuards = new Map<string, TurnGuard[]>()
const turnNotes = new Map<string, TurnNote[]>()
const unjudgedSaid = new Set<string>()

function engage<G extends { id: string }>(store: Map<string, G[]>, key: string, guard: G): void {
  const list = (store.get(key) ?? []).filter(entry => entry.id !== guard.id)
  list.push(guard)
  store.set(key, list)
}

function disengage<G extends { id: string }>(store: Map<string, G[]>, key: string, id: string): boolean {
  const list = store.get(key)
  if (!list) return false
  const kept = list.filter(entry => entry.id !== id)
  if (kept.length === list.length) return false
  if (kept.length === 0) store.delete(key)
  else store.set(key, kept)
  return true
}

export function engageToolGuard(key: string, guard: ToolGuard): void {
  engage(toolGuards, key, guard)
}

export function disengageToolGuard(key: string, id: string): boolean {
  return disengage(toolGuards, key, id)
}

export function engageTurnGuard(key: string, guard: TurnGuard): void {
  engage(turnGuards, key, guard)
}

export function disengageTurnGuard(key: string, id: string): boolean {
  return disengage(turnGuards, key, id)
}

export function hasTurnGuard(key: string, id: string): boolean {
  return (turnGuards.get(key) ?? []).some(guard => guard.id === id)
}

export function guardsEngaged(key: string): { tool: string[]; turn: string[] } {
  return { tool: (toolGuards.get(key) ?? []).map(guard => guard.id), turn: (turnGuards.get(key) ?? []).map(guard => guard.id) }
}

export function clearGuards(key: string): void {
  toolGuards.delete(key)
  turnGuards.delete(key)
  turnNotes.delete(key)
}

export function takeTurnNotes(key: string): TurnNote[] {
  const notes = turnNotes.get(key) ?? []
  turnNotes.delete(key)
  return notes
}

export function resetGuardsForTesting(): void {
  toolGuards.clear()
  turnGuards.clear()
  turnNotes.clear()
  unjudgedSaid.clear()
}

async function judged<T>(timeoutMs: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
  const combined = createCombinedAbortSignal(signal, { timeoutMs })
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('the guard was cut'))
      if (combined.signal.aborted) {
        onAbort()
        return
      }
      combined.signal.addEventListener('abort', onAbort, { once: true })
      afterMicrotask(() => run(combined.signal))
        .then(resolve, reject)
        .finally(() => combined.signal.removeEventListener('abort', onAbort))
    })
  } finally {
    combined.cleanup()
  }
}

function guardWatches(guard: ToolGuard, tool: string): boolean {
  return guard.tools === undefined || guard.tools.includes(tool)
}

export function guardKeysOf(sessionId: string, contextId: string | undefined): string | readonly string[] {
  return contextId === undefined ? sessionId : [sessionId, contextId]
}

export async function judgeToolCall(keys: string | readonly string[], call: ToolCallUnderGuard, signal?: AbortSignal): Promise<ToolCallJudgement> {
  const notes: SystemInformationalMessage[] = []
  for (const key of new Set(typeof keys === 'string' ? [keys] : keys)) {
    for (const guard of toolGuards.get(key) ?? []) {
      if (!guardWatches(guard, call.tool)) continue
      try {
        const verdict = await judged(guard.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS, signal, inner => guard.judge(call, inner))
        if (!verdict.allow) return { refused: true, guard: guard.id, reason: verdict.reason, notes }
        if (verdict.note) notes.push(verdict.note)
      } catch (error) {
        const message = errorMessage(error)
        logForDebugging(`guard ${guard.id} did not judge ${call.tool} (${message}); the call proceeds`, { level: 'error' })
        const said = `${key}\n${guard.id}`
        if (signal?.aborted !== true && !unjudgedSaid.has(said)) {
          unjudgedSaid.add(said)
          notes.push(createSystemMessage(`One check of this ${call.tool} call could not be completed (${message}), so this call and any later one it cannot finish run without it.`, 'warning', call.callId))
        }
      }
    }
  }
  return { refused: false, notes }
}

export async function judgeTurnEnd(key: string, turn: TurnUnderGuard, signal?: AbortSignal): Promise<TurnHold[]> {
  const holds: TurnHold[] = []
  for (const guard of turnGuards.get(key) ?? []) {
    if (signal?.aborted) break
    try {
      const verdict = await judged(guard.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS, signal, inner => guard.judge(turn, inner))
      if (verdict.note !== undefined) turnNotes.set(key, [...(turnNotes.get(key) ?? []), verdict.note])
      if (verdict.hold) holds.push({ guard: guard.id, words: verdict.words, silent: guard.silent === true })
    } catch (error) {
      logForDebugging(`guard ${guard.id} threw at the turn's end and holds nothing: ${errorMessage(error)}`, { level: 'error' })
    }
  }
  return holds
}
