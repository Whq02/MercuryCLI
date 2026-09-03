// ============================================================================
//  run-core/turn-machine.ts — T8: the TurnMachine.
//
//  The run-event core: ONE owned turn state machine that emits the typed
//  RunEvent stream (run-core/events.ts) for everything a model-turn run
//  does — turn opening, compaction boundaries, model calls, stream
//  settlement, withholding, tool lifecycle, hook gates, steering drain,
//  typed transitions, terminal outcome. query()'s legacy generator shape
//  is a TOTAL projection over this stream (project-legacy.ts); the
//  140-check runloop contract passes unchanged across the swap.
//
//  Owners this machine composes (each rule stated once, in its owner):
//  • BudgetGuard (budget-guard.ts) — task-budget carryover · maxTurns.
//  • ModelLane (model-lane.ts) — backfill clone-on-yield · withholding ·
//    the retry-reset recipe.
//  • AttachmentDrain (attachment-drain.ts) — steering scope · slash
//    exclusion · queued-deepthink · exactly-once consumption.
//  • HookGate — runStopHookGate below wraps query/stopHooks.ts behind a
//    typed outcome while streaming its messages through as hook_message
//    events (never buffered — hook progress must render live).
//
//  Folded-out lanes DELETED with this restructure (they were `const … =
//  null` scaffolding in the old query.ts body; the contract pins their
//  absence as current truth): reactiveCompact (PTL/media recovery —
//  terminal `prompt_too_long` is unreachable; a real 413 lands on the
//  API-error return, L16), contextCollapse, skillPrefetch, jobClassifier,
//  snipCompact, taskSummary. The reactive-compact retry-guard state field
//  and the `budgetTracker` null died with them — `Continue`/`Terminal`
//  keep the wider vocabulary deliberately (query/transitions.ts documents
//  it).
//
//  FIXED DELIBERATELY AT THE CUT (the T7 header-join precedent; L6b pins
//  it): the old body never reset `streamingFallbackOccured`, so with two
//  or more post-fallback assistants every one with a successor message was
//  re-tombstoned — valid fallback output erased from UI and transcript
//  (probe: 'fresh block one' tombstoned). The retraction now fires once.
// ============================================================================
import type { ToolResultBlockParam, ToolUseBlock } from '../types/wire.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import {
  AUTOCOMPACT_THRASH_MESSAGE,
  calculateTokenWarningState,
  getBlockingLimit,
  type AutoCompactTrackingState,
} from '../services/compact/autoCompact.js'
import { buildPostCompactMessages } from '../services/compact/compact.js'
import { projectTimeBasedMicrocompact } from '../services/compact/microCompact.js'
import {
  classifyThinkingDrops,
  describeThinkingDrops,
  inputTransformationsOf,
  modelSwitchReceipt,
  prefixMarkOf,
  recordThinkingDropLedger,
} from '../services/providers/anthropic/thinkingBinding.js'
import { logForDebugging } from '../utils/debug.js'

/** Model switches already receipted (owner + the current model's family):
 *  the previous model's thinking leaves the requests quietly, once. */
const switchReceipts = new Set<string>()

/** Response ids whose preserved-thinking drop list was already classified —
 *  the streaming path mints one assistant envelope per content block and
 *  each carries the same list. Bounded: the oldest id leaves past 64. */
const responsesClassified = new Set<string>()
const RESPONSES_CLASSIFIED_CAP = 64
function rememberClassifiedResponse(id: string): void {
  responsesClassified.add(id)
  while (responsesClassified.size > RESPONSES_CLASSIFIED_CAP) {
    const oldest = responsesClassified.values().next().value
    if (oldest === undefined) break
    responsesClassified.delete(oldest)
  }
}
import {
  FRESH_OVERFLOW_EPISODE,
  decideOverflowRecovery,
  foldAvailability,
  overflowGapFor,
  overflowLadderArmed,
  overflowRecoveryNotice,
  overflowRefusalText,
  splitCarriedOperatorTail,
  type OverflowEpisode,
  type OverflowRung,
} from '../services/compact/overflowRecovery.js'
import {
  estimateOverflowSignal,
  overflowSignalOf,
  type OverflowSignal,
} from '../services/api/overflowSignal.js'
import { ImageSizeError } from '../utils/imageValidation.js'
import { ImageResizeError } from '../utils/imageResizer.js'
import { describeInvalidArgTypeError } from '../utils/errors.js'
import { findToolByName, type ToolUseContext } from '../Tool.js'
import {
  applyTurnTierEffort,
  applyTurnTierModel,
} from '../utils/autopilot/tierState.js'
import {
  isTurnOwningQuerySource,
  resolveEffortTruth,
} from '../utils/effort.js'
import { asSystemPrompt, type SystemPrompt } from '../utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ToolUseSummaryMessage,
  UserMessage,
} from '../types/message.js'
import { logError } from '../utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  STREAM_FAULT_RECOVERY_NUDGE,
  isContinuableStreamFaultMessage,
} from '../services/api/errors.js'
import {
  collectRefusedToolCalls,
  toolCallRefusalCorrection,
} from '../services/providers/toolCallGate.js'
import { logAntError } from '../utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  createToolUseSummaryMessage,
} from '../utils/messages.js'
import { generateToolUseSummary } from '../services/toolUseSummary/toolUseSummaryGenerator.js'
import {
  buildRewindRecordIfSettled,
  createSettleGuardWarning,
  findActiveCheckpoint,
} from '../services/compact/checkpointRewind.js'
import { prependUserContext, appendSystemContext } from '../utils/api.js'
import { latestUserContextBody } from '../utils/attachments/userContext.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from '../utils/attachments.js'
import {
  remove as removeFromQueue,
  getDrainableCommands,
  markDraining,
  isSlashCommand,
} from '../utils/messageQueueManager.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from '../utils/headlessProfiler.js'
import {
  getPublicModelDisplayName,
  getRuntimeMainLoopModel,
  renderModelName,
} from '../utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from '../utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from '../utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import {
  BRIEF_TOOL_NAME,
  LEGACY_BRIEF_TOOL_NAME,
} from '../tools/BriefTool/prompt.js'
import { executePostSamplingHooks } from '../utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from '../utils/hooks.js'
import type { QuerySource } from '../constants/querySource.js'
import { createDumpPromptsFetch } from '../services/api/dumpPrompts.js'
import {
  getActivePulseTrace,
  isPulseMainSource,
  notePulseModel,
  pulseMark,
  pulseStageEnd,
  pulseStageStart,
  setPulsePhase,
} from '../utils/pulse/index.js'
import { runTools } from '../services/tools/toolOrchestration.js'
import {
  repetitionStopNotice,
  takeRepetitionStop,
} from '../services/tools/identicalFailureGuard.js'
import { emitCompactionTrace } from '../utils/observability/invocationTrace.js'
import { recordContentReplacement } from '../utils/sessionStorage.js'
import { handleStopHooks } from '../query/stopHooks.js'
import { buildRequestContextPlan, reconcileAppliedPlanUsage } from '../services/run/requestContextPlan.js'
import { calibrationKeyFor } from '../services/run/contextCalibration.js'
import { harnessContextPolicyRequest } from '../services/mission/harnessApplication.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { ownerFromToolUseContext } from '../services/run/resolveOwner.js'
import { evaluateCycleLease, renderHandoffReport } from '../services/run/cycleLease.js'
import { getRunSnapshot, noteRunEvent } from '../services/run/runCoordinator.js'
import { buildQueryConfig, type QueryConfig } from '../query/config.js'
import { productionDeps, type QueryDeps } from '../query/deps.js'
import type { Terminal, Continue } from '../query/transitions.js'
import { BudgetGuard } from './budget-guard.js'
import {
  backfillCloneForYield,
  isWithheldMaxOutputTokens,
  resetForRetry,
} from './model-lane.js'
import {
  consumeDrainedCommands,
  selectDrainableCommands,
} from './attachment-drain.js'
import { buildModelCallReference } from './call-reference.js'
import { createEventMint, type RunEvent } from './events.js'
import { acquireModelPermit, releaseModelPermitByCall } from '../services/capacity/governor.js'
import { refreshGovernorCeilings } from '../services/capacity/composeCeilings.js'
import { count } from '../utils/array.js'

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/** Stamps events with the run's monotonic seq — one mint per run. */
type EventMint = ReturnType<typeof createEventMint>

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget (output_config.task_budget, beta task-budgets-2026-03-13).
  // Distinct from the tokenBudget +500k auto-continue feature. `total` is the
  // budget for the whole agentic turn; `remaining` is computed per iteration
  // from cumulative API usage. See configureTaskBudgetParams in claude.ts.
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// ── cross-iteration state ────────────────────────────────────────────────────

