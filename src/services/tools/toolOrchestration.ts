import type { Tool, ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { all } from '../../utils/generators.js'
import { logError } from '../../utils/log.js'
import type { MessageUpdateLazy } from './toolExecution.js'
import { runToolUse } from './toolExecution.js'
import { getCwd } from '../../utils/cwd.js'
import {
  consultRepetitionGuard,
  consultRoundRepetitionGuard,
  identicalRetryRefusalMessage,
  identityKeyFor,
  recordRoundOutcome,
  recordToolOutcome,
  repetitionRoundNudgeFor,
  roundIdentityOf,
  toolResultOf,
  type RoundSettlement,
} from './identicalFailureGuard.js'


export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10

function maxToolUseConcurrency(): number {
  return DEFAULT_MAX_TOOL_USE_CONCURRENCY
}

function isConcurrencySafeBlock(block: ToolUseBlock, context: ToolUseContext): boolean {
  try {
    const tool: Tool | undefined = findToolByName(context.options.tools, block.name)
    if (!tool) return false
    const parsed = tool.inputSchema.safeParse(block.input)
    if (!parsed.success) return false
    return tool.isConcurrencySafe(parsed.data as never) === true
  } catch {
    return false
  }
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

export async function* runTools(
  toolUseBlocks: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate> {
  let context = toolUseContext

  const roundCalls = toolUseBlocks.map(block => ({
    toolName: block.name,
    key: identityKeyFor(block.name, block.input, getCwd()),
  }))
  const roundKey = roundIdentityOf(roundCalls)
  if (roundKey !== null) {
    const armed = consultRoundRepetitionGuard(toolUseContext.abortController, roundKey)
    if (armed !== null) {
      const nudge = repetitionRoundNudgeFor(armed, toolUseBlocks.length)
      for (const block of toolUseBlocks) {
        const parent = parentMessageFor(block, assistantMessages)
        yield {
          message: identicalRetryRefusalMessage(block.id, parent.uuid as string, armed, nudge),
          newContext: context,
        }
      }
      return
    }
  }
  const roundSettlements = new Map<string, NonNullable<RoundSettlement>>()

  const batches: Array<{ concurrent: boolean; blocks: ToolUseBlock[] }> = []
  for (const block of toolUseBlocks) {
    const safe = isConcurrencySafeBlock(block, context)
    const lastBatch = batches[batches.length - 1]
    if (safe && lastBatch?.concurrent) {
      lastBatch.blocks.push(block)
    } else {
      batches.push({ concurrent: safe, blocks: [block] })
    }
  }

  for (const batch of batches) {
    if (batch.concurrent && batch.blocks.length > 0) {
      const queuedModifiers = new Map<string, Array<(c: ToolUseContext) => ToolUseContext>>()
      const currentContext = context
      const generators = batch.blocks.map(block => {
        const guardKey = identityKeyFor(block.name, block.input, getCwd())
        const armed = consultRepetitionGuard(currentContext.abortController, guardKey)
        if (armed !== null) {
          const parent = parentMessageFor(block, assistantMessages)
          return (async function* refused(): AsyncGenerator<MessageUpdate> {
            yield {
              message: identicalRetryRefusalMessage(block.id, parent.uuid as string, armed),
              newContext: currentContext,
            }
          })()
        }
        addInProgress(currentContext, block.id)
        const parent = parentMessageFor(block, assistantMessages)
        return (async function* one(): AsyncGenerator<MessageUpdate> {
          try {
            for await (const update of runToolUse(block, parent, canUseTool, currentContext)) {
              if (update.contextModifier) {
                const queue = queuedModifiers.get(update.contextModifier.toolUseID) ?? []
                queue.push(update.contextModifier.modifier)
                queuedModifiers.set(update.contextModifier.toolUseID, queue)
              }
              const settled = toolResultOf(update.message, block.id)
              if (settled) {
                recordToolOutcome(currentContext.abortController, guardKey, settled[0], settled[1])
                roundSettlements.set(block.id, { key: guardKey, resultText: settled[0], isError: settled[1] })
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
        const guardKey = identityKeyFor(block.name, block.input, getCwd())
        const armed = consultRepetitionGuard(context.abortController, guardKey)
        if (armed !== null) {
          const parent = parentMessageFor(block, assistantMessages)
          yield {
            message: identicalRetryRefusalMessage(block.id, parent.uuid as string, armed),
            newContext: context,
          }
          continue
        }
        addInProgress(context, block.id)
        const parent = parentMessageFor(block, assistantMessages)
        try {
          for await (const update of runToolUse(block, parent, canUseTool, context)) {
            if (update.contextModifier) {
              try {
                context = update.contextModifier.modifier(context)
              } catch (error) {
                logError(error)
              }
            }
            const settled = toolResultOf(update.message, block.id)
            if (settled) {
              recordToolOutcome(context.abortController, guardKey, settled[0], settled[1])
              roundSettlements.set(block.id, { key: guardKey, resultText: settled[0], isError: settled[1] })
            }
            yield { message: update.message, newContext: context }
          }
        } finally {
          removeInProgress(context, block.id)
        }
      }
    }
  }

  if (roundKey !== null) {
    recordRoundOutcome(
      toolUseContext.abortController,
      roundKey,
      roundCalls,
      toolUseBlocks.map(block => roundSettlements.get(block.id) ?? null),
    )
  }
}
