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

/**
 * Turn-level tool orchestration: batch a turn's tool calls into concurrent
 * (read-only) and serial runs, and thread context modifiers.
 */

/** An optional message plus the current context. */
export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

/** Default concurrent-execution cap (contract data). */
const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10

/** The fixed cap (no env override exists). */
function maxToolUseConcurrency(): number {
  return DEFAULT_MAX_TOOL_USE_CONCURRENCY
}

/**
 * A block is concurrency-safe only when its tool resolves in the session
 * tool list, its input parses against that tool's schema, and the tool's
 * concurrency predicate answers true. A predicate that throws is treated
 * as not concurrency-safe — conservative by design.
 */
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

/** The parent assistant message whose content contains this block's id.
 *  A block with no parent in the list is a caller error, not a handled
 *  case — the match is assumed to succeed. */
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

/**
 * Run a turn's tool-use blocks. Consecutive concurrency-safe blocks form
 * one concurrent batch (bounded by the environment cap) whose context
 * modifiers are queued and applied after the batch drains, in block order;
 * anything else runs serially, each modifier applied immediately so the
 * next call sees the modified context. Every yielded update carries the
 * live context.
 */
export async function* runTools(
  toolUseBlocks: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate> {
  let context = toolUseContext

  // The ROUND-level repetition breaker (the batch blindness fix): a
  // multi-call round whose identity — the set of member identities — just
  // repeated with identical results enough rounds in a row is refused WHOLE
  // with the one-shot round nudge; the per-call consult below cannot see
  // this shape (A, B, A, B, … resets its single record every settlement).
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
  // Per-block settled results, for the round record after the batches drain.
  const roundSettlements = new Map<string, NonNullable<RoundSettlement>>()

  // Partition into batches of consecutive concurrency-safe blocks; a
  // non-safe batch contains exactly one block.
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
      // Queued modifiers, applied after the batch in block order — never
      // mid-batch.
      const queuedModifiers = new Map<string, Array<(c: ToolUseContext) => ToolUseContext>>()
      const currentContext = context
      const generators = batch.blocks.map(block => {
        // The repetition breaker: a call whose identity just settled
        // identically (same failure, or same result) enough times in a row
        // is refused with the one-shot nudge for that streak instead of
        // running.
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
      // Apply queued modifiers in block order, each block's in production
      // order, then surface the new context.
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
        // The repetition breaker — see the concurrent branch.
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

  // The round settles as one fact: every member's result in block order (an
  // unsettled member — refused, aborted — reaches the recorder as null and
  // keeps the round neutral).
  if (roundKey !== null) {
    recordRoundOutcome(
      toolUseContext.abortController,
      roundKey,
      roundCalls,
      toolUseBlocks.map(block => roundSettlements.get(block.id) ?? null),
    )
  }
}
