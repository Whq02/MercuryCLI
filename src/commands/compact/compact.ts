import chalk from 'chalk'
import { markPostCompaction } from '../../bootstrap/state.js'
import { getUserContext } from '../../context.js'
import {
  compactConversation,
  ERROR_MESSAGE_FOLD_TIMEOUT,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  type CompactionResult,
} from '../../services/compact/compact.js'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import { suppressCompactWarning } from '../../services/compact/compactWarningState.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { trySessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js'
import { setLastSummarizedMessageId } from '../../services/SessionMemory/sessionMemoryUtils.js'
import { getBindingDisplayText } from '../../keybindings/resolver.js'
import { loadKeybindingsSync } from '../../keybindings/loadUserBindings.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import type { Message, UserMessage } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { fetchSystemPromptParts } from '../../utils/queryContext.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { isAbortError, errorMessage, hasExactErrorMessage } from '../../utils/errors.js'
import { formatTokens } from '../../utils/format.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { logError } from '../../utils/log.js'

/**
 * The reactive-compaction module is absent from this build; the reference is
 * a typed null placeholder so the strategy seam (and its ordering after the
 * session-memory attempt) survives without any reachable body.
 */
const reactiveCompact: typeof import('../../services/compact/reactiveCompact.js') | null = null

/** The cache-sharing parameter build (shared with the reactive seam). */
async function buildCompactCacheSafeParams(
  messages: Message[],
  context: LocalJSXCommandContext,
): Promise<CacheSafeParams> {
  const { options } = context
  const additionalWorkingDirectories = Array.from(
    context.getAppState().toolPermissionContext.additionalWorkingDirectories.keys(),
  )
  const { defaultSystemPrompt, userContext, systemContext } = await fetchSystemPromptParts({
    tools: options.tools,
    mainLoopModel: options.mainLoopModel,
    additionalWorkingDirectories,
    mcpClients: options.mcpClients,
    customSystemPrompt: options.customSystemPrompt,
    permissionMode: context.getAppState().toolPermissionContext.mode,
  })
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
  })
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages: messages,
  }
}

/**
 * The visible receipt (operator-ruled: "Compacted" alone is not a receipt):
 * the past-tense word carries the fold's own numbers — how many messages
 * folded into the summary, the context weight before → after (the result's
 * real token counts, never fabricated — an absent number simply does not
 * speak), and the verbatim tail's survival. A parenthesised hint names the
 * live transcript-toggle chord (where the full summary — what the agent now
 * retains — is readable); then the hook-supplied display message and the
 * context-window upgrade tip when they exist, newline-joined.
 */
function buildDisplayText(
  context: LocalJSXCommandContext,
  result: CompactionResult,
  messagesHandedIn: number,
  hookDisplayMessage?: string,
): string {
  const kept = result.messagesToKeep?.length ?? 0
  const folded = Math.max(0, messagesHandedIn - kept)
  const pre = result.preCompactTokenCount
  const post = result.truePostCompactTokenCount
  const facts: string[] = []
  if (folded > 0) facts.push(`folded ${folded} message${folded === 1 ? '' : 's'} into the summary`)
  if (typeof pre === 'number' && pre > 0 && typeof post === 'number' && post >= 0) {
    facts.push(`context ${formatTokens(pre)} → ${formatTokens(post)} tokens`)
  }
  if (kept > 0) facts.push(`last ${kept} message${kept === 1 ? '' : 's'} kept verbatim`)
  const head = facts.length > 0 ? `Compacted — ${facts.join(' · ')}` : 'Compacted'
  const parts: string[] = []
  if (!context.getAppState().verbose) {
    const chord =
      getBindingDisplayText('app:toggleTranscript', 'Global', loadKeybindingsSync()) ?? 'ctrl+o'
    parts.push(`(${chord} reads the full summary — what the agent retains)`)
  }
  if (hookDisplayMessage) parts.push(hookDisplayMessage)
  const tip = getUpgradeMessage(context.getAppState().mainLoopModel)?.tip
  if (tip) parts.push(tip)
  const rest = parts.join('\n')
  return chalk.dim(rest ? `${head}\n${rest}` : head)
}

/**
 * Interactive-only summary enrichment: unhide each compact-summary message
 * so the card renders in the live stream, and attach honest metadata — the
 * summarised-message count (an existing value wins; else handed-in minus
 * kept; else zero), the custom instructions when non-empty, and the REAL
 * reclaimed percentage from the result's own token counts. The percentage
 * is attached only when the pre-count is a positive number and the
 * post-count is a non-negative number; a fabricated figure is never
 * substituted and the card simply renders without its gauge.
 */
