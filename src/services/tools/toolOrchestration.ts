import type { CanUseToolFn, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { all } from '../../utils/generators.js'
import { logError } from '../../utils/log.js'
import { runToolUse, type MessageUpdateLazy } from './toolExecution.js'
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


type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

const CONCURRENT_CALLS_CEILING = 10

type ClaimedCall = { block: ToolUseBlock; ordinal: number; claim: BatchClaim }

type CallBatch = { exclusive: boolean; calls: ClaimedCall[] }

function parentOf(block: ToolUseBlock, assistantMessages: readonly AssistantMessage[]): AssistantMessage | undefined {
  return assistantMessages.find(row => row.message.content.some(part => part.type === 'tool_use' && part.id === block.id))
}

function batchesOf(calls: readonly ClaimedCall[]): CallBatch[] {
  const batches: CallBatch[] = []
  for (const call of calls) {
    const last = batches.at(-1)
    if (call.claim.kind !== 'exclusive' && last !== undefined && !last.exclusive && last.calls.every(held => claimsCompatible(held.claim, call.claim))) {
      last.calls.push(call)
      continue
    }
    batches.push({ exclusive: call.claim.kind === 'exclusive', calls: [call] })
  }
  return batches
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
  await early?.ready()
  const roundID = early?.roundID ?? `round:${randomUUID()}`
  const gate = early?.gate ?? canUseTool
  const owner = ownerFromToolUseContext(toolUseContext)
  const { signal } = toolUseContext.abortController
  openResultRoomForRound(roundID, assistantMessages, toolUseContext)

  async function* updatesOf(call: ClaimedCall, context: ToolUseContext): AsyncGenerator<MessageUpdateLazy, void> {
    const { block } = call
    addInProgress(context, block.id)
    try {
      const adopted = early?.take(block.id)
      if (adopted !== undefined) {
        yield* adopted.updates
        return
      }
      await parkBeforeBlock(block, context)
      yield* runToolUse(block, parentOf(block, assistantMessages)!, gate, context, { id: roundID, ordinal: call.ordinal })
    } finally {
      removeInProgress(context, block.id)
    }
  }

  const calls: ClaimedCall[] = []
  for (const [ordinal, block] of toolUseBlocks.entries()) {
    calls.push({ block, ordinal, claim: await batchClaimOf(block, toolUseContext) })
  }

  let current = toolUseContext
  for (const batch of batchesOf(calls)) {
    if (batch.exclusive) {
      for (const call of batch.calls) {
        for await (const update of updatesOf(call, current)) {
          if (update.contextModifier !== undefined) current = update.contextModifier.modifier(current)
          yield { message: update.message, newContext: current }
        }
      }
      continue
    }
    const snapshot = current
    const modifiers = new Map<string, Array<(context: ToolUseContext) => ToolUseContext>>()
    for await (const update of all(batch.calls.map(call => updatesOf(call, snapshot)), CONCURRENT_CALLS_CEILING)) {
      if (update.contextModifier !== undefined) {
        modifiers.set(update.contextModifier.toolUseID, [...(modifiers.get(update.contextModifier.toolUseID) ?? []), update.contextModifier.modifier])
      }
      yield { message: update.message, newContext: snapshot }
    }
    for (const call of batch.calls) {
      for (const modifier of modifiers.get(call.block.id) ?? []) {
        try {
          current = modifier(current)
        } catch (error) {
          logError(error)
        }
      }
    }
    yield { newContext: current }
  }

  for (const message of closeRound(owner, roundID, !signal.aborted).messages) yield { message, newContext: current }
}
