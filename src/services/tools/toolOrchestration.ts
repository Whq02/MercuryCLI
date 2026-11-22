import type { CanUseToolFn, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { all } from '../../utils/generators.js'
import { logError } from '../../utils/log.js'
import { runToolUse } from './toolExecution.js'
import { closeRound } from './loopGuard.js'
import { batchClaimOf, claimsCompatible, type BatchClaim } from './toolBatching.js'
import type { EarlyStarts } from './earlyStarts.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { parkBeforeTool } from '../../run-core/pauseGate.js'
import { randomUUID } from 'node:crypto'
import { getAutoCompactThreshold, getBlockingLimit, getEffectiveContextWindowSize, getTurnReserveTokens, MANUAL_COMPACT_BUFFER_TOKENS, resolveAutoCompactWindow } from '../compact/autoCompact.js'
import { getDefaultFileReadingLimits } from '../../utils/fileReadLimits.js'
import { readRequestGauge } from '../run/requestGauge.js'
import { tokenCountWithEstimation } from '../context/tokens.js'
import { logForDebugging } from '../../utils/debug.js'
import { bindResultRoom, bindResultRoomRound, createResultRoom, resultRoomBudget, resultRoomFor, resultRoomForRound, type ResultRoom } from '../run/resultRoom.js'
import { notBuilt } from '../../pi/holes.js'


type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

function addInProgress(context: ToolUseContext, id: string): void {
  try {
    context.setInProgressToolUseIDs?.(prev => new Set([...prev, id]))
  } catch (error) {
    logError(error)
  }
}

function removeInProgress(context: ToolUseContext, id: string): void {
  try {
    context.setInProgressToolUseIDs?.(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  } catch (error) {
    logError(error)
  }
}

async function parkBeforeBlock(block: ToolUseBlock, context: ToolUseContext): Promise<void> {
  await parkBeforeTool(context, block.name)
}

function resultCapOf(context: ToolUseContext): number {
  return (context.fileReadingLimits as { maxTokens?: number } | undefined)?.maxTokens ?? getDefaultFileReadingLimits().maxTokens
}

export function windowHoldsNoWholeResult(context: ToolUseContext): boolean {
  const model = context.options.engineModel
  if (typeof model !== 'string' || model === '') return false
  return getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS - getTurnReserveTokens(model) < resultCapOf(context)
}

export function openResultRoomForRound(roundID: string, assistantMessages: readonly AssistantMessage[], context: ToolUseContext): ResultRoom | null {
  const model = context.options.engineModel
  if (typeof model !== 'string' || model === '' || assistantMessages.length === 0) return null
  const held = resultRoomForRound(roundID) ?? assistantMessages.map(resultRoomFor).find(room => room !== null) ?? null
  if (held !== null) {
    bindResultRoom(held, assistantMessages)
    bindResultRoomRound(roundID, held)
    return held
  }
  const rows = [...context.messages, ...assistantMessages]
  const gauge = tokenCountWithEstimation(rows, model)
  const small = windowHoldsNoWholeResult(context)
  const budget = resultRoomBudget({
    window: resolveAutoCompactWindow(model).window,
    blockingLimit: getBlockingLimit(model),
    foldLine: getAutoCompactThreshold(model),
    gauge,
    ...(small ? { small, density: readRequestGauge(rows, model)?.density.ratio } : {}),
  })
  if (!budget.awake) return null
  const room = createResultRoom(budget)
  bindResultRoom(room, assistantMessages)
  bindResultRoomRound(roundID, room)
  logForDebugging(gauge >= budget.line
    ? `result room: the context reads ${gauge} tokens past the line at ${budget.line} — this round's results share a ceiling of ${budget.ceiling} tokens (room ${budget.room} to the blocking limit, floor ${budget.floor} per result)`
    : `result room: the window holds no whole result of ${resultCapOf(context)} tokens under its fold line — at ${gauge} tokens this round's results share a ceiling of ${budget.ceiling} tokens (room ${budget.room} under the line at ${budget.line}, floor ${budget.floor} per result)`)
  return room
}

export async function* runTools(
  toolUseBlocks: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  early?: EarlyStarts,
): AsyncGenerator<MessageUpdate> {
  return notBuilt('src/services/tools/toolOrchestration.ts:108')
}
