import type { Message, SystemInformationalMessage } from '../types/message.js'
import type { Tool } from '../Tool.js'
import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

export type ToolCallUnderGuard = {
  tool: string
  input: Record<string, unknown>
  callId: string
  messages: Message[]
  toolRef?: Tool
}

export type ToolGuardVerdict =
  | { allow: true; note?: SystemInformationalMessage }
  | { allow: false; reason: string }

export type ToolGuard = {
  id: string
  tools?: readonly string[]
  timeoutMs?: number
  judge: (call: ToolCallUnderGuard, signal: AbortSignal) => Promise<ToolGuardVerdict> | ToolGuardVerdict
}

export type TurnUnderGuard = {
  messages: Message[]
}

export type TurnGuardVerdict = { hold: false } | { hold: true; words: string }

export type TurnGuard = {
  id: string
  timeoutMs?: number
  silent?: boolean
  judge: (turn: TurnUnderGuard, signal: AbortSignal) => Promise<TurnGuardVerdict> | TurnGuardVerdict
}

export type ToolCallJudgement =
  | { refused: false; notes: SystemInformationalMessage[] }
  | { refused: true; guard: string; reason: string; notes: SystemInformationalMessage[] }

export type TurnHold = { guard: string; words: string; silent: boolean }

const DEFAULT_GUARD_TIMEOUT_MS = 5_000

const toolGuards = new Map<string, ToolGuard[]>()
const turnGuards = new Map<string, TurnGuard[]>()

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

export function hasToolGuard(key: string, id: string): boolean {
  return (toolGuards.get(key) ?? []).some(guard => guard.id === id)
}

export function guardsEngaged(key: string): { tool: string[]; turn: string[] } {
  return { tool: (toolGuards.get(key) ?? []).map(guard => guard.id), turn: (turnGuards.get(key) ?? []).map(guard => guard.id) }
}

export function clearGuards(key: string): void {
  toolGuards.delete(key)
  turnGuards.delete(key)
}

export function resetGuardsForTesting(): void {
  toolGuards.clear()
  turnGuards.clear()
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
      Promise.resolve()
        .then(() => run(combined.signal))
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

export async function judgeToolCall(key: string, call: ToolCallUnderGuard, signal?: AbortSignal): Promise<ToolCallJudgement> {
  const notes: SystemInformationalMessage[] = []
  for (const guard of toolGuards.get(key) ?? []) {
    if (!guardWatches(guard, call.tool)) continue
    try {
      const verdict = await judged(guard.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS, signal, inner => guard.judge(call, inner))
      if (!verdict.allow) return { refused: true, guard: guard.id, reason: verdict.reason, notes }
      if (verdict.note) notes.push(verdict.note)
    } catch (error) {
      logForDebugging(`guard ${guard.id} did not judge ${call.tool} (${errorMessage(error)}); the call proceeds`, { level: 'error' })
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
      if (verdict.hold) holds.push({ guard: guard.id, words: verdict.words, silent: guard.silent === true })
    } catch (error) {
      logForDebugging(`guard ${guard.id} threw at the turn's end and holds nothing: ${errorMessage(error)}`, { level: 'error' })
    }
  }
  return holds
}
