import { resetSessionEnvNoticeOnCompaction } from '../../tools/shared/sessionEnvNotice.js'
import {
  AUTOCOMPACT_THRASH_MESSAGE,
  rapidRefillPauseText,
  calculateTokenWarningState,
  getBlockingLimit,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from '../../services/compact/autoCompact.js'
import { buildPostCompactMessages } from '../../services/compact/compact.js'
import { estimateContextTokens, projectTimeBasedMicrocompact } from '../../services/compact/microCompact.js'
import { fireHooks } from '../../utils/hooks/fire.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  createDeadThinkingAttachment,
  deadThinkingMarks,
} from '../../services/providers/anthropic/thinkingBinding.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  decideOverflowRecovery,
  foldAvailability,
  overflowGapFor,
  overflowLadderArmed,
  overflowRecoveryNotice,
  overflowRefusalText,
  foldRemedyIsHeadless,
  splitCarriedOperatorTail,
  type OverflowEpisode,
} from '../../services/compact/overflowRecovery.js'
import { estimateOverflowSignal } from '../../services/api/overflowSignal.js'
import { advanceToolCallChain, type ToolUseContext } from '../../Tool.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'
import type {
  AttachmentMessage,
  Message,
} from '../../types/message.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from '../../services/api/errors.js'
import {
  createUserMessage,
  createSystemMessage,
  createAssistantAPIErrorMessage,
} from '../../utils/messages.js'
import { appendSystemContext, firstTurnUserContext } from '../../utils/api.js'
import { latestUserContextBody } from '../../utils/attachments/userContext.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { headlessProfilerCheckpoint } from '../../utils/headlessProfiler.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { EarlyStarts } from '../../services/tools/earlyStarts.js'
import { emitCompactionTrace } from '../../utils/observability/invocationTrace.js'
import { flushSessionStorage, recordContentReplacement } from '../../utils/sessionStorage.js'
import { buildRequestContextPlan, type RequestContextPlan } from '../../services/run/requestContextPlan.js'
import { calibrationKeyFor } from '../../services/run/contextCalibration.js'
import { randomUUID, type UUID } from 'node:crypto'
import { requestGaugeFixed } from '../../services/run/requestGauge.js'
import { ERROR_MESSAGE_USER_ABORT } from '../../services/compact/compact.js'
import { toolToAPISchema } from '../../utils/api.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { planToolPayloadUnseeded, toolsOnTheWire } from '../../services/providers/toolEconomy.js'
import { localPromptFitRefusal, localPromptFits } from '../../services/providers/local/localCallModel.js'
import { countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD } from '../../services/context/analyzeContext.js'
import { tellHowToolDefinitionsAreCounted } from '../../utils/toolSearch.js'
import type { QueryDeps } from '../../query/deps.js'
import type { Terminal } from '../../query/transitions.js'
import type { RunEvent } from '../events.js'
import type { IterationState, NextTurn, RequestDecision, RunCtx, SettledDecision, TurnState } from './state.js'

tellHowToolDefinitionsAreCounted(countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD)

type Autocompacted = Awaited<ReturnType<QueryDeps['autocompact']>>

type PlannedContext = {
  requestPlan: RequestContextPlan
  messagesForQuery: Message[]
  prunedTokensFreed: number
  thinkingRecords: AttachmentMessage[]
  fullSystemPrompt: SystemPrompt
}

type FoldedContext = {
  kind: 'go_on'
  messagesForQuery: Message[]
  tracking: AutoCompactTrackingState | undefined
  overflowEpisode: OverflowEpisode
  fullSystemPrompt: SystemPrompt
  compactionResult: Autocompacted['compactionResult']
  consecutiveFailures: Autocompacted['consecutiveFailures']
  measuredRawTokenCount: Autocompacted['measuredRawTokenCount']
  compactionRefusal: Autocompacted['refusal']
  foldSplit: ReturnType<typeof splitCarriedOperatorTail>
}

