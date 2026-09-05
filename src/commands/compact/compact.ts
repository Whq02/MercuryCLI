import chalk from 'chalk'
import { markPostCompaction } from '../../bootstrap/state.js'
import { getUserContext } from '../../context.js'
import {
  compactConversation,
  ERROR_MESSAGE_FOLD_TIMEOUT,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  type CompactionResult,
  withFoldStatus,
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

const reactiveCompact: typeof import('../../services/compact/reactiveCompact.js') | null = null

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
    delete summary.isVisibleInTranscriptOnly
    const existing = summary.summarizeMetadata
    summary.summarizeMetadata = {
      ...existing,
      messagesSummarized: existing?.messagesSummarized ?? computedCount,
      ...(customInstructions ? { userContext: existing?.userContext ?? customInstructions } : {}),
      ...(pct !== undefined ? { contextReclaimedPct: pct } : {}),
      ...(pctValid ? { tokensBefore: pre, tokensAfter: post } : {}),
      ...(kept > 0 ? { keptMessages: kept } : {}),
    } as UserMessage['summarizeMetadata']
  }
}

function shouldEnrichForLiveDisplay(context: LocalJSXCommandContext): boolean {
  if (!context.options.isNonInteractiveSession) return true
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  return withFoldStatus(context, () => callUnderFoldStatus(args, context))
}

async function callUnderFoldStatus(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  const projected = getMessagesAfterCompactBoundary(context.messages)
  if (projected.length === 0) {
    throw new Error('No messages to compact.')
  }
  const customInstructions = args.trim()

  try {
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(projected, context.agentId, undefined, context)
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

    if (reactiveCompact !== null && reactiveCompact.isReactiveOnlyMode()) {
    }

    const { messages: microcompacted } = await microcompactMessages(projected, context, 'compact')
    const cacheSafeParams = await buildCompactCacheSafeParams(microcompacted, context)
    const result = await compactConversation(
      microcompacted,
      context,
      cacheSafeParams,
      false,
      customInstructions || undefined,
      false,
      {
        isRecompaction: false,
        turnsSincePreviousCompact: -1,
        autoCompactThreshold: getAutoCompactThreshold(context.options.mainLoopModel),
      },
    )
    setLastSummarizedMessageId(undefined)
    suppressCompactWarning()
    getUserContext.cache?.clear?.()
    runPostCompactCleanup()
    if (shouldEnrichForLiveDisplay(context)) {
      enrichSummaryForLiveDisplay(result, microcompacted.length, customInstructions)
    }
    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result, microcompacted.length, result.userDisplayMessage),
    }
  } catch (error) {
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