// Mutable state carried between loop iterations, written whole at each
// continue site. `transition` records WHY the previous iteration continued
// (query/transitions.ts) — also emitted first-class as `turn_settled`.
type TurnState = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
  /** Bounded continuations after a provider stream faulted post-partial-
   *  content (the continuable class) — at most ONE per run. */
  streamFaultRecoveryCount: number
  /** Consecutive continuations after a turn whose EVERY tool call the
   *  transport gate refused (no tool ran, nothing to pair) — the model gets
   *  the typed correction at most TOOL_CALL_REFUSAL_RECOVERY_LIMIT times in
   *  a row; a turn that runs a tool resets the count. */
  toolCallRefusalRecoveryCount: number
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
  /** this turn already spent its ONE injected cycle-replan
   *  directive — the next stagnant cycle settles instead of re-prompting. */
  cycleReplanInjected?: boolean
  /** The overflow ladder's episode ledger: which rungs this episode has
   *  spent (a completed tool round opens a fresh one — the stream-fault
   *  precedent; the rapid-refill breaker still bounds a fold-refill loop). */
  overflowEpisode: OverflowEpisode
  /** A rung the ladder chose at the tail of the previous iteration, for
   *  the loop head to perform: 'prune' rides the request plan (the
   *  pressure clearing walk), 'fold' rides the compaction gate (the forced
   *  fold on the same session, the operator tail carried verbatim). */
  pendingOverflow: { signal: OverflowSignal; rung: OverflowRung } | undefined
}

// ── the run context (immutable, what the model lane consumes) ───────────────

type RunCtx = {
  params: QueryParams
  userContext: { [k: string]: string }
  fallbackModel: string | undefined
  querySource: QuerySource
  skipCacheWrite: boolean | undefined
  deps: QueryDeps
  config: QueryConfig
  budgetGuard: BudgetGuard
}

// ── per-iteration state (one model-request cycle) ───────────────────────────

type IterationState = {
  turnId: string
  ordinal: number
  messagesForQuery: Message[]
  toolUseContext: ToolUseContext
  queryTracking: { chainId: string; depth: number }
  chainIdForAnalytics: string
  tracking: AutoCompactTrackingState | undefined
  fullSystemPrompt: SystemPrompt
  appState: ReturnType<ToolUseContext['getAppState']>
  dumpPromptsFetch: ReturnType<typeof createDumpPromptsFetch> | undefined
  currentModel: string
  maxOutputTokensOverride: number | undefined
  assistantMessages: AssistantMessage[]
  toolResults: (UserMessage | AttachmentMessage)[]
  toolUseBlocks: ToolUseBlock[]
  needsFollowUp: boolean
  callOrdinal: number
}

// ── synthetic pairing (the exactly-once settlement law's synthetic arm) ─────

/** Every announced tool_use gets a settlement even when the run dies before
 *  its tool ran — a tool_use without a tool_result 400s the next API call.
 *  Emits a synthetic `tool_settled` per orphaned tool_use. */
function* emitSyntheticSettlements(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
  outcome: 'error' | 'aborted',
  emit: EventMint,
): Generator<RunEvent> {
  for (const assistantMessage of assistantMessages) {
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    for (const toolUse of toolUseBlocks) {
      yield emit({
        kind: 'tool_settled',
        toolUseId: toolUse.id,
        outcome,
        synthetic: true,
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: errorMessage,
              is_error: true,
              tool_use_id: toolUse.id,
            },
          ],
          toolUseResult: errorMessage,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      })
    }
  }
}

// ── the hook gate ────────────────────────────────────────────────────────────

type StopHookGateResult = {
  preventContinuation: boolean
  blockingErrors: Message[]
}

/** Runs query/stopHooks.ts behind a typed outcome. Every message the hook
 *  pass yields (progress, brief-sentinel nags, the abort-during-hooks
 *  interruption) streams through AS IT HAPPENS as `hook_message` — buffering
 *  until the gate settles would hide hook progress from live surfaces. The
 *  gate outcome lands as one `hook_gate` fact after the pass. */
async function* runStopHookGate(
  gen: ReturnType<typeof handleStopHooks>,
  emit: EventMint,
): AsyncGenerator<RunEvent, StopHookGateResult> {
  let result: StopHookGateResult
  try {
    while (true) {
      const r = await gen.next()
      if (r.done) {
        result = r.value
        break
      }
      yield emit({ kind: 'hook_message', message: r.value })
    }
  } finally {
    // Teardown parity with the old `yield*` delegation: closing this
    // generator mid-pass closes the hook generator too (no-op once done).
    await gen.return(undefined as never)
  }
  yield emit({
    kind: 'hook_gate',
    gate: 'stop',
    outcome: result.preventContinuation
      ? 'prevented'
      : result.blockingErrors.length > 0
        ? 'blocking'
        : 'passed',
    messages: result.blockingErrors,
  })
  return result
}

// ── pure decisions ───────────────────────────────────────────────────────────

type MaxOutputTokensDecision =
  | { kind: 'escalate' }
  | { kind: 'nudge'; attempt: number }
  | { kind: 'surface' }

const STREAM_FAULT_RECOVERY_LIMIT = 1

/** A model that cannot shape a valid call in three consecutive tries ends
 *  the turn with the refusal notes visible rather than billing a fourth. */
const TOOL_CALL_REFUSAL_RECOVERY_LIMIT = 3

type StreamFaultDecision = { kind: 'continue'; attempt: number } | { kind: 'surface' }

/** The refused-tool-call recovery, as one pure decision: a turn whose every
 *  tool call the transport gate refused (services/providers/toolCallGate.ts)
 *  settled NO tool_use block, so nothing pairs and the loop would end with
 *  the model never told — the typed correction is injected as the next user
 *  turn instead, bounded so a model that keeps misshaping its calls cannot
 *  spin. */
