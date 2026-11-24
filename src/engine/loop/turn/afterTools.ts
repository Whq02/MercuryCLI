import { FRESH_OVERFLOW_EPISODE } from '../../compaction/overflowRecovery.js'
import { buildRewindRecordIfSettled } from '../../compaction/checkpointRewind.js'
import { createAttachmentMessage, getAttachmentMessages } from '../../attachments/attachments.js'
import { createSystemMessage, createUserInterruptionMessage, createUserMessage } from '../../messages/messages.js'
import { SLEEP_TOOL_NAME } from '../../../tools/sleep/prompt.js'
import type { ToolUseContext } from '../../../tools/kit/tool.js'
import { notifyCommandLifecycle } from '../../../daemon/runner/commandLifecycle.js'
import { getDrainableCommands, isSlashCommand, markDraining, remove } from '../../../daemon/runner/messageQueueManager.js'
import { interruptedToolsLine } from '../../message-shapes/rejectionText.js'
import { consumeDrainedCommands, replyMarkOf, selectDrainableCommands } from '../attachment-drain.js'
import type { RunEvent } from '../events.js'
import type { IterationState, NextTurn, RunCtx, SettledDecision } from './turnState.js'

export const MAX_TURNS_CLOSING_TEXT =
  'The turn budget is spent: no further tool call will run. Answer in text only — what was done, what was found, and what remains.'

function refreshTurnTools(context: ToolUseContext): ToolUseContext {
  const { options } = context
  if (!options.refreshTools) return context
  const tools = options.refreshTools()
  if (tools === options.tools) return context
  return { ...context, options: { ...options, tools } }
}

async function* drainQueuedCommands(run: RunCtx, iter: IterationState, toolUseContext: ToolUseContext): AsyncGenerator<RunEvent, void> {
  const sleepRan = iter.toolUseBlocks.some(block => block.name === SLEEP_TOOL_NAME)
  const isMainThread = run.querySource.startsWith('main_thread') || run.querySource === 'sdk'
  const selected = selectDrainableCommands(getDrainableCommands(sleepRan), { sleepRan, isMainThread, agentId: toolUseContext.agentId }, isSlashCommand)
  const modeNotice = isMainThread && toolUseContext.agentId === undefined ? (toolUseContext.takeModeNotice?.() ?? null) : null
  const riding = modeNotice === null ? selected : [...selected, modeNotice]
  const history = [...iter.messagesForRequest, ...iter.assistantMessages, ...iter.toolResults]
  const delivered = new Set<string>()
  let drained = false
  markDraining(selected)
  try {
    try {
      for await (const row of getAttachmentMessages(null, toolUseContext, riding, history, run.querySource)) {
        if (row.attachment.type === 'queued_command' && row.attachment.source_uuid !== undefined) delivered.add(row.attachment.source_uuid)
        yield run.emit({ kind: 'attachment', message: row })
        iter.toolResults.push(row)
        const mark = replyMarkOf(row)
        if (mark !== null) run.awaitingReply.push(mark)
      }
      drained = true
    } finally {
      const consumable = drained ? selected : selected.filter(command => command.uuid !== undefined && delivered.has(command.uuid))
      run.consumedCommandUuids.push(...consumeDrainedCommands(consumable, { notifyStarted: uuid => notifyCommandLifecycle(uuid, 'started'), removeFromQueue: remove }))
    }
  } finally {
    markDraining([])
  }
  for (const command of selected) {
    if (command.uuid !== undefined && (command.mode === 'prompt' || command.mode === 'task-notification')) {
      yield run.emit({ kind: 'followup_drained', uuid: command.uuid, source: command.mode })
    }
  }
}

export async function* afterTools(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  const { emit } = run
  const { maxTurns } = run.params
  const { signal } = iter.toolUseContext.abortController
  const nextTurnCount = iter.state.turnCount + 1
  const pastBudget = run.budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)

  if (signal.aborted) {
    const steer = signal.reason === 'interrupt'
    yield emit({
      kind: 'interruption',
      phase: 'tools',
      steer,
      message: steer ? null : createUserInterruptionMessage({ toolUse: true, reason: signal.reason }),
    })
    yield emit({ kind: 'notice', message: createSystemMessage(interruptedToolsLine(iter.toolUseBlocks.map(block => block.name)), 'warning') })
    if (pastBudget && maxTurns !== undefined) {
      yield emit({ kind: 'attachment', message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount }) })
    }
    return { kind: 'end', terminal: { reason: 'aborted_tools' } }
  }
  if (iter.shouldPreventContinuation) return { kind: 'end', terminal: { reason: 'hook_stopped' } }
  if (iter.loopStoppedCycle !== null) {
    if (iter.loopStoppedRecord !== null) yield emit({ kind: 'attachment', message: iter.loopStoppedRecord })
    return { kind: 'end', terminal: { reason: 'loop_stopped', cycle: iter.loopStoppedCycle } }
  }

  const rewind = buildRewindRecordIfSettled([...iter.messagesForRequest, ...iter.assistantMessages, ...iter.toolResults], iter.toolUseBlocks, iter.toolResults)
  if (rewind !== null) {
    yield emit({ kind: 'attachment', message: rewind })
    iter.toolResults.push(rewind)
  }
  if (iter.tracking?.compacted === true) iter.tracking.turnCounter++
  yield* drainQueuedCommands(run, iter, iter.updatedToolUseContext)

  const closingNote = pastBudget ? [createUserMessage({ content: MAX_TURNS_CLOSING_TEXT, isMeta: true })] : []
  const next: NextTurn = {
    messages: [...iter.messagesForRequest, ...iter.assistantMessages, ...iter.toolResults, ...closingNote],
    toolUseContext: { ...refreshTurnTools(iter.updatedToolUseContext), callChain: iter.callChain },
    turnCount: nextTurnCount,
    transition: { reason: 'next_turn' },
    stopHookActive: iter.state.stopHookActive,
    autoFoldTracking: iter.tracking,
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
  }
  return { kind: 'hand_over', next }
}
