import type { ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { all } from '../../utils/generators.js'
import { logError } from '../../utils/log.js'
import { runToolUse } from './toolExecution.js'
import { closeRound } from './loopGuard.js'
import { batchClaimOf, claimsCompatible, type BatchClaim } from './toolBatching.js'
import type { EarlyStarts } from './earlyStarts.js'
import { ownerFromToolUseContext } from '../run/resolveOwner.js'
import { parkBeforeTool } from '../../run-core/pauseGate.js'
import { randomUUID } from 'node:crypto'
import { getAutoCompactThreshold, getBlockingLimit, resolveAutoCompactWindow } from '../compact/autoCompact.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { logForDebugging } from '../../utils/debug.js'
import { bindResultRoom, bindResultRoomRound, createResultRoom, resultRoomBudget, resultRoomFor, resultRoomForRound, type ResultRoom } from '../run/resultRoom.js'


type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10

function maxToolUseConcurrency(): number {
  return DEFAULT_MAX_TOOL_USE_CONCURRENCY
}

function parentMessageFor(
  block: ToolUseBlock,
  assistantMessages: AssistantMessage[],
): AssistantMessage {
  return assistantMessages.find(message => {
    const content = message.message.content
    return (
      Array.isArray(content) &&
      content.some(entry => entry.type === 'tool_use' && entry.id === block.id)
    )
  }) as AssistantMessage
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

export function openResultRoomForRound(roundID: string, assistantMessages: readonly AssistantMessage[], context: ToolUseContext): ResultRoom | null {
  const model = context.options.engineModel
  if (typeof model !== 'string' || model === '' || assistantMessages.length === 0) return null
  const held = resultRoomForRound(roundID) ?? assistantMessages.map(resultRoomFor).find(room => room !== null) ?? null
  if (held !== null) {
    bindResultRoom(held, assistantMessages)
    bindResultRoomRound(roundID, held)
    return held
  }
  const gauge = tokenCountWithEstimation([...context.messages, ...assistantMessages], model)
  const budget = resultRoomBudget({
    window: resolveAutoCompactWindow(model).window,
    blockingLimit: getBlockingLimit(model),
    foldLine: getAutoCompactThreshold(model),
    gauge,
  })
  if (!budget.awake) return null
  const room = createResultRoom(budget)
  bindResultRoom(room, assistantMessages)
  bindResultRoomRound(roundID, room)
  logForDebugging(`result room: the context reads ${gauge} tokens past the line at ${budget.line} — this round's results share a ceiling of ${budget.ceiling} tokens (room ${budget.room} to the blocking limit, floor ${budget.floor} per result)`)
  return room
}

export async function* runTools(
  toolUseBlocks: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  early?: EarlyStarts,
): AsyncGenerator<MessageUpdate> {
  let context = toolUseContext
  await early?.ready()
  const roundID = early?.roundID ?? `round:${randomUUID()}`
  openResultRoomForRound(roundID, assistantMessages, toolUseContext)

  const batches: Array<{ concurrent: boolean; blocks: ToolUseBlock[]; claims: BatchClaim[] }> = []
  for (const block of toolUseBlocks) {
    const claim = await batchClaimOf(block, context)
    const lastBatch = batches[batches.length - 1]
    if (claim.kind !== 'exclusive' && lastBatch?.concurrent && lastBatch.claims.every(held => claimsCompatible(held, claim))) {
      lastBatch.blocks.push(block)
      lastBatch.claims.push(claim)
    } else {
      batches.push({ concurrent: claim.kind !== 'exclusive', blocks: [block], claims: [claim] })
    }
  }

  for (const batch of batches) {
    if (batch.concurrent && batch.blocks.length > 0) {
      const queuedModifiers = new Map<string, Array<(c: ToolUseContext) => ToolUseContext>>()
      const currentContext = context
      const generators = batch.blocks.map(block => {
        addInProgress(currentContext, block.id)
        const parent = parentMessageFor(block, assistantMessages)
        return (async function* one(): AsyncGenerator<MessageUpdate> {
          try {
            const taken = early?.take(block.id)
            if (taken === undefined) await parkBeforeBlock(block, currentContext)
            for await (const update of taken?.updates ?? runToolUse(block, parent, canUseTool, currentContext, { id: roundID, ordinal: toolUseBlocks.indexOf(block) })) {
              if (update.contextModifier) {
                const queue = queuedModifiers.get(update.contextModifier.toolUseID) ?? []
                queue.push(update.contextModifier.modifier)
                queuedModifiers.set(update.contextModifier.toolUseID, queue)
              }
              yield { message: update.message, newContext: currentContext }
            }
          } finally {
            removeInProgress(currentContext, block.id)
          }
        })()
      })
      yield* all(generators, maxToolUseConcurrency())
      for (const block of batch.blocks) {
        for (const modifier of queuedModifiers.get(block.id) ?? []) {
          try {
            context = modifier(context)
          } catch (error) {
            logError(error)
          }
        }
      }
      yield { newContext: context }
    } else {
      for (const block of batch.blocks) {
        addInProgress(context, block.id)
        const parent = parentMessageFor(block, assistantMessages)
        try {
          const taken = early?.take(block.id)
          if (taken === undefined) await parkBeforeBlock(block, context)
          for await (const update of taken?.updates ?? runToolUse(block, parent, canUseTool, context, { id: roundID, ordinal: toolUseBlocks.indexOf(block) })) {
            if (update.contextModifier) {
              try {
                context = update.contextModifier.modifier(context)
              } catch (error) {
                logError(error)
              }
            }
            yield { message: update.message, newContext: context }
          }
        } finally {
          removeInProgress(context, block.id)
        }
      }
    }
  }
  const verdict = closeRound(
    ownerFromToolUseContext(toolUseContext),
    roundID,
    !toolUseContext.abortController.signal.aborted,
  )
  for (const message of verdict.messages) {
    yield { message, newContext: context }
  }
}