export function decideToolCallRefusalRecovery(input: {
  refusals: number
  recoveryCount: number
}): StreamFaultDecision {
  if (input.refusals > 0 && input.recoveryCount < TOOL_CALL_REFUSAL_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

/** The continuable stream-fault recovery, as one pure decision: a provider
 *  stream that faulted AFTER partial content
 *  settled gets ONE bounded continuation nudge — a second fault surfaces
 *  terminally (the API-error death-spiral guard stays the backstop).
 *  Measured basis: 3-in-10 Sol-lane faults across the 2026-07 benchmarks; a
 *  last-turn fault otherwise becomes the whole headless result, and a
 *  mid-task fault kills the run with settled work on disk. */
export function decideStreamFaultRecovery(input: {
  continuableTail: boolean
  recoveryCount: number
}): StreamFaultDecision {
  if (input.continuableTail && input.recoveryCount < STREAM_FAULT_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

/** The max_output_tokens recovery ladder, as one pure decision: escalate
 *  the SAME request once to the 64k cap (remotely gated, 3P default false —
 *  currently folded false, the pinned-unreachable escalate transition),
 *  else inject ≤3 resume nudges, else surface the withheld error. */
function decideMaxOutputTokensRecovery(input: {
  capEnabled: boolean
  envPinned: boolean
  maxOutputTokensOverride: number | undefined
  recoveryCount: number
}): MaxOutputTokensDecision {
  if (
    input.capEnabled &&
    input.maxOutputTokensOverride === undefined &&
    !input.envPinned
  ) {
    return { kind: 'escalate' }
  }
  if (input.recoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    return { kind: 'nudge', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

/** #64 rooms-layer double-reply: a main-thread turn whose ONLY tool uses
 *  are Brief (SendUserMessage) is conversationally TERMINAL — the Brief
 *  message IS the reply (the tool prompt's own doctrine: "when
 *  SendUserMessage carried the reply, end the turn there"). Recursing
 *  re-invokes the model with nothing to do — a second billed /v1/messages
 *  call on EVERY conversational turn, whose "Standing by." filler the
 *  rooms layer then hides. Decided AFTER the tool round, so the Brief
 *  tool_use has its tool_result settled and paired (deciding at stream end
 *  would strand the pair and 400 the next call). An is_error result
 *  (validation/denial) keeps the recursion — the model must see the
 *  failure and retry, or the reply is silently eaten. AskUserQuestion is
 *  deliberately NOT terminal: its result carries the user's answer, which
 *  the model must act on. Same main-thread gates as the post-hoc
 *  brief-stop hook (query/stopHooks.ts), which stays live for prose-only
 *  turns. */
function isBriefTerminalTurn(
  querySource: QuerySource,
  toolUseContext: ToolUseContext,
  toolUseBlocks: ToolUseBlock[],
  toolResults: (UserMessage | AttachmentMessage)[],
): boolean {
  return (
    !toolUseContext.agentId &&
    (querySource.startsWith('repl_main_thread') || querySource === 'sdk') &&
    toolUseBlocks.length > 0 &&
    toolUseBlocks.every(
      // eslint-disable-next-line custom-rules/require-tool-match-name -- matches BOTH the canonical name and its legacy alias
      b => b.name === BRIEF_TOOL_NAME || b.name === LEGACY_BRIEF_TOOL_NAME,
    ) &&
    !toolResults.some(
      m =>
        m.type === 'user' &&
        Array.isArray(m.message.content) &&
        m.message.content.some(
          c => c.type === 'tool_result' && c.is_error === true,
        ),
    )
  )
}

/** Classify one runTools update message into its lifecycle event. The
 *  projection yields the carried message for every branch, so a
 *  misclassification can never drop or reorder a legacy yield. */
function toolUpdateEvent(message: Message, emit: EventMint): RunEvent {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    const toolResult = message.message.content.find(
      c => c.type === 'tool_result',
    )
    if (toolResult) {
      return emit({
        kind: 'tool_settled',
        toolUseId: toolResult.tool_use_id,
        outcome: toolResult.is_error === true ? 'error' : 'ok',
        synthetic: false,
        message,
      })
    }
  }
  if (message.type === 'progress') {
    return emit({
      kind: 'tool_progress',
      toolUseId: message.toolUseID ?? '',
      message,
    })
  }
  if (message.type === 'attachment') {
    return emit({ kind: 'attachment', message })
  }
  return emit({ kind: 'notice', message })
}

// ── the model lane (one stream attempt ladder) ──────────────────────────────

type StreamOutcome =
  | { kind: 'streamed' }
  | { kind: 'terminal'; terminal: Terminal }

/** One model-call ladder: the callModel stream with the provider-fallback
 *  retry loop around it. Emits model_call_started per attempt (a retry is
 *  the SAME event-turn — the projection's stream_request_start marker
 *  counts iterations, not API attempts), stream deltas, assistant
 *  settlements (withholding decided per message), mid-stream fallback
 *  retractions, synthetic pairings + notices on the failure paths. Mutates
 *  iter's batch arrays/needsFollowUp/currentModel in place. */
async function* streamModel(
  run: RunCtx,
  iter: IterationState,
  emit: EventMint,
): AsyncGenerator<RunEvent, StreamOutcome> {
  const { toolUseContext, queryTracking } = iter
  let attemptWithFallback = true

  // fence: only the operator's own model calls narrate the trace/phase
  // (subagents + service queries stream through here concurrently).
  const pulseMain = isPulseMainSource(run.querySource, toolUseContext.agentId)
  if (pulseMain) pulseMark('api_loop_start')
  try {
    while (attemptWithFallback) {
      attemptWithFallback = false
      const callId = `${iter.turnId}.c${++iter.callOrdinal}`
      // the provider-boundary backstop: acquire the
      // model permit BEFORE the model_call_started emit. UI/supervisor-only
      // capacity checks are bypassable by reconnect, retry, or private
      // limiters; this seam is not. A fallback retry mints a new callId
      // (fresh acquire); a same-key re-entry revalidates idempotently.
      // The permit KEY is chainId-scoped: callId is only unique WITHIN a
      // run, and two concurrent runs colliding on `t1.c1` would share one
      // permit (the first backstop prover run caught exactly that). The
      // release lives in the attempt's finally below — covering the whole
      // stream consumption, the fallback continue, and the throw.
      const permitKey = `${iter.queryTracking.chainId}:${callId}`
      // Compose the LIVE ceilings before every acquire — role
      // two-seat law + machine headroom + the active profile's delegation
      // band. Memoized on the composed value; model switches and mid-session
      // engages recompose here for free (gates re-read live). The ATTEMPT's
      // model (fallback-aware — what model_call_started emits) drives the
      // profile term, not the appState base (sanity-fork #1 finding 2).
      refreshGovernorCeilings(iter.currentModel, iter.appState.effortValue)
      const permit = await acquireModelPermit({
        lane:
          toolUseContext.agentId !== undefined
            ? 'background-session'
            : isTurnOwningQuerySource(run.querySource)
              ? 'foreground'
              : 'service',
        callId: permitKey,
      })
      yield emit({
        kind: 'model_permit',
        callId,
        lane: permit.lane,
        waitedMs: permit.waitedMs,
        reacquired: permit.reacquired,
      })
      // AUTOPILOT: a turn-scoped SetTier effort override replaces the BASE
      // appState value for turn-owning loops only — service sources
      // (compact/classifiers) share the main agent key and are excluded.
      // MERCURY_EFFORT_LEVEL supremacy is inside resolveAppliedEffort,
      // so the precedence chain is unchanged.
      const effortValue = isTurnOwningQuerySource(run.querySource)
        ? applyTurnTierEffort(toolUseContext.agentId, iter.appState.effortValue)
        : iter.appState.effortValue
      // model_call_started.effort carries the REQUESTED intent (the floored
      // appState input, pre-resolution) — the applied/wire truth is the
      // resolution owner's job (the byline stamp below; telemetry logs the
      // wire value at the request seam). Documented per H5.
      // The frozen reference captures THIS attempt's capability envelope +
      // finalized tool plan from the same options.tools the call
      // below consumes — reference truth ≡ call truth by construction. The
      // SAME object rides the callModel options so the lane's cache-break
      // receipt correlates to this exact step.
      const callReference = buildModelCallReference({
        model: iter.currentModel,
        effort: effortValue,
        maxOutputTokensOverride: iter.maxOutputTokensOverride,
        tools: toolUseContext.options.tools,
      })
      yield emit({
        kind: 'model_call_started',
        callId,
        model: iter.currentModel,
        effort: effortValue,
        maxOutputTokensOverride: iter.maxOutputTokensOverride,
        reference: callReference,
      })
      // DISPATCHING begins at the real model-call assembly —
      // "requesting" no longer means "query() was entered". The actual
      // selected model + applied effort ride the phase detail (the byline's
      // "Waiting for <model> · <effort>" truth source).
      if (pulseMain) {
        // The byline claims the APPLIED effort — the resolution owner's
        // truthful LABEL (env override · model caps step-down · model
        // default · out-of-ladder provider tiers · the honest 'default'
        // when a gpt/glm wire omits the key), never the raw appState value:
        // a GPT session at /effort max would otherwise show "thinking · max" in the
        // byline while the statusbar chip said 'high' (defect-hunt follow-up,
        // widened the stamp to the label channel).
        const truth = resolveEffortTruth(iter.currentModel, effortValue)
        const effortLabel = truth.wire === undefined ? undefined : truth.label
        notePulseModel(iter.currentModel, effortLabel)
        setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'dispatching', {
          // The byline renders detail.model verbatim ("Waiting for Fable 5")
          // — the public display name when known, the raw id otherwise.
          model:
            getPublicModelDisplayName(iter.currentModel) ?? iter.currentModel,
          effort: effortLabel,
        })
      }
      // A model switch: thinking written by the previous model leaves the
      // requests at the assembler (the API would drop and re-report it on
      // every request); the operator reads one quiet line per switch.
      {
        const receipt = modelSwitchReceipt(
          String(ownerFromToolUseContext(toolUseContext)),
          iter.messagesForQuery,
          iter.currentModel,
        )
        if (receipt !== null && !switchReceipts.has(receipt.key)) {
          switchReceipts.add(receipt.key)
          logForDebugging(`preserved thinking: ${receipt.text}`)
          yield emit({ kind: 'notice', message: createSystemMessage(receipt.text, 'suggestion') })
        }
      }
      try {
        let streamingFallbackOccured = false
        if (pulseMain) pulseMark('model_call_stream_start')
        for await (const message of run.deps.callModel({
          // The user context rides as a PERSISTED user_context row when the
          // conversation carries one (the main thread's attachment producer
          // emits it once, and again at the tail when it changes); the
          // per-request prepend is the fallback for a history without one
          // (agent threads, simple mode) — a prefix rebuilt per request
          // invalidates every later thinking block.
          messages:
            latestUserContextBody(iter.messagesForQuery) === null
              ? prependUserContext(iter.messagesForQuery, run.userContext)
              : iter.messagesForQuery,
          systemPrompt: iter.fullSystemPrompt,
          thinkingConfig: toolUseContext.options.thinkingConfig,
          tools: toolUseContext.options.tools,
          signal: toolUseContext.abortController.signal,
          options: {
            async getToolPermissionContext() {
              const appState = toolUseContext.getAppState()
              return appState.toolPermissionContext
            },
            model: iter.currentModel,
            toolChoice: undefined,
            isNonInteractiveSession:
              toolUseContext.options.isNonInteractiveSession,
            fallbackModel: run.fallbackModel,
            onStreamingFallback: () => {
              streamingFallbackOccured = true
            },
            querySource: run.querySource,
            agents: toolUseContext.options.agentDefinitions.activeAgents,
            allowedAgentTypes:
              toolUseContext.options.agentDefinitions.allowedAgentTypes,
            hasAppendSystemPrompt: !!toolUseContext.options.appendSystemPrompt,
            maxOutputTokensOverride: iter.maxOutputTokensOverride,
            fetchOverride: iter.dumpPromptsFetch,
            mcpTools: iter.appState.mcp.tools,
            hasPendingMcpServers: iter.appState.mcp.clients.some(
              c => c.type === 'pending',
            ),
            callReference,
            queryTracking,
            effortValue,
            advisorModel: iter.appState.advisorModel,
            skipCacheWrite: run.skipCacheWrite,
            agentId: toolUseContext.agentId,
            ownerKey: String(ownerFromToolUseContext(toolUseContext)),
            addNotification: toolUseContext.addNotification,
            ...(run.params.taskBudget && {
              taskBudget: run.budgetGuard.requestBag()!,
            }),
          },
        })) {
          // The first attempt's tool_calls are abandoned wholesale —
          // salvaging them would mean merging assistant messages with
          // different ids and duplicating their tool_results downstream.
          if (streamingFallbackOccured) {
            // The retraction fires ONCE (the flag resets here). The old
            // body latched the flag, so every post-fallback assistant
            // with a successor message got re-tombstoned — valid fallback
            // output erased from UI/transcript (L6b pins the fix).
            streamingFallbackOccured = false
            // Retract orphaned partials so they leave UI and transcript.
            // Their thinking blocks carry invalid signatures that would
            // cause "thinking blocks cannot be modified" API errors.
            for (const msg of iter.assistantMessages) {
              yield emit({ kind: 'assistant_retracted', message: msg })
            }

            // The shared retry-reset recipe (run-core/model-lane.ts):
            // batch dropped so no orphan of the abandoned attempt leaks
            // into the retry.
            iter.needsFollowUp = resetForRetry(iter).needsFollowUp
          }
          // Backfill tool_use inputs on a cloned message before settlement
          // so SDK stream output and transcript serialization see
          // legacy/derived fields. The original `message` is left untouched
          // for assistantMessages.push below — it flows back to the API and
          // mutating it would break prompt caching (byte mismatch).
          const yieldMessage: typeof message = backfillCloneForYield(
            message,
            name => findToolByName(toolUseContext.options.tools, name),
          )
          if (message.type === 'assistant') {
            // Withholding (run-core/model-lane.ts): a recovery-managed
            // error settles withheld:true — pushed to the batch so the
            // recovery ladder finds it, never projected mid-recovery.
            yield emit({
              kind: 'assistant_settled',
              callId,
              message: yieldMessage,
              // An overflow refusal is recovery-managed too: withheld while
              // the ladder is armed for this source, presented only as the
              // ladder's typed refusal if it exhausts.
              withheld:
                isWithheldMaxOutputTokens(message) ||
                (overflowSignalOf(message) !== null && overflowLadderArmed(run.querySource)),
            })
            iter.assistantMessages.push(message)
            // Preserved thinking: every response's drop list is classified
            // ONCE per response id (streaming mints one assistant envelope
            // per block; every envelope carries the same id and list), and
            // every response is recorded, dropped or not, so a drop on
            // consecutive requests reads as Mercury rewriting sent history
            // while a drop after a compaction or a model switch reads as the
            // lawful change it is. A drop is a transcript row for the
            // operator and a ledger entry for the doctor.
            if (!responsesClassified.has(message.message.id)) {
              rememberClassifiedResponse(message.message.id)
              const drops = inputTransformationsOf(message.message)
              const outcome = classifyThinkingDrops(
                String(ownerFromToolUseContext(toolUseContext)),
                drops,
                prefixMarkOf(iter.messagesForQuery, iter.currentModel, {
                  permissionMode: toolUseContext.getAppState().toolPermissionContext.mode,
                }),
              )
              const dropNotice = describeThinkingDrops(drops, outcome)
              if (dropNotice !== null) {
                recordThinkingDropLedger(outcome, iter.currentModel)
                logForDebugging(`preserved thinking: ${JSON.stringify(drops)}`, { level: 'warn' })
                yield emit({ kind: 'notice', message: createSystemMessage(dropNotice, 'warning') })
              }
            }
            // Calibration: reconcile measured usage for the FIRST call of the
            // turn only — the one whose request is the plan's projected
            // view (follow-up calls carry in-turn tool results the plan
            // never saw).
            if (callId === `${iter.turnId}.c1`) {
              const u = (message.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage
              const measured = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
              if (measured > 0) {
                reconcileAppliedPlanUsage(ownerFromToolUseContext(toolUseContext), measured)
              }
            }

            const msgToolUseBlocks = message.message.content.filter(
              content => content.type === 'tool_use',
            ) as ToolUseBlock[]
            if (msgToolUseBlocks.length > 0) {
              iter.toolUseBlocks.push(...msgToolUseBlocks)
              iter.needsFollowUp = true
            }
          } else {
            // first-visible stamps at the WIRE seam (latched — the
            // first stamp wins), so headless turns record them too; the
            // REPL's streaming fan-out owns the PAINT-side stamps.
            if (pulseMain && yieldMessage.type === 'stream_event') {
              const ev = (yieldMessage as { event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string } } }).event
              if (
                ev?.type === 'content_block_start' &&
                (ev.content_block?.type === 'thinking' ||
                  ev.content_block?.type === 'redacted_thinking')
              ) {
                pulseMark('first_thinking_event')
              } else if (
                ev?.type === 'content_block_delta' &&
                ev.delta?.type === 'text_delta'
              ) {
                pulseMark('first_text_delta')
              }
            }
            yield emit({ kind: 'stream_delta', callId, raw: yieldMessage })
          }
        }
        if (pulseMain) pulseMark('model_call_stream_end')
      } catch (innerError) {
        if (innerError instanceof FallbackTriggeredError && run.fallbackModel) {
          // The lane voted fallback: swap models and go again.
          iter.currentModel = run.fallbackModel
          attemptWithFallback = true

          // Settle the abandoned attempt's tool_use pairs before retrying
          yield* emitSyntheticSettlements(
            iter.assistantMessages,
            'Model fallback triggered',
            'error',
            emit,
          )
          // The same retry-reset recipe as the mid-stream fallback above.
          iter.needsFollowUp = resetForRetry(iter).needsFollowUp

          // The tool context follows the model swap.
          toolUseContext.options.mainLoopModel = run.fallbackModel


          // The switch is operator-visible at 'warning' — a model change
          // must never require verbose mode to notice.
          yield emit({
            kind: 'notice',
            message: createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            ),
          })

          continue
        }
        throw innerError
      } finally {
        // The permit releases with the ATTEMPT — normal completion,
        // the fallback continue above (the next attempt acquires its own
        // fresh key), and the throw all pass through here exactly once
        // (release is idempotent by key).
        releaseModelPermitByCall(permitKey)
      }
    }
  } catch (error) {
    logError(error)
    // ERR_INVALID_ARG_TYPE honesty (task #53): this catch is the seam where a
    // runtime throw becomes transcript text — a bare "The "path" argument
    // must be of type string" here is undiagnosable, so that class renders
    // with its named callsite.
    const errorMessage =
      describeInvalidArgTypeError(error) ??
      (error instanceof Error ? error.message : String(error))

    // Image size/resize failures get their plain-language rendering.
    if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: error.message,
        }),
      })
      return { kind: 'terminal', terminal: { reason: 'image_error' } }
    }

    // The stream lane's contract is to YIELD failures as synthetic
    // assistant messages, not throw — so a throw landing here is a bug,
    // and it may have died between announcing a tool_use and settling its
    // tool_result.
    yield* emitSyntheticSettlements(
      iter.assistantMessages,
      errorMessage,
      'error',
      emit,
    )

    // Surface the real error instead of a misleading "[Request interrupted
    // by user]" — this path is a model/runtime failure, not a user action.
    // SDK consumers were seeing phantom interrupts on e.g. Node 18's missing
    // Array.prototype.with(), masking the actual cause.
    yield emit({
      kind: 'notice',
      message: createAssistantAPIErrorMessage({
        content: errorMessage,
      }),
    })

    logAntError('Query error', error)
    return { kind: 'terminal', terminal: { reason: 'model_error', error } }
  }

  return { kind: 'streamed' }
}

