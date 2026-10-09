import { hookEndingSentence } from '../../rows/vocabulary.js'
import { logForDebugging } from '../debug.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { wrapInSystemReminder } from '../messages.js'
import { boundHookContext } from './contextBound.js'
import { readStdoutAnswer, type HookOutcome } from './answer.js'
import type { CommandHookProcess } from './commandRunner.js'
import { HOOK_BACKGROUND_ANSWER_FIELDS, type HookEvent } from './contract.js'
import type { HookSource } from './hooksConfigSnapshot.js'
import type { HookScope } from './sessionHooks.js'

type BackgroundHook = {
  id: string
  name: string
  event: HookEvent
  source: HookSource
  process: CommandHookProcess
  wake: boolean
  scope: HookScope
  startedAt: number
}

const running = new Map<string, BackgroundHook>()
const settled: HookOutcome[] = []

function settle(hook: BackgroundHook, state: HookOutcome['state'], durationMs: number): void {
  running.delete(hook.id)
  settled.push({ id: hook.id, name: hook.name, event: hook.event, source: hook.source, durationMs, state })
}

function readBackgroundAnswer(hook: BackgroundHook, stdout: string, stderr: string, code: number): HookOutcome['state'] {
  if (code === 2) {
    const words = stderr.trim() || `${hook.name} blocked ${hook.event} without a word`
    if (!hook.wake) return { kind: 'failed', line: hookEndingSentence({ status: 'failed', class: 'answer', exit_code: 2, detail: 'a background hook cannot block; `wake` lets its block wake the model' }, { name: hook.name, event: hook.event }) }
    enqueuePendingNotification({ value: wrapInSystemReminder(`hook ${hook.name} (${hook.event}) blocked: ${boundHookContext(words, `${hook.name}-wake`).text}`), mode: 'task-notification' })
    return { kind: 'answered', answer: { notice: `hook ${hook.name} blocked ${hook.event}: ${words}` } }
  }
  if (code !== 0) return { kind: 'failed', line: hookEndingSentence({ status: 'failed', class: 'exit', exit_code: code, detail: stderr.trim() }, { name: hook.name, event: hook.event }) }
  const read = readStdoutAnswer(hook.event, stdout)
  if (read.kind === 'fault') return { kind: 'failed', line: hookEndingSentence({ status: 'failed', class: 'answer', exit_code: 0, detail: read.fault }, { name: hook.name, event: hook.event }) }
  if (read.kind === 'text') return { kind: 'text', text: read.text }
  const strangers = Object.keys(read.answer).filter(field => !(HOOK_BACKGROUND_ANSWER_FIELDS as readonly string[]).includes(field))
  if (strangers.length > 0) {
    return { kind: 'failed', line: hookEndingSentence({ status: 'failed', class: 'answer', exit_code: 0, detail: `a background hook may answer ${HOOK_BACKGROUND_ANSWER_FIELDS.join(' and ')} only; it answered \`${strangers[0]}\`` }, { name: hook.name, event: hook.event }) }
  }
  return { kind: 'answered', answer: read.answer }
}

export function startBackgroundHook(hook: Omit<BackgroundHook, 'startedAt' | 'source'> & { source?: HookSource }): void {
  const entry: BackgroundHook = { ...hook, source: hook.source ?? { kind: 'settings', layer: 'user' }, startedAt: Date.now() }
  running.set(hook.id, entry)
  logForDebugging(`hook ${hook.name} (${hook.event}) runs in the background`)
  void hook.process.result.then(end => {
    if (end.kind === 'ended') {
      settle(entry, { kind: 'failed', line: hookEndingSentence(end.ending, { name: hook.name, event: hook.event }) }, end.durationMs)
      return
    }
    settle(entry, readBackgroundAnswer(entry, end.stdout, end.stderr, end.code), end.durationMs)
  })
}

export function takeBackgroundHookOutcomes(): HookOutcome[] {
  if (settled.length === 0) return []
  return settled.splice(0, settled.length)
}

export function backgroundHooksRunning(): number {
  return running.size
}

export async function endBackgroundHooks(): Promise<void> {
  const open = [...running.values()]
  for (const hook of open) hook.process.kill()
  await Promise.all(open.map(hook => hook.process.result.catch(() => undefined)))
  running.clear()
}

export function resetBackgroundHooksForTesting(): void {
  running.clear()
  settled.length = 0
}
