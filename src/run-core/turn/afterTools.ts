import { FRESH_OVERFLOW_EPISODE } from '../../services/compact/overflowRecovery.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  createSystemMessage,
} from '../../utils/messages.js'
import { buildRewindRecordIfSettled } from '../../services/compact/checkpointRewind.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../../utils/attachments.js'
import {
  remove as removeFromQueue,
  getDrainableCommands,
  markDraining,
  isSlashCommand,
} from '../../utils/messageQueueManager.js'
import { notifyCommandLifecycle } from '../../utils/commandLifecycle.js'
import { SLEEP_TOOL_NAME } from '../../tools/SleepTool/prompt.js'
import { interruptedToolsLine } from '../../utils/messages/rejectionText.js'
import type { Terminal } from '../../query/transitions.js'
import {
  consumeDrainedCommands,
  replyMarkOf,
  selectDrainableCommands,
} from '../attachment-drain.js'
import type { RunEvent } from '../events.js'
import type { IterationState, NextTurn, RunCtx, SettledDecision } from './state.js'

export const MAX_TURNS_CLOSING_TEXT =
  'The turn budget is spent: no further tool call will run. Answer in text only — what was done, what was found, and what remains.'

function refreshTurnTools(context: ToolUseContext): ToolUseContext {
  const { options } = context
  if (!options.refreshTools) return context
  const tools = options.refreshTools()
  if (tools === options.tools) return context
  return { ...context, options: { ...options, tools } }
}

async function* drainQueuedCommands(run: RunCtx, iter: IterationState, updatedToolUseContext: ToolUseContext): AsyncGenerator<RunEvent> {
  const { emit, querySource, awaitingReply, consumedCommandUuids } = run
  const { toolUseContext, messagesForQuery, assistantMessages, toolResults, toolUseBlocks } = iter
  const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
  const currentAgentId = toolUseContext.agentId
  const isMainThread =
    currentAgentId === undefined &&
    (querySource.startsWith('main_thread') || querySource === 'sdk')
  const queuedCommandsSnapshot = selectDrainableCommands(
    getDrainableCommands(sleepRan),
    { sleepRan, isMainThread, agentId: currentAgentId },
    isSlashCommand,
  )
  markDraining(queuedCommandsSnapshot)

  const yieldedCommandUuids = new Set<string>()
  let drainProduced = false
  try {
    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      const att = attachment.attachment as { type?: string; source_uuid?: string }
      if (att.type === 'queued_command' && typeof att.source_uuid === 'string') {
        yieldedCommandUuids.add(att.source_uuid)
      }
      yield emit({ kind: 'attachment', message: attachment })
      toolResults.push(attachment)
      const mark = replyMarkOf(attachment)
      if (mark !== null) awaitingReply.push(mark)
    }
    drainProduced = true
  } finally {
    markDraining([])
    consumedCommandUuids.push(
      ...consumeDrainedCommands(
        drainProduced
          ? queuedCommandsSnapshot
          : queuedCommandsSnapshot.filter(
              cmd => cmd.uuid !== undefined && yieldedCommandUuids.has(cmd.uuid),
            ),
        {
          notifyStarted: uuid => notifyCommandLifecycle(uuid, 'started'),
          removeFromQueue,
        },
      ),
    )
  }

  for (const cmd of queuedCommandsSnapshot) {
    if (
      (cmd.mode === 'prompt' || cmd.mode === 'task-notification') &&
      cmd.uuid
    ) {
      yield emit({
        kind: 'followup_drained',
        uuid: cmd.uuid,
        source: cmd.mode,
      })
    }
  }
}

export async function* afterTools(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  const { emit, budgetGuard } = run
  const { maxTurns } = run.params
  const { state, toolUseContext, messagesForQuery, tracking, callChain, assistantMessages, toolResults, toolUseBlocks, shouldPreventContinuation, loopStoppedCycle, loopStoppedRecord } = iter
  const { stopHookActive, turnCount } = state
  let { updatedToolUseContext } = iter

  if (toolUseContext.abortController.signal.aborted) {
    const cutReason = toolUseContext.abortController.signal.reason
    const steer = cutReason === 'interrupt'
    yield emit({
      kind: 'interruption',
      phase: 'tools',
      steer,
      message: steer ? null : createUserInterruptionMessage({ toolUse: true, reason: cutReason }),
    })
    yield emit({
      kind: 'notice',
      message: createSystemMessage(interruptedToolsLine(toolUseBlocks.map(block => block.name)), 'warning'),
    })
    const nextTurnCountOnAbort = turnCount + 1
    if (
      maxTurns !== undefined &&
      budgetGuard.maxTurnsExceeded(nextTurnCountOnAbort, maxTurns)
    ) {
      yield emit({
        kind: 'attachment',
        message: createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        }),
      })
    }
    const terminal: Terminal = { reason: 'aborted_tools' }
    return { kind: 'end', terminal }
  }

  if (shouldPreventContinuation) {
    const terminal: Terminal = { reason: 'hook_stopped' }
    return { kind: 'end', terminal }
  }
  if (loopStoppedCycle !== null) {
    if (loopStoppedRecord !== null) yield emit({ kind: 'attachment', message: loopStoppedRecord })
    const terminal: Terminal = { reason: 'loop_stopped', cycle: loopStoppedCycle }
    return { kind: 'end', terminal }
  }

  {
    const rewindRecord = buildRewindRecordIfSettled(
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseBlocks,
      toolResults,
    )
    if (rewindRecord !== null) {
      yield emit({ kind: 'attachment', message: rewindRecord })
      toolResults.push(rewindRecord)
    }
  }

  if (tracking?.compacted) {
    tracking.turnCounter++
  }

  yield* drainQueuedCommands(run, iter, updatedToolUseContext)

  updatedToolUseContext = refreshTurnTools(updatedToolUseContext)
  const contextForNextTurn = { ...updatedToolUseContext, callChain }

  const nextTurnCount = turnCount + 1

  const closingNext =
    maxTurns !== undefined && budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)
      ? [createUserMessage({ content: MAX_TURNS_CLOSING_TEXT, isMeta: true })]
      : []

  const next: NextTurn = {
    messages: [...messagesForQuery, ...assistantMessages, ...toolResults, ...closingNext],
    toolUseContext: contextForNextTurn,
    autoCompactTracking: tracking,
    turnCount: nextTurnCount,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
    maxOutputTokensOverride: undefined,
    stopHookActive,
    transition: { reason: 'next_turn' },
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
  }
  return { kind: 'hand_over', next }
}