type FittingRequest = {
  kind: 'go_on'
  toolUseContext: ToolUseContext
  appState: ReturnType<ToolUseContext['getAppState']>
  currentModel: string
}

export async function* planContext(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext): AsyncGenerator<RunEvent, PlannedContext> {
  const { emit, deps, querySource, systemPrompt, userContext, systemContext } = run
  const { messages, pendingOverflow } = state
  const persistReplacements =
    querySource === 'sdk' ||
    querySource.startsWith('agent:') ||
    querySource.startsWith('main_thread')
  const preserveBodies = pendingOverflow?.rung !== 'prune'
  const requestPlan = await buildRequestContextPlan(
    {
      messages,
      owner: ownerFromToolUseContext(toolUseContext),
      querySource,
      engineModel: toolUseContext.options.engineModel,
      contentReplacementState: toolUseContext.contentReplacementState,
      persistReplacements: persistReplacements
        ? async records => {
            await recordContentReplacement(records, toolUseContext.agentId)
            await flushSessionStorage()
          }
        : undefined,
      skipToolNames: new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
      microcompact: deps.microcompact,
      preserveBodies,
      readFileState: toolUseContext.readFileState,
      calibrationKey: (() => {
        const model = toolUseContext.options.engineModel
        return typeof model === 'string' && model
          ? calibrationKeyFor(declaredRouteOf(model) ?? 'unrecognised', model)
          : null
      })(),
      fixedRequest: requestGaugeFixed({
        system: appendSystemContext(systemPrompt, systemContext, toolUseContext.options.engineModel),
        userContext: latestUserContextBody(messages) === null ? await firstTurnUserContext(userContext, systemContext, toolUseContext.options.engineModel, toolUseContext.agentId, messages) : null,
        tools: await Promise.all(toolsOnTheWire(await planToolPayloadUnseeded({
          model: toolUseContext.options.engineModel,
          tools: toolUseContext.options.tools,
          messages,
          getToolPermissionContext: async () => toolUseContext.getAppState().toolPermissionContext,
          agents: toolUseContext.options.agentDefinitions.activeAgents,
          hasPendingMcpServers: toolUseContext.getAppState().mcp.clients.some(c => c.type === 'pending'),
          latchKey: String(rosterOwnerFromToolUseContext(toolUseContext)),
          source: 'gauge',
        })).map(tool => toolToAPISchema(tool, {
          getToolPermissionContext: async () => toolUseContext.getAppState().toolPermissionContext,
          tools: toolUseContext.options.tools,
          agents: toolUseContext.options.agentDefinitions.activeAgents,
          allowedAgentTypes: toolUseContext.options.agentDefinitions.allowedAgentTypes,
          model: toolUseContext.options.engineModel,
        }).catch(() => ({ name: tool.name })))),
      }),
      harnessContextPolicy: null,
      ...(pendingOverflow?.rung === 'prune' ? { pressurePrune: true as const } : {}),
    },
    'apply',
  )
  let messagesForQuery = requestPlan.messages
  const prunedTokensFreed = requestPlan.gauge === undefined ? Math.max(0, requestPlan.reductions.pressurePruned?.tokensSaved ?? 0) : 0
  const clearedByDigest = (requestPlan.reductions.pressurePruned?.cleared ?? 0) + requestPlan.reductions.timeBasedCleared
  if (clearedByDigest > 0) {
    const digested = await fireHooks(
      'compaction.after',
      { method: 'digest', trigger: pendingOverflow?.rung === 'prune' ? 'overflow' : 'auto', tokens_before: estimateContextTokens(messages), tokens_after: estimateContextTokens(messagesForQuery) },
      { scope: { sessionId: String(getSessionId()), ...(toolUseContext.agentId !== undefined ? { crewmateId: toolUseContext.agentId } : {}) }, signal: toolUseContext.abortController.signal, toolUseContext },
    )
    for (const row of hookRowsOfResult(digested)) yield emit({ kind: 'attachment', message: createAttachmentMessage(row) })
    if (digested.answer.contexts.length > 0) {
      messagesForQuery = [...messagesForQuery, ...digested.answer.contexts.map(words => createUserMessage({ content: words, isMeta: true }))]
    }
  }
  const thinkingRecords: AttachmentMessage[] = []
  {
    const known = deadThinkingMarks(messages)
    const fresh = (requestPlan.reductions.deadThinkingMarks ?? []).filter(mark => !known.get(mark.messageId)?.has(mark.blockIndex))
    if (fresh.length > 0) {
      const record = createDeadThinkingAttachment(fresh)
      yield emit({ kind: 'attachment', message: record })
      thinkingRecords.push(record)
    }
  }
  if (pendingOverflow?.rung === 'prune') {
    const pruned = requestPlan.reductions.pressurePruned
    yield emit({
      kind: 'notice',
      message: createSystemMessage(
        overflowRecoveryNotice(pendingOverflow.signal, 'prune', pruned ?? { cleared: 0, tokensSaved: 0 }),
        'warning',
      ),
    })
  }

  if (messagesForQuery.length < requestPlan.afterBoundaryCount) {
    emitCompactionTrace('microcompact', {
      messagesBefore: requestPlan.afterBoundaryCount,
      messagesAfter: messagesForQuery.length,
    })
  }

  let fullSystemPrompt = asSystemPrompt(
    appendSystemContext(systemPrompt, systemContext, toolUseContext.options.engineModel),
  )
  return { requestPlan, messagesForQuery, prunedTokensFreed, thinkingRecords, fullSystemPrompt }
}

