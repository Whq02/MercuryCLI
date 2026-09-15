import type { Tool, ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { all } from '../../utils/generators.js'
import { logError } from '../../utils/log.js'
import type { MessageUpdateLazy } from './toolExecution.js'
import { runToolUse } from './toolExecution.js'


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
          for await (const update of runToolUse(block, parent, canUseTool, context)) {
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
}