// ── the machine ──────────────────────────────────────────────────────────────

export async function* runEventCore(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<RunEvent, Terminal> {
  const emit = createEventMint()
  // Immutable params — never reassigned during the run.
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // The pulse generation this run BELONGS to, captured at entry. The steer
  // receipt must be attributed to the turn that consumed the messages;
  // re-reading the ACTIVE trace at consumption time would let a late drain
  // from an abandoned run stamp its count onto the NEXT turn's receipt
  // (re-audit finding). A stale value here mismatches the phase snapshot's
  // generation and is dropped — never misattributed.
  const owningPulseGeneration = getActivePulseTrace()?.generation ?? -1

  let state: TurnState = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
  }

  // task_budget.remaining tracking across compaction boundaries — see
  // BudgetGuard (run-core/budget-guard.ts) for the carryover rule.
  const budgetGuard = new BudgetGuard(params.taskBudget)

  // Snapshot immutable env/session state once at entry. See QueryConfig for
  // what's included and why feature() gates are intentionally excluded.
  const config = buildQueryConfig()

  const run: RunCtx = {
    params,
    userContext,
    fallbackModel,
    querySource,
    skipCacheWrite,
    deps,
    config,
    budgetGuard,
  }

  yield emit({
    kind: 'run_started',
    querySource,
    agentId: params.toolUseContext.agentId,
  })

  // Fired once per user turn — the prompt is invariant across loop
  // iterations, so per-iteration firing would ask sideQuery the same
  // question N times. Consume point polls settledAt (never blocks). `using`
  // disposes on all generator exit paths — see MemoryPrefetch for
  // dispose/telemetry semantics.
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  let iterationOrdinal = 0

  // The checkpoint settle guard warns ONCE per run (spec 07-C4).
  let checkpointSettleWarned = false

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      maxOutputTokensOverride,
      streamFaultRecoveryCount,
      toolCallRefusalRecoveryCount,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
      pendingOverflow,
    } = state
    let overflowEpisode = state.overflowEpisode

    // ── open the turn ────────────────────────────────────────────────────
    // One event-turn = one model-request cycle. The projection's
    // stream_request_start marker rides THIS event, so it stays exactly
    // once per iteration (recovery retries open new turns; a provider
    // fallback retry does not — quirk 7 of the contract report).
    const ordinal = ++iterationOrdinal
    const turnId = `t${ordinal}`
    yield emit({ kind: 'turn_started', turnId, n: ordinal })

    // fence for this iteration's loop-body marks (see streamModel's).
    const pulseMain = isPulseMainSource(querySource, toolUseContext.agentId)
    if (pulseMain) pulseMark('iteration_started', { n: ordinal })

    // Headless latency checkpoint — main thread only.
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // The query chain: same chainId down the run, depth+1 per iteration.
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const chainIdForAnalytics =
      queryTracking.chainId

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let tracking = autoCompactTracking

    // ── the request-context plan ─────────────────────────────────────────
    // compact-boundary filter → aggregate tool-result
    // budget → microcompact, in ONE shared builder — /context inspects the
    // same transform, so what it shows and what the API receives can never
    // diverge. Apply mode performs the real stateful transition exactly
    // once (records new replacements, fires the time-based side effects,
    // caches the plan digest by owner). Persist only for querySources that
    // read records back on resume: agentId routes to the sidechain file
    // (AgentTool resume) or session file (/resume); ephemeral
    // runForkedAgent callers (agent_summary etc.) don't persist.
    if (pulseMain) {
      pulseStageStart('request_context_plan')
      setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'preparing', {
        reason: 'context',
      })
    }
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    const requestPlan = await buildRequestContextPlan(
      {
        messages,
        owner: ownerFromToolUseContext(toolUseContext),
        querySource,
        contentReplacementState: toolUseContext.contentReplacementState,
        persistReplacements: persistReplacements
          ? records =>
              void recordContentReplacement(
                records,
                toolUseContext.agentId,
              ).catch(logError)
          : undefined,
        skipToolNames: new Set(
          toolUseContext.options.tools
            .filter(t => !Number.isFinite(t.maxResultSizeChars))
            .map(t => t.name),
        ),
        microcompact: deps.microcompact,
        // Delivery truth for the read-dedup ledger: a time-based clear of a
        // Read result must invalidate its readFileState entry (apply mode
        // only — /context inspection has no side effects).
        readFileState: toolUseContext.readFileState,
        // The epoch-keyed calibration key for this turn's model —
        // the plan stays provider-neutral, the route is resolved here.
        calibrationKey: (() => {
          const model = toolUseContext.options.mainLoopModel
          return typeof model === 'string' && model
            ? calibrationKeyFor(declaredRouteOf(model) ?? 'unrecognised', model)
            : null
        })(),
        // The armed harness profile's selection-policy
        // request (off ⇒ null, zero work; the explicit flag outranks it).
        harnessContextPolicy: harnessContextPolicyRequest(
          typeof toolUseContext.options.mainLoopModel === 'string'
            ? toolUseContext.options.mainLoopModel
            : null,
          // The effort fact rides the session's value through the one owner.
          toolUseContext.getAppState?.()?.effortValue,
        ),
        // The overflow ladder's prune rung rides the plan: the pressure
        // clearing walk, persisted through the replacement ledger.
        ...(pendingOverflow?.rung === 'prune' ? { pressurePrune: true as const } : {}),
      },
      'apply',
    )
    let messagesForQuery = requestPlan.messages
    if (pendingOverflow?.rung === 'prune') {
      // The rung's receipt speaks the applied numbers (the projection's
      // estimate at the decision may differ by the budget stage's own
      // replacements — the plan's count is the truth).
      const pruned = requestPlan.reductions.pressurePruned
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          overflowRecoveryNotice(pendingOverflow.signal, 'prune', pruned ?? { cleared: 0, tokensSaved: 0 }),
          'warning',
        ),
      })
    }

    // Observability: record the silent per-turn micro-trim — only when it
    // actually dropped messages from the local array (cached MC edits the
    // server cache, not this array, so it correctly records nothing here).
    // Gated, fire-and-forget, numeric.
    if (messagesForQuery.length < requestPlan.afterBoundaryCount) {
      emitCompactionTrace('microcompact', {
        messagesBefore: requestPlan.afterBoundaryCount,
        messagesAfter: messagesForQuery.length,
      })
    }
    if (pulseMain) pulseStageEnd('request_context_plan')

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    // ── the compaction gate ──────────────────────────────────────────────
    // The overflow ladder's fold rung rides THIS gate (the one compaction
    // owner, the same switches and breakers): the operator's just-sent
    // turn is carried around the fold verbatim, only the history folds.
    const forcedFold = pendingOverflow?.rung === 'fold' ? pendingOverflow.signal : undefined
    const foldSplit =
      forcedFold !== undefined
        ? splitCarriedOperatorTail(messagesForQuery)
        : { head: messagesForQuery, carry: [] as Message[], hasHistory: true }
    if (pulseMain) pulseStageStart('autocompact')
    const {
      compactionResult,
      consecutiveFailures,
      consecutiveRapidRefills,
      rapidRefillBreakerTripped,
      measuredRawTokenCount,
      refusal: forcedFoldRefusal,
    } = await deps.autocompact(
      foldSplit.head,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: foldSplit.head,
      },
      querySource,
      tracking,
      // snipTokensFreed — the snip lane is folded out of this build
      0,
      forcedFold,
    )
    if (pulseMain)
      pulseStageEnd('autocompact', { compacted: Boolean(compactionResult) })

    // Rapid-refill (thrash) circuit breaker. autocompact
    // tripped because the context kept refilling to the limit within a few
    // turns of the previous compact. Surface AUTOCOMPACT_THRASH_MESSAGE and
    // stop the turn rather than thrash the API with doomed compactions.
    if (rapidRefillBreakerTripped) {
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: AUTOCOMPACT_THRASH_MESSAGE,
          error: 'invalid_request',
        }),
      })
      const terminal: Terminal = { reason: 'rapid_refill_breaker' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    // The forced fold did not land (a switch, the breaker, a thrown
    // summary): the ladder is exhausted for this episode — the typed
    // refusal names what happened; the model is never called on a request
    // already known not to fit.
    if (forcedFold !== undefined && !compactionResult) {
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: overflowRefusalText(forcedFold, 'fold-failed', {
            nonInteractive: toolUseContext.options.isNonInteractiveSession === true,
            ...(forcedFoldRefusal !== undefined ? { detail: forcedFoldRefusal } : {}),
          }),
          error: 'invalid_request',
          ...(forcedFold.detail !== undefined ? { errorDetails: forcedFold.detail } : {}),
          overflow: forcedFold,
        }),
      })
      const terminal: Terminal =
        forcedFold.source === 'estimate' ? { reason: 'blocking_limit' } : { reason: 'prompt_too_long' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      // Observability: record the heavy semantic compaction (the
      // model-generated summary). tokensFreed = pre − the TRUE post figure
      // (the resulting context's estimate); postCompactTokenCount is the
      // summarisation call's own billed usage — roughly the PRE count — so
      // subtracting it reported near zero, often negative, on folds that
      // freed most of the window (FN-018 rank 22). Gated, fire-and-forget,
      // numeric.
      const postForTrace = truePostCompactTokenCount ?? postCompactTokenCount
      emitCompactionTrace('auto-compact', {
        tokensFreed:
          typeof preCompactTokenCount === 'number' &&
          typeof postForTrace === 'number'
            ? preCompactTokenCount - postForTrace
            : undefined,
      })


      // task_budget: capture pre-compact final context window before
      // messagesForQuery is replaced with postCompactMessages below.
      // iterations[-1] is the authoritative final window (post server tool
      // loops); see #304930.
      if (params.taskBudget) {
        budgetGuard.applyCompactionCarryover(
          finalContextTokensFromLastResponse(messagesForQuery),
        )
      }

      // Reset on every compact so turnCounter/turnId reflect the MOST
      // RECENT compact. recompactionInfo (autoCompact.ts:190) already
      // captured the old values for turnsSincePreviousCompact/
      // previousCompactTurnId before the call, so this reset doesn't lose
      // those.
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
        // Carry the accumulated rapid-refill count forward
        // so the next iteration's rapidRefillCount() can trip the thrash
        // breaker if the context refills to the threshold again within
        // RAPID_REFILL_TURN_WINDOW.
        consecutiveRapidRefills,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      yield emit({
        kind: 'compaction_boundary',
        trigger: forcedFold !== undefined ? 'overflow' : 'auto',
        messages: postCompactMessages,
      })

      // The current cycle proceeds on the compacted transcript; a carried
      // operator turn re-rides it verbatim, after the fold's own rows. Any
      // fold counts as this episode's fold rung: a provider overflow right
      // after it is a fold-and-retry that still overflows.
      messagesForQuery = [...postCompactMessages, ...foldSplit.carry]
      overflowEpisode = { pruned: overflowEpisode.pruned, folded: true }
    } else if (consecutiveFailures !== undefined) {
      // Autocompact failed — propagate failure count so the circuit breaker
      // can stop retrying on the next iteration.
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    // This per-turn rebuild is the authoritative write of
    // toolUseContext.messages: it runs every iteration after compaction has
    // shaped messagesForQuery, so any earlier seed of toolUseContext.messages
    // (e.g. at call-site set-up) is redundant — tools always read the value
    // set here.
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    // ── model assembly ───────────────────────────────────────────────────
    if (pulseMain) pulseStageStart('model_assembly')
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'strategy' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })
    // AUTOPILOT: a turn-scoped SetTier MODEL override lands here — the same
    // assembly point every downstream consumer (context math, cache clock,
    // callModel) reads, and the while(true) re-entry means a mid-turn
    // switch takes effect on the very next API call. Turn-owning sources
    // only (service loops share the main agent key and must not inherit
    // it); reverted at turn end in query()'s finally via tierTurnEnded.
    if (isTurnOwningQuerySource(querySource)) {
      currentModel = applyTurnTierModel(toolUseContext.agentId, currentModel)
    }

    if (pulseMain) pulseStageEnd('model_assembly')

    // One fetch wrapper per iteration, deliberately: each
    // createDumpPromptsFetch closure captures a request body, so re-minting
    // keeps exactly one body retained instead of the whole run's worth.
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // ── the blocking-limit preempt ───────────────────────────────────────
    // At the hard limit the turn stops BEFORE the call, keeping headroom
    // for a manual /compact. Two exemptions: a just-compacted iteration
    // (already validated under threshold — and the estimator would read
    // stale pre-compact input_tokens off kept messages), and the
    // compact/session_memory forks (they inherit the full conversation and
    // exist precisely to shrink it — blocking them is deadlock). The
    // preempt arms regardless of auto-compact settings in this build — the
    // the skip conjunct rode the folded-out reactiveCompact lane
    // (contract quirk 4).
    // The just-compacted exemption holds only while the fold's own
    // post-compact estimate is under the limit (FN-015 rank 26): a fold
    // that landed over it is not a validated view, and its estimate — not
    // the stale kept-message usage — is the count the preempt reads.
    const justCompactedUnderLimit =
      compactionResult !== undefined &&
      (compactionResult.truePostCompactTokenCount === undefined ||
        calculateTokenWarningState(
          compactionResult.truePostCompactTokenCount,
          toolUseContext.options.mainLoopModel,
        ).level !== 'blocked')
    if (
      !justCompactedUnderLimit &&
      querySource !== 'compact' &&
      querySource !== 'session_memory'
    ) {
      // Single ordered `level` discriminant; 'blocked' ⟺ the old
      // isAtBlockingLimit boolean. The count REUSES the number the
      // auto-compact decision measured over this same view moments ago
      // (carried only on the no-compaction exit, where messagesForQuery is
      // untouched); the walk happens here only when that step never counted
      // (auto-compact off, or a compaction attempt changed the view). An
      // over-limit fold's own estimate leads.
      const estimatedTokens =
        compactionResult?.truePostCompactTokenCount ??
        measuredRawTokenCount ??
        tokenCountWithEstimation(messagesForQuery, toolUseContext.options.mainLoopModel)
      const { level } = calculateTokenWarningState(
        estimatedTokens,
        toolUseContext.options.mainLoopModel,
      )
      if (level === 'blocked') {
        // ── the overflow ladder (the estimate side) ────────────────────
        // The loop head's own auto-compaction IS this side's fold rung and
        // has already run (or was unavailable) this iteration — the estimate
        // never forces a second fold. What remains: the prune rung when the
        // locally-known gap is covered, else the typed refusal naming why
        // the fold could not help (auto-compact off ⇒ /compact by hand).
        if (overflowLadderArmed(querySource)) {
          const blockingLimit = getBlockingLimit(toolUseContext.options.mainLoopModel)
          const signal = estimateOverflowSignal({
            family: declaredRouteOf(currentModel) ?? 'unknown',
            actualTokens: estimatedTokens,
            limitTokens: blockingLimit,
          })
          const pruneSaving =
            projectTimeBasedMicrocompact(messagesForQuery, querySource, { pressure: true })?.tokensSaved ?? 0
          const headFoldFailed =
            (consecutiveFailures ?? 0) > (autoCompactTracking?.consecutiveFailures ?? 0)
          const decision = decideOverflowRecovery({
            episode: overflowEpisode,
            gapTokens: Math.max(1, estimatedTokens - blockingLimit),
            pruneSavingTokens: pruneSaving,
            fold: foldAvailability({
              tracking,
              headFold: headFoldFailed ? 'failed' : 'did-not-land',
              hasHistory: splitCarriedOperatorTail(messagesForQuery).hasHistory,
            }),
          })
          if (decision.kind === 'recover' && decision.rung === 'prune') {
            const next: TurnState = {
              messages: messagesForQuery,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              maxOutputTokensOverride,
              streamFaultRecoveryCount,
              toolCallRefusalRecoveryCount,
              pendingToolUseSummary,
              stopHookActive,
              turnCount,
              overflowEpisode: { pruned: true, folded: overflowEpisode.folded },
              pendingOverflow: { signal, rung: 'prune' },
              transition: { reason: 'overflow_recovery', rung: 'prune', source: 'estimate' },
            }
            yield emit({ kind: 'turn_settled', transition: next.transition! })
            state = next
            continue
          }
          const why = decision.kind === 'refuse' ? decision.why : 'fold-failed'
          yield emit({
            kind: 'notice',
            message: createAssistantAPIErrorMessage({
              content: overflowRefusalText(signal, why, {
                nonInteractive: toolUseContext.options.isNonInteractiveSession === true,
                ...(decision.kind === 'refuse' && decision.detail !== undefined ? { detail: decision.detail } : {}),
              }),
              error: 'invalid_request',
              overflow: signal,
            }),
          })
          const terminal: Terminal = { reason: 'blocking_limit' }
          yield emit({ kind: 'run_terminal', terminal })
          return terminal
        }
        yield emit({
          kind: 'notice',
          message: createAssistantAPIErrorMessage({
            content: PROMPT_TOO_LONG_ERROR_MESSAGE,
            error: 'invalid_request',
          }),
        })
        const terminal: Terminal = { reason: 'blocking_limit' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }
    }

    // ── the model lane ───────────────────────────────────────────────────
    const iter: IterationState = {
      turnId,
      ordinal,
      messagesForQuery,
      toolUseContext,
      queryTracking,
      chainIdForAnalytics,
      tracking,
      fullSystemPrompt,
      appState,
      dumpPromptsFetch,
      currentModel,
      maxOutputTokensOverride,
      assistantMessages: [],
      toolResults: [],
      // stop_reason === 'tool_use' cannot be trusted (not always set);
      // toolUseBlocks fills as blocks arrive during streaming, and
      // needsFollowUp alone decides whether the loop re-enters.
      toolUseBlocks: [],
      needsFollowUp: false,
      callOrdinal: 0,
    }

    const streamOutcome = yield* streamModel(run, iter, emit)
    if (streamOutcome.kind === 'terminal') {
      yield emit({ kind: 'run_terminal', terminal: streamOutcome.terminal })
      return streamOutcome.terminal
    }
    const { assistantMessages, toolResults, toolUseBlocks } = iter
    // Calls the provider transport refused at the wire (the schema gate):
    // no tool_use block exists for them, so the model learns of the refusal
    // only through the correction injected below.
    const refusedToolCalls = collectRefusedToolCalls(assistantMessages)

    // Post-sampling hooks run on the completed model response.
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // ── abort during streaming ───────────────────────────────────────────
    // Handled before anything else: synthesize a tool_result for every
    // announced tool_use so no pair is left unanswered (the API 400s on a
    // tool_use without its tool_result).
    if (toolUseContext.abortController.signal.aborted) {
      yield* emitSyntheticSettlements(
        assistantMessages,
        'Interrupted by user',
        'aborted',
        emit,
      )
      // A submit-interrupt needs no interruption line: the queued user
      // message right behind it says everything.
      const steer =
        toolUseContext.abortController.signal.reason === 'interrupt'
      yield emit({
        kind: 'interruption',
        phase: 'stream',
        steer,
        message: steer ? null : createUserInterruptionMessage({ toolUse: false }),
      })
      const terminal: Terminal = { reason: 'aborted_streaming' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    // The PREVIOUS turn's tool-use summary lands here: its ~1s side call
    // resolved somewhere inside this turn's 5-30s of model streaming.
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield emit({ kind: 'notice', message: summary })
      }
    }

    // ── turn finish / recovery ladder (no follow-up) ─────────────────────
    if (!iter.needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // ── the overflow ladder (provider-reported) ───────────────────────
      // The wire refused the request for not fitting the window — the typed
      // OverflowSignal every family's runtime stamps (services/api/
      // overflowSignal.ts; never a prose sniff here). The error settled
      // withheld; the ladder answers it in-turn: prune when the named gap
      // is covered, else fold the SAME session at the loop head and retry
      // once, else the typed refusal — each rung once per episode. The
      // mid-tool overflow (the follow-up call after a tool round) lands
      // here too: the round is paired, so the fold input is a legal
      // boundary. Service forks keep today's surface (the arm is not armed
      // for them), so the fold's own summary call answers its caller.
      const overflow = overflowSignalOf(lastMessage)
      if (overflow !== null && overflowLadderArmed(querySource)) {
        const foldInput = [
          ...messagesForQuery,
          ...assistantMessages.filter(m => m.isApiErrorMessage !== true),
        ]
        const split = splitCarriedOperatorTail(foldInput)
        const pruneSaving =
          projectTimeBasedMicrocompact(foldInput, querySource, { pressure: true })?.tokensSaved ?? 0
        const decision = decideOverflowRecovery({
          episode: overflowEpisode,
          gapTokens: overflowGapFor(overflow),
          pruneSavingTokens: pruneSaving,
          fold: foldAvailability({ tracking, hasHistory: split.hasHistory }),
        })
        if (decision.kind === 'recover') {
          if (decision.rung === 'fold') {
            yield emit({
              kind: 'notice',
              message: createSystemMessage(overflowRecoveryNotice(overflow, 'fold'), 'warning'),
            })
          }
          const next: TurnState = {
            messages: foldInput,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode: {
              pruned: overflowEpisode.pruned || decision.rung === 'prune',
              folded: overflowEpisode.folded || decision.rung === 'fold',
            },
            pendingOverflow: { signal: overflow, rung: decision.rung },
            transition: { reason: 'overflow_recovery', rung: decision.rung, source: overflow.source },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
        yield emit({
          kind: 'notice',
          message: createAssistantAPIErrorMessage({
            content: overflowRefusalText(overflow, decision.why, {
              nonInteractive: toolUseContext.options.isNonInteractiveSession === true,
              ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
            }),
            error: 'invalid_request',
            ...(overflow.detail !== undefined ? { errorDetails: overflow.detail } : {}),
            overflow,
          }),
        })
        const terminal: Terminal = { reason: 'prompt_too_long' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      // max_output_tokens recovery: the error was withheld from the stream
      // (assistant_settled withheld:true); only surface it if recovery
      // exhausts.
      if (isWithheldMaxOutputTokens(lastMessage)) {
        const decision = decideMaxOutputTokensRecovery({
          // The escalation rung: a cap hit on the 8k default re-runs the
          // SAME request at 64k — no meta message, no multi-turn dance,
          // once per turn (the override check is the guard). A 64k cap hit
          // falls through to the nudge rungs. Default: false.
          capEnabled: getFeatureValue_CACHED_MAY_BE_STALE(
            'mercury_otk_slot_v1',
            false,
          ),
          envPinned: !!process.env.MERCURY_MAX_OUTPUT_TOKENS,
          maxOutputTokensOverride,
          recoveryCount: maxOutputTokensRecoveryCount,
        })

        if (decision.kind === 'escalate') {
          const next: TurnState = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }

        if (decision.kind === 'nudge') {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: TurnState = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            maxOutputTokensOverride: undefined,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: decision.attempt,
            },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }

        // Recovery exhausted — surface the withheld error now.
        yield emit({ kind: 'withheld_surfaced', message: lastMessage })
      }

      // Continuable stream fault (fault AFTER partial content — OpenAI/Z.AI
      // transports compose the typed marker): the turn holds real settled
      // work, so inject ONE bounded continuation instead of ending the run
      // with the error as the session tail (measured 3-in-10 on the Sol
      // benchmark lane). A second fault falls through to the terminal
      // API-error branch below — the death-spiral guard stays the backstop.
      if (lastMessage && isContinuableStreamFaultMessage(lastMessage)) {
        const decision = decideStreamFaultRecovery({
          continuableTail: true,
          recoveryCount: streamFaultRecoveryCount,
        })
        if (decision.kind === 'continue') {
          // the nudge text is OWNED in services/api/errors.ts
          // beside the fault marker — the transcript lookups classify a fault
          // as RECOVERED by finding this exact nudge after it, so composing
          // inline prose here would silently break that presentation.
          // Law 12: the
          // bounded continuation would otherwise be silent — two identical error
          // lines with an invisible retry between them read as a duplicate
          // failure. The notice renders between them.
          yield emit({
            kind: 'notice',
            message: createSystemMessage(
              'Stream dropped after partial content — continuing once from where it stopped.',
              'warning',
            ),
          })
          const recoveryMessage = createUserMessage({
            content: STREAM_FAULT_RECOVERY_NUDGE,
            isMeta: true,
          })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            maxOutputTokensOverride,
            streamFaultRecoveryCount: streamFaultRecoveryCount + 1,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'stream_fault_recovery', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
      }

      // Every tool call of the turn was refused at the transport boundary:
      // nothing minted, nothing paired, and without this band the run would
      // end with the model never told why its action did not happen. Hand
      // it the typed correction as the next user turn (bounded — a model
      // that keeps misshaping its calls ends with the notes visible).
      if (refusedToolCalls.length > 0) {
        const decision = decideToolCallRefusalRecovery({
          refusals: refusedToolCalls.length,
          recoveryCount: toolCallRefusalRecoveryCount,
        })
        if (decision.kind === 'continue') {
          const names = [...new Set(refusedToolCalls.map(r => r.name || 'unnamed'))].join(', ')
          yield emit({
            kind: 'notice',
            message: createSystemMessage(
              `Tool call refused before execution (${names}) — asking the model to correct it (${decision.attempt}/${TOOL_CALL_REFUSAL_RECOVERY_LIMIT}).`,
              'warning',
            ),
          })
          const correction = createUserMessage({
            content: toolCallRefusalCorrection(refusedToolCalls),
            isMeta: true,
          })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, correction],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount: toolCallRefusalRecoveryCount + 1,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'tool_call_refusal_recovery', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
      }

      // No stop hooks on an API-error tail (rate limit, prompt-too-long,
      // auth failure…): there is no real response to judge, and judging
      // the error spirals — error → hook block → retry → error → …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        const terminal: Terminal = { reason: 'completed' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      const stopHookResult = yield* runStopHookGate(
        handleStopHooks(
          messagesForQuery,
          assistantMessages,
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          querySource,
          stopHookActive,
        ),
        emit,
      )

      if (stopHookResult.preventContinuation) {
        const terminal: Terminal = { reason: 'stop_hook_prevented' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: TurnState = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          streamFaultRecoveryCount,
          toolCallRefusalRecoveryCount,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          overflowEpisode,
          pendingOverflow: undefined,
          transition: { reason: 'stop_hook_blocking' },
        }
        yield emit({ kind: 'turn_settled', transition: next.transition! })
        state = next
        continue
      }

      // ── the checkpoint settle guard (spec 07-C4) ─────────────────────
      // A natural end with a live, un-rewound checkpoint gets ONE typed
      // warning and one more turn to Rewind (or explicitly stand by the
      // exploration). Once per run — a wedged run is worse than an
      // unrewound checkpoint (warn-rest).
      if (!checkpointSettleWarned) {
        const liveCheckpoint = findActiveCheckpoint([
          ...messagesForQuery,
          ...assistantMessages,
        ])
        if (liveCheckpoint !== null) {
          checkpointSettleWarned = true
          const warning = createSettleGuardWarning(liveCheckpoint)
          yield emit({ kind: 'attachment', message: warning })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, warning],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'checkpoint_settle_guard' },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
      }

      const terminal: Terminal = { reason: 'completed' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    // ── the tool round ───────────────────────────────────────────────────
    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    if (pulseMain) {
      pulseStageStart('tool_execution', { toolCount: toolUseBlocks.length })
      setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'tool-work', {
        toolCount: toolUseBlocks.length,
      })
    }

    for (const block of toolUseBlocks) {
      yield emit({
        kind: 'tool_started',
        toolUseId: block.id,
        toolName: block.name,
      })
    }

    const toolUpdates = runTools(
      toolUseBlocks,
      assistantMessages,
      canUseTool,
      toolUseContext,
    )

    for await (const update of toolUpdates) {
      if (update.message) {
        yield toolUpdateEvent(update.message, emit)

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    if (pulseMain) pulseStageEnd('tool_execution')

    // Refusals that rode beside executed calls answer in the SAME user turn
    // as the tool results (after them, before any attachment), so the model
    // sees one coherent settlement: what ran, and what was refused and why.
    if (refusedToolCalls.length > 0) {
      const correction = createUserMessage({
        content: toolCallRefusalCorrection(refusedToolCalls),
        isMeta: true,
      })
      yield emit({ kind: 'hook_message', message: correction })
      toolResults.push(correction)
    }

    const briefTerminalTurn = isBriefTerminalTurn(
      querySource,
      toolUseContext,
      toolUseBlocks,
      toolResults,
    )

    // ── the tool-use summary side call ───────────────────────────────────
    // Generated after the tool batch completes — consumed by the NEXT
    // iteration. Skipped for a Brief-terminal turn: there is no next call
    // to consume it, and the generation itself is a billed side call.
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      !briefTerminalTurn &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // subagents don't surface in mobile UI — skip the side call
    ) {
      // The last assistant text rides along as context for the summary.
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // The summary's inputs: each tool use with its settled result.
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // Pair the use with its settlement.
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // Generation runs beside the next API call, never ahead of it.
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // ── abort during tools ───────────────────────────────────────────────
    if (toolUseContext.abortController.signal.aborted) {
      // A submit-interrupt needs no interruption line: the queued user
      // message right behind it says everything.
      const steer =
        toolUseContext.abortController.signal.reason === 'interrupt'
      yield emit({
        kind: 'interruption',
        phase: 'tools',
        steer,
        message: steer ? null : createUserInterruptionMessage({ toolUse: true }),
      })
      // Even an aborted exit reports maxTurns honestly.
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
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    // A hook's preventContinuation ends the run here.
    if (shouldPreventContinuation) {
      const terminal: Terminal = { reason: 'hook_stopped' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    // ── the repetition breaker ───────────────────────────────────────────
    // A streak of identical calls with identical outcomes crossed its stop
    // bound this round (services/tools/identicalFailureGuard.ts): the nudge
    // already rode back as a refused tool_result and the model ran past it.
    // Every tool_use of the round is paired above, so the turn ends here —
    // visibly for the operator, typed for headless consumers — instead of
    // billing another provider call that would repeat the same shape.
    {
      const stop = takeRepetitionStop(toolUseContext.abortController)
      if (stop !== null) {
        const cause = repetitionStopNotice(stop)
        yield emit({
          kind: 'notice',
          message: createSystemMessage(cause, 'warning'),
        })
        yield emit({
          kind: 'attachment',
          message: createAttachmentMessage({
            type: 'repetition_breaker',
            toolName: stop.toolName,
            outcome: stop.outcome,
            streak: stop.streak,
            cause,
          }),
        })
        const terminal: Terminal = { reason: 'repetition_breaker', cause }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }
    }

    // ── checkpoint/rewind: the record append (spec 07-C4) ────────────────
    // A Rewind that settled THIS round mints its record here — the hidden
    // retained-report message, appended BEFORE any turn-end gate so every
    // path (brief-terminal included) carries it. The request projection
    // excludes the abandoned window from the NEXT provider call; the
    // transcript keeps everything (append-only law).
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

    // ── the Brief-terminal gate ──────────────────────────────────────────
    // #64: end the Brief-terminal turn (see isBriefTerminalTurn). Placed
    // BEFORE the queued-command drain below so a mid-turn typed prompt
    // stays queued for the turn driver's between-turns drain (a fresh
    // turn) instead of being consumed into a recursion we're not making. The same stop-hook
    // pass every other turn-end runs keeps its authority here: the post-hoc
    // brief-stop hook sees the Brief call (no nag), and a keep-working hook
    // can still block — that continuation carries the settled toolResults
    // so the tool_use/tool_result pairing stays intact.
    if (briefTerminalTurn) {
      const stopHookResult = yield* runStopHookGate(
        handleStopHooks(
          [...messagesForQuery, ...assistantMessages, ...toolResults],
          [],
          systemPrompt,
          userContext,
          systemContext,
          { ...updatedToolUseContext, queryTracking },
          querySource,
          stopHookActive,
        ),
        emit,
      )

      if (stopHookResult.preventContinuation) {
        const terminal: Terminal = { reason: 'stop_hook_prevented' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: TurnState = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext: { ...updatedToolUseContext, queryTracking },
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          streamFaultRecoveryCount,
          toolCallRefusalRecoveryCount,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          overflowEpisode,
          pendingOverflow: undefined,
          transition: { reason: 'stop_hook_blocking' },
        }
        yield emit({ kind: 'turn_settled', transition: next.transition! })
        state = next
        continue
      }

      const terminal: Terminal = { reason: 'completed' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
    }

    // ── the steering drain ───────────────────────────────────────────────
    // Attachments collect only after the tool round settles: a tool_result
    // interleaved with ordinary user messages is an API error.

    // Queued-command snapshot before processing attachments — sent as
    // attachments so the model can respond within the current turn. The
    // scoping, slash-exclusion and sleep-priority rules live in
    // run-core/attachment-drain.ts (the STEERING laws pin them).
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = selectDrainableCommands(
      // Band semantics live at the queue owner: at a Sleep boundary the
      // later band joins for task-notifications ONLY — a Tab-held prompt
      // keeps its "waits for the next turn" promise whatever the turn does.
      getDrainableCommands(sleepRan),
      { sleepRan, isMainThread, agentId: currentAgentId },
      isSlashCommand,
    )
    // From this moment the snapshot WILL be consumed below; a restage of one
    // of these prompts can never change that, so the queue refuses it
    // rather than letting the UI claim "held" about a message that folds in.
    markDraining(queuedCommandsSnapshot)

    // A queued "deepthink" drains into THIS turn as a queued_commands
    // attachment — the submission-path keyword scan never sees it. The
    // orchestrator's producer scans the drained snapshot itself (passed as
    // the queuedCommands arg below), so the prose nudge fires here too —
    // ALIGNED, no effort change (effort.ts DEEPTHINK block).

    const yieldedCommandUuids = new Set<string>()
    let drainProduced = false
    try {
      for await (const attachment of getAttachmentMessages(
        null,
        updatedToolUseContext,
        null,
        queuedCommandsSnapshot,
        [...messagesForQuery, ...assistantMessages, ...toolResults],
        querySource,
      )) {
        // Recorded BEFORE the yield: a teardown landing at the yield resumes
        // with a Return completion — the lines after it never run — yet the
        // consumer already HAS the row (the yield's deliver half completed).
        const att = attachment.attachment as { type?: string; source_uuid?: string }
        if (att.type === 'queued_command' && typeof att.source_uuid === 'string') {
          yieldedCommandUuids.add(att.source_uuid)
        }
        yield emit({ kind: 'attachment', message: attachment })
        toolResults.push(attachment)
      }
      drainProduced = true
    } finally {
      // The restage refusal exists for the PRODUCTION window only — once the
      // attachments are produced (or the drain aborts mid-flight), the marks
      // must clear, or a prompt surviving an aborted drain stays
      // un-restageable with no notice until the next turn's drain happens to
      // replace the set (closure review: production never released it).
      markDraining([])
      // EXACTLY-ONCE, teardown included: a command whose attachment went OUT
      // is consumed in the same protective band as the mark clear. The old
      // shape consumed several lines below — past a conditional await — so a
      // generator torn down at the yield left words already persisted as an
      // attachment row sitting in the queue, and the next turn re-drained
      // them: one submit, two deliveries. A command whose attachment never
      // yielded stays queued on teardown (nothing was delivered — it rides
      // to the next boundary); the completed loop consumes the whole
      // snapshot exactly as before.
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

    // Memory prefetch consume: only if settled and not already consumed on
    // an earlier iteration. If not settled yet, skip (zero-wait) and retry
    // next iteration — the prefetch gets as many chances as there are loop
    // iterations before the turn ends. readFileState (cumulative across
    // iterations) filters out memories the model already Read/Wrote/Edited
    // — including in earlier iterations, which the per-iteration
    // toolUseBlocks array would miss.
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield emit({ kind: 'attachment', message: msg })
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }

    // (Consumption happened in the drain's own finally above — atomically
    // with the mark clear; the caller settles 'completed' at most once
    // after the run returns.)
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

    // (The HZ4 steer receipt died with the operator-facing pen — the
    // steer-removal ruling: the transcript row IS the delivery receipt.)

    // ── close the turn ───────────────────────────────────────────────────
    // Tool refresh between turns: MCP servers that connected mid-turn join
    // the next call's toolkit.
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // The turn counter's unit: a tool round that leads to another call.
    const nextTurnCount = turnCount + 1

    // maxTurns is checked at the recursion edge, not mid-round.
    if (
      maxTurns !== undefined &&
      budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)
    ) {
      yield emit({
        kind: 'attachment',
        message: createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCount,
        }),
      })
      const terminal: Terminal = { reason: 'max_turns', turnCount: nextTurnCount }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    // ──.3: the cycle lease ─────────────────────────────────────
    // Before the next provider call, consult the owner's folded progress. A
    // stagnant cycle (a barren strategy repeated with no eligible progress)
    // earns ONE injected replan directive; the next stagnant cycle settles
    // with the typed handoff instead of another provider call. Non-run lanes
    // (no substantive snapshot) always proceed.
    let cycleReplanInjected = state.cycleReplanInjected === true
    const cycleDirectiveMessages: Message[] = []
    {
      const leaseOwner = ownerFromToolUseContext(updatedToolUseContext)
      const lease = evaluateCycleLease(
        getRunSnapshot(leaseOwner),
        cycleReplanInjected,
      )
      if (lease.action === 'settle') {
        noteRunEvent(leaseOwner, {
          type: 'stop-decision',
          at: Date.now(),
          decision: 'handoff',
          detail: lease.cause,
        })
        yield emit({
          kind: 'attachment',
          message: createAttachmentMessage({
            type: 'cycle_handoff',
            cause: lease.cause,
            unfinished: lease.unfinished,
            report: renderHandoffReport(lease.report),
          }),
        })
        const terminal: Terminal = { reason: 'cycle_handoff', cause: lease.cause }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }
      if (lease.action === 'replan') {
        cycleReplanInjected = true
        cycleDirectiveMessages.push(
          createUserMessage({ content: lease.directive, isMeta: true }),
        )
        for (const m of cycleDirectiveMessages) {
          yield emit({ kind: 'hook_message', message: m })
        }
      }
    }

    const next: TurnState = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults, ...cycleDirectiveMessages],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      // A completed tool round is real progress: the stream-fault budget is
      // PER-EPISODE (consecutive faults), not per-run — carrying it across
      // rounds made the SECOND fault anywhere in a long flow run terminal
      // (at the measured 3-in-10 Sol-lane fault rate, a near-certain silent
      // stop — the dead-turn incident). The anti-spiral bound
      // still holds: fault → recover → fault with NO round between surfaces.
      streamFaultRecoveryCount: 0,
      // A tool ran this round — the consecutive-refusal count starts over.
      toolCallRefusalRecoveryCount: 0,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
      cycleReplanInjected,
      // A completed tool round is real progress: the overflow ladder's
      // episode starts fresh (its rungs may run again later in a long
      // run; the rapid-refill breaker bounds a fold-refill-fold thrash).
      overflowEpisode: FRESH_OVERFLOW_EPISODE,
      pendingOverflow: undefined,
    }
    yield emit({ kind: 'turn_settled', transition: next.transition! })
    state = next
  } // while (true)
}