export async function* foldContext(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext, opened: Pick<FoldedContext, 'tracking' | 'overflowEpisode'>, planned: PlannedContext): AsyncGenerator<RunEvent, FoldedContext | SettledDecision> {
  const { emit, deps, querySource, params } = run
  let { systemPrompt, userContext, systemContext } = run
  const { pendingOverflow } = state
  const { prunedTokensFreed } = planned
  let { messagesForQuery, fullSystemPrompt } = planned
  let { tracking, overflowEpisode } = opened
  const forcedFold = pendingOverflow?.rung === 'fold' ? pendingOverflow.signal : undefined
  const foldSplit = splitCarriedOperatorTail(messagesForQuery)
  const {
    compactionResult,
    consecutiveFailures,
    consecutiveRapidRefills,
    rapidRefillBreakerTripped,
    measuredRawTokenCount,
    refusal: compactionRefusal,
    paused: compactionPaused,
    declined: compactionDeclined,
  } = pendingOverflow?.rung === 'prune' ? { wasCompacted: false } as Awaited<ReturnType<typeof deps.autocompact>> : await deps.autocompact(
    foldSplit.head,
    toolUseContext,
    {
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext,
      forkContextMessages: foldSplit.head,
      postFoldCarry: foldSplit.carry,
    },
    querySource,
    tracking,
    prunedTokensFreed,
    forcedFold,
  )

  if (rapidRefillBreakerTripped) {
    yield emit({
      kind: 'notice',
      message: createSystemMessage(
        `${AUTOCOMPACT_THRASH_MESSAGE} ${rapidRefillPauseText({ nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession) })}`,
        'warning',
      ),
    })
  }
  const rapidRefillPaused = tracking?.rapidRefillPaused === true || rapidRefillBreakerTripped === true

  if (forcedFold !== undefined && !compactionResult) {
    if (!toolUseContext.abortController.signal.aborted && (forcedFold.source === 'provider' || (compactionRefusal !== undefined && compactionRefusal !== ERROR_MESSAGE_USER_ABORT))) {
      const saving = projectTimeBasedMicrocompact(messagesForQuery, querySource, { pressure: true, supersededOnly: true })?.tokensSaved ?? 0
      const fallback = decideOverflowRecovery({ episode: overflowEpisode, gapTokens: overflowGapFor(forcedFold), pruneSavingTokens: saving, pruneAllowed: true, fold: { available: false, why: 'fold-failed' } })
      if (fallback.kind === 'recover' && fallback.rung === 'prune') {
        const next: NextTurn = {
          ...state, messages: messagesForQuery, toolUseContext, autoCompactTracking: tracking,
          overflowEpisode: { folded: true, pruned: true },
          pendingOverflow: { signal: forcedFold, rung: 'prune' },
          transition: { reason: 'overflow_recovery', rung: 'prune', source: forcedFold.source },
        }
        return { kind: 'hand_over', next }
      }
    }
    yield emit({
      kind: 'notice',
      message: createAssistantAPIErrorMessage({
        content: overflowRefusalText(forcedFold, 'fold-failed', {
          nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession),
          ...(compactionRefusal !== undefined ? { detail: compactionRefusal } : {}),
        }),
        error: 'invalid_request',
        ...(forcedFold.detail !== undefined ? { errorDetails: forcedFold.detail } : {}),
        overflow: forcedFold,
      }),
    })
    const terminal: Terminal =
      forcedFold.source === 'estimate' ? { reason: 'blocking_limit' } : { reason: 'prompt_too_long' }
    return { kind: 'end', terminal }
  }

  if (forcedFold === undefined && (compactionPaused === true || compactionDeclined === true) && compactionRefusal !== undefined) {
    yield emit({ kind: 'notice', message: createSystemMessage(compactionRefusal, 'warning') })
  }

  if (compactionResult) {
    const {
      preCompactTokenCount,
      postCompactTokenCount,
      truePostCompactTokenCount,
    } = compactionResult

    const postForTrace = truePostCompactTokenCount ?? postCompactTokenCount
    emitCompactionTrace('auto-compact', {
      tokensFreed:
        typeof preCompactTokenCount === 'number' &&
        typeof postForTrace === 'number'
          ? preCompactTokenCount - postForTrace
          : undefined,
    })

    tracking = {
      compacted: true,
      turnId: deps.uuid(),
      turnCounter: 0,
      consecutiveFailures: 0,
      consecutiveRapidRefills,
      ...(rapidRefillPaused ? { rapidRefillPaused: true as const } : {}),
    }

    const postCompactMessages = buildPostCompactMessages(compactionResult)

    const carried = foldSplit.carry.map(row => ({ ...row, uuid: randomUUID() as UUID }))
    yield emit({
      kind: 'compaction_boundary',
      trigger: forcedFold !== undefined ? 'overflow' : 'auto',
      messages: [...postCompactMessages, ...carried],
    })
    resetSessionEnvNoticeOnCompaction()

    messagesForQuery = [...postCompactMessages, ...carried]
    overflowEpisode = { pruned: overflowEpisode.pruned, folded: true }
    if (params.recompose !== undefined) {
      const composed = await params.recompose()
      systemPrompt = composed.systemPrompt
      userContext = composed.userContext
      systemContext = composed.systemContext
      run.systemPrompt = systemPrompt
      run.userContext = userContext
      run.systemContext = systemContext
      const recomposed = asSystemPrompt(appendSystemContext(systemPrompt, systemContext, toolUseContext.options.engineModel))
      if (recomposed.join('\u001e') !== fullSystemPrompt.join('\u001e')) logForDebugging('compaction: the system prompt was composed again after the fold, so the request that re-writes the context carries the new composition and the next turn reads it back')
      fullSystemPrompt = recomposed
    }
  } else if (consecutiveFailures !== undefined || rapidRefillPaused) {
    tracking = {
      ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
      ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
      ...(rapidRefillPaused ? { rapidRefillPaused: true as const } : {}),
    }
  }
  return { kind: 'go_on', messagesForQuery, tracking, overflowEpisode, fullSystemPrompt, compactionResult, consecutiveFailures, measuredRawTokenCount, compactionRefusal, foldSplit }
}

