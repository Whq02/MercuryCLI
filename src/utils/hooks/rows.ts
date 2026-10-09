import { randomUUID } from 'node:crypto'
import type { TaskRow } from '../../rows/vocabulary.js'
import { taskRow, type RowScope, type Unstamped } from '../../rows/project.js'
import type { HookAttachment } from '../attachments/types.js'
import type { HookProgress } from '../../types/hooks.js'
import type { ProgressMessage } from '../../types/message.js'
import type { HookOutcome } from './answer.js'
import { plainTextIsContext } from './answer.js'
import type { HookEvent } from './contract.js'
import type { HookFireResult } from './fire.js'
import type { HookExecutionEvent } from './hookEvents.js'

export function hookTaskRow(scope: RowScope, event: HookExecutionEvent): Unstamped<TaskRow> {
  return taskRow(scope, {
    state: event.type === 'started' ? 'started' : event.type === 'progress' ? 'progress' : 'ended',
    taskId: event.hookId,
    callId: scope.parent_call_id,
    taskType: 'hook',
    description: event.hookName,
    ...(event.type === 'started' ? {} : { summary: event.output }),
    ...(event.type === 'response' ? { status: event.outcome === 'success' ? 'completed' : event.outcome === 'cancelled' ? 'stopped' : 'failed' } : {}),
  })
}

export function hookRowsOf(outcomes: readonly HookOutcome[], options: { callId?: string; background?: true } = {}): HookAttachment[] {
  const rows: HookAttachment[] = []
  const row = (outcome: HookOutcome, kind: HookAttachment['outcome'], words: string): void => {
    rows.push({ type: 'hook', outcome: kind, event: outcome.event, name: outcome.name, words, ...(options.callId !== undefined ? { callId: options.callId } : {}), ...(options.background ? { background: true } : {}) })
  }
  for (const outcome of outcomes) {
    const state = outcome.state
    if (state.kind === 'background') continue
    if (state.kind === 'failed') {
      row(outcome, 'failed', state.line)
      continue
    }
    if (state.kind === 'text') {
      row(outcome, plainTextIsContext(outcome.event) ? 'context' : 'text', state.text)
      continue
    }
    const answer = state.answer
    if (answer.context !== undefined) row(outcome, 'context', answer.context)
    if (answer.block !== undefined) row(outcome, 'block', answer.block)
    if (answer.stop !== undefined) row(outcome, 'stop', answer.stop)
    if (answer.notice !== undefined) row(outcome, 'notice', answer.notice)
  }
  return rows
}

export function hookRowsOfResult(result: HookFireResult, options: { callId?: string } = {}): HookAttachment[] {
  const rows = hookRowsOf(result.outcomes, options)
  for (const conflict of result.answer.conflicts) {
    rows.push({ type: 'hook', outcome: 'notice', event: result.event, name: conflict.winner, words: conflict.words, ...(options.callId !== undefined ? { callId: options.callId } : {}) })
  }
  return rows
}

export function hookProgressMessage(event: HookEvent, name: string, state: HookProgress['state'], toolUseID: string, count = 1): ProgressMessage {
  const data: HookProgress = { type: 'hook_progress', event, name, state, count }
  return { type: 'progress', data, parentToolUseID: toolUseID, toolUseID, timestamp: new Date().toISOString(), uuid: randomUUID() } as ProgressMessage
}