function enrichSummaryForLiveDisplay(
  result: CompactionResult,
  messagesHandedIn: number,
  customInstructions: string,
): void {
  const kept = result.messagesToKeep?.length ?? 0
  const computedCount = Math.max(0, messagesHandedIn - kept)

  const pre = result.preCompactTokenCount
  const post = result.truePostCompactTokenCount ?? result.postCompactTokenCount
  const pctValid = typeof pre === 'number' && pre > 0 && typeof post === 'number' && post >= 0
  const pct = pctValid ? Math.round(Math.min(100, Math.max(0, ((pre - post) / pre) * 100))) : undefined

  for (const summary of result.summaryMessages) {
    if (!summary.isCompactSummary) continue
    // The transcript-only flag comes off so the live stream shows the card.
    delete summary.isVisibleInTranscriptOnly
    const existing = summary.summarizeMetadata
    summary.summarizeMetadata = {
      ...existing,
      messagesSummarized: existing?.messagesSummarized ?? computedCount,
      ...(customInstructions ? { userContext: existing?.userContext ?? customInstructions } : {}),
      ...(pct !== undefined ? { contextReclaimedPct: pct } : {}),
      // The receipt's weights and the tail's survival, for the card — the
      // result's own numbers, present only when real.
      ...(pctValid ? { tokensBefore: pre, tokensAfter: post } : {}),
      ...(kept > 0 ? { keptMessages: kept } : {}),
    } as UserMessage['summarizeMetadata']
  }
}

/**
 * Whether this process's /compact should enrich the summary for a live
 * card: interactive sessions always; the daemon-hosted seat child too — it
 * is non-interactive in shape (a stream-json print runner) but its
 * transcript records ARE what the cockpit paints, so a transcript-only
 * summary there hides exactly what the operator must be able to read (what
 * the agent retains). Plain headless -p runs keep the transcript-only
 * summary their consumers expect.
 */
function shouldEnrichForLiveDisplay(context: LocalJSXCommandContext): boolean {
  if (!context.options.isNonInteractiveSession) return true
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  // Only post-boundary messages may reach the summariser: the interactive
  // surface keeps already-folded messages around for scrollback, so the raw
  // list over-states the live context.
  const projected = getMessagesAfterCompactBoundary(context.messages)
  if (projected.length === 0) {
    throw new Error('No messages to compact.')
  }
  const customInstructions = args.trim()

  try {
    // Strategy 1 — session-memory compaction; it cannot honour custom
    // instructions, so any instruction skips straight past it.
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(projected, context.agentId)
      if (sessionMemoryResult !== null) {
        getUserContext.cache?.clear?.()
        runPostCompactCleanup()
        markPostCompaction()
        suppressCompactWarning()
        return {
          type: 'compact',
          compactionResult: sessionMemoryResult,
          displayText: buildDisplayText(context, sessionMemoryResult, projected.length, sessionMemoryResult.userDisplayMessage),
        }
      }
    }

    // Strategy 2 — the reactive seam. The module reference above is a typed
    // null in this build, so the guard never passes; the body has no
    // observable behaviour here and is deliberately not reproduced. The
    // decision point and its ordering after session-memory stay.
    if (reactiveCompact !== null && reactiveCompact.isReactiveOnlyMode()) {
      // Unreachable in this build.
    }

    // Strategy 3 — traditional: microcompact first to shrink tokens, then
    // summarise the microcompacted list with the cache-sharing parameters.
    const { messages: microcompacted } = await microcompactMessages(projected, context, 'compact')
    const cacheSafeParams = await buildCompactCacheSafeParams(microcompacted, context)
    const result = await compactConversation(
      microcompacted,
      context,
      cacheSafeParams,
      false,
      customInstructions || undefined,
      false,
      // The auto-compact threshold is the ceiling a manual fold must end
      // under too — a fold that ends over it only re-triggers next turn.
      {
        isRecompaction: false,
        turnsSincePreviousCompact: -1,
        autoCompactThreshold: getAutoCompactThreshold(context.options.mainLoopModel),
      },
    )
    // Legacy compaction replaces every message; the previously summarised
    // uuid does not exist.
    setLastSummarizedMessageId(undefined)
    suppressCompactWarning()
    getUserContext.cache?.clear?.()
    runPostCompactCleanup()
    if (shouldEnrichForLiveDisplay(context)) {
      // Plain headless flows keep the transcript-only summary they expect;
      // interactive sessions and the hosted seat (whose records the cockpit
      // paints) get the live card.
      enrichSummaryForLiveDisplay(result, microcompacted.length, customInstructions)
    }
    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result, microcompacted.length, result.userDisplayMessage),
    }
  } catch (error) {
    // The observable error contract: an abort wins; the two shared
    // sentinels round-trip byte-identically; everything else is logged and
    // wrapped generically.
    if (context.abortController.signal.aborted || isAbortError(error)) {
      throw new Error('Compaction canceled.')
    }
    if (
      hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES) ||
      hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE) ||
      hasExactErrorMessage(error, ERROR_MESSAGE_FOLD_TIMEOUT)
    ) {
      throw error
    }
    logError(error)
    throw new Error(`Error during compaction: ${errorMessage(error)}`)
  }
}