export async function* holdBlockingLimit(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext, planned: PlannedContext, folded: FoldedContext): AsyncGenerator<RunEvent, FittingRequest | SettledDecision> {
  const { emit, querySource } = run
  const { autoCompactTracking, maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, stopHookActive, turnCount } = state
  const { prunedTokensFreed } = planned
  const { messagesForQuery, tracking, overflowEpisode, fullSystemPrompt, compactionResult, consecutiveFailures, measuredRawTokenCount, compactionRefusal, foldSplit } = folded
  toolUseContext = {
    ...toolUseContext,
    messages: messagesForQuery,
  }

  const appState = toolUseContext.getAppState()
  const currentModel = toolUseContext.options.engineModel
  const justCompactedUnderLimit =
    compactionResult !== undefined &&
    (compactionResult.truePostCompactTokenCount === undefined ||
      calculateTokenWarningState(
        compactionResult.truePostCompactTokenCount,
        toolUseContext.options.engineModel,
      ).level !== 'blocked')
  if (
    !justCompactedUnderLimit &&
    querySource !== 'compact' &&
    querySource !== 'session_memory'
  ) {
    const estimatedTokens =
      compactionResult?.truePostCompactTokenCount ??
      Math.max(
        0,
        (measuredRawTokenCount ?? tokenCountWithEstimation(messagesForQuery, toolUseContext.options.engineModel)) -
          prunedTokensFreed,
      )
    const { level } = calculateTokenWarningState(
      estimatedTokens,
      toolUseContext.options.engineModel,
    )
    const localFits = level === 'blocked' && localPromptFits(currentModel, { messages: messagesForQuery, systemPrompt: fullSystemPrompt, tools: toolUseContext.options.tools })
    if (localFits) logForDebugging(`blocking preempt: the composed request fits ${currentModel}'s planned window — sent`)
    if (level === 'blocked' && !localFits) {
      const localUnfit = localPromptFitRefusal(currentModel, { messages: messagesForQuery, systemPrompt: fullSystemPrompt, tools: toolUseContext.options.tools })
      if (localUnfit !== undefined) {
        yield emit({
          kind: 'notice',
          message: createAssistantAPIErrorMessage({
            content: `${API_ERROR_MESSAGE_PREFIX}: ${localUnfit}`,
            error: 'invalid_request',
          }),
        })
        const terminal: Terminal = { reason: 'blocking_limit' }
        return { kind: 'end', terminal }
      }
      if (overflowLadderArmed(querySource)) {
        const blockingLimit = getBlockingLimit(toolUseContext.options.engineModel)
        const signal = estimateOverflowSignal({
          family: declaredRouteOf(currentModel) ?? 'unknown',
          actualTokens: estimatedTokens,
          limitTokens: blockingLimit,
        })
        const pruneSaving =
          projectTimeBasedMicrocompact(messagesForQuery, querySource, { pressure: true, supersededOnly: true })?.tokensSaved ?? 0
        const headFoldFailed =
          (consecutiveFailures ?? 0) > (autoCompactTracking?.consecutiveFailures ?? 0)
        const decision = decideOverflowRecovery({
          episode: overflowEpisode,
          gapTokens: Math.max(1, estimatedTokens - blockingLimit),
          pruneSavingTokens: pruneSaving,
          pruneAllowed: compactionRefusal !== undefined && compactionRefusal !== ERROR_MESSAGE_USER_ABORT,
          fold: foldAvailability({
            tracking,
            headFold: !foldSplit.hasHistory ? undefined : headFoldFailed ? 'failed' : isAutoCompactEnabled() ? 'did-not-land' : undefined,
            ...(headFoldFailed && compactionRefusal !== undefined ? { headFoldDetail: compactionRefusal } : {}),
            hasHistory: foldSplit.hasHistory,
          }),
        })
        if (decision.kind === 'recover') {
          if (decision.rung === 'fold') {
            yield emit({ kind: 'notice', message: createSystemMessage(overflowRecoveryNotice(signal, 'fold'), 'warning') })
          }
          const next: NextTurn = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            stopHookActive,
            turnCount,
            overflowEpisode: {
              pruned: overflowEpisode.pruned || decision.rung === 'prune',
              folded: overflowEpisode.folded || decision.rung === 'fold',
            },
            pendingOverflow: { signal, rung: decision.rung },
            transition: { reason: 'overflow_recovery', rung: decision.rung, source: 'estimate' },
          }
          return { kind: 'hand_over', next }
        }
        const why = decision.kind === 'refuse' ? decision.why : 'fold-failed'
        yield emit({
          kind: 'notice',
          message: createAssistantAPIErrorMessage({
            content: overflowRefusalText(signal, why, {
              nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession),
              ...(decision.kind === 'refuse' && decision.detail !== undefined ? { detail: decision.detail } : {}),
            }),
            error: 'invalid_request',
            overflow: signal,
          }),
        })
        const terminal: Terminal = why === 'breaker' && tracking?.rapidRefillPaused === true ? { reason: 'rapid_refill_breaker' } : { reason: 'blocking_limit' }
        return { kind: 'end', terminal }
      }
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        }),
      })
      const terminal: Terminal = { reason: 'blocking_limit' }
      return { kind: 'end', terminal }
    }
  }
  return { kind: 'go_on', toolUseContext, appState, currentModel }
}

export async function* makeRequest(run: RunCtx, state: TurnState, ordinal: number): AsyncGenerator<RunEvent, RequestDecision> {
  const { emit, deps, budgetGuard, awaitingReply } = run
  const { canUseTool, maxTurns } = run.params
  let { toolUseContext } = state
  const { autoCompactTracking, maxOutputTokensOverride, turnCount } = state
  const closingTurn = maxTurns !== undefined && budgetGuard.maxTurnsExceeded(turnCount, maxTurns)

  const turnId = `t${ordinal}`
  yield emit({ kind: 'turn_started', turnId, n: ordinal })

  if (!toolUseContext.agentId) {
    headlessProfilerCheckpoint('query_started')
  }

  const callChain = advanceToolCallChain(toolUseContext, () => deps.uuid())

  toolUseContext = {
    ...toolUseContext,
    callChain,
  }

  const planned = yield* planContext(run, state, toolUseContext)
  const folded = yield* foldContext(run, state, toolUseContext, { tracking: autoCompactTracking, overflowEpisode: state.overflowEpisode }, planned)
  if (folded.kind !== 'go_on') return folded
  const fitting = yield* holdBlockingLimit(run, state, toolUseContext, planned, folded)
  if (fitting.kind !== 'go_on') return fitting

  const iter: IterationState = {
    state,
    turnId,
    requestPlan: planned.requestPlan,
    messagesForQuery: folded.messagesForQuery,
    toolUseContext: fitting.toolUseContext,
    callChain,
    tracking: folded.tracking,
    fullSystemPrompt: folded.fullSystemPrompt,
    appState: fitting.appState,
    currentModel: fitting.currentModel,
    maxOutputTokensOverride,
    assistantMessages: [],
    toolResults: [],
    thinkingRecords: planned.thinkingRecords,
    toolUseBlocks: [],
    needsFollowUp: false,
    closingTurn,
    callOrdinal: 0,
    replyTo: awaitingReply,
    early: new EarlyStarts(fitting.toolUseContext, canUseTool),
    overflowEpisode: folded.overflowEpisode,
    allRefusedToolCalls: [],
    refusedToolCalls: [],
    answeredRefusalIds: new Set(),
    shouldPreventContinuation: false,
    loopStoppedCycle: null,
    loopStoppedRecord: null,
    updatedToolUseContext: fitting.toolUseContext,
  }
  return { kind: 'go_on', iter }
}
