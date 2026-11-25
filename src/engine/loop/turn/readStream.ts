import type { ToolUseBlock } from '../../message-shapes/wire.js'
import { swarmPresented, swarmRoad } from '../../../crew/board/seam.js'
import {
  classifyThinkingDrops,
  createDroppedThinkingAttachment,
  deadThinkingMarks,
  describePrefixRewrite,
  describeThinkingDrops,
  droppedThinkingMarks,
  freshDrops,
  turnOrdinalOfWirePath,
  inputTransformationsOf,
  marksFromDrops,
  prefixMarkOf,
  recordPrefixRewriteLedger,
  recordThinkingDropLedger,
  takeRewriteNoticeOnce,
} from '../../../models/roads/anthropic/thinkingBinding.js'
import { recordDroppedThinking, takePrefixVerdict, takeSidePrefixVerdict, pendingPrefixVerdict } from '../../../models/roads/anthropic/prefixLedger.js'
import { foldCacheUsage } from '../../compaction/cacheEpoch.js'
import { boundPrefixRecordToEmit } from '../../../models/roads/anthropic/boundPrefixRecord.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { overflowLadderArmed } from '../../compaction/overflowRecovery.js'
import { overflowSignalOf } from '../../requests/overflowSignal.js'
import { findToolByName } from '../../../tools/kit/tool.js'
import { isTurnOwningQuerySource } from '../../../models/effort/effort.js'
import type { AssistantMessage, Message, SystemFoldBoundaryMessage } from '../../message-shapes/message.js'
import {
  createThinkingNoteMessage,
  createBusyRecoveryMessage,
} from '../../messages/messages.js'
import { StreamChantWatch } from '../../tool-dispatch/chantGuard.js'
import { reconcileAppliedPlanUsage } from '../../run/requestContextPlan.js'
import { calibrationKeyFor } from '../../run/contextCalibration.js'
import { bindRequestGauge, settleRequestGauge, type RequestGaugeView } from '../../run/requestGauge.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { declaredRouteOf } from '../../../models/roads/callModelRouter.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import {
  backfillCloneForYield,
  isWithheldMaxOutputTokens,
  resetForRetry,
} from '../model-lane.js'
import { stampReply } from '../attachment-drain.js'
import type { RunEvent } from '../events.js'
import type { PrefixVerdict } from '../../../models/roads/anthropic/prefixLedger.js'
import type { EventMint, IterationState, RunCtx } from './turnState.js'

const responsesClassified = new Set<string>()
const busyRecoveriesReceipted = new Set<string>()
const RESPONSES_CLASSIFIED_CAP = 64
function rememberClassifiedResponse(id: string): void {
  responsesClassified.add(id)
  while (responsesClassified.size > RESPONSES_CLASSIFIED_CAP) {
    const oldest = responsesClassified.values().next().value
    if (oldest === undefined) break
    responsesClassified.delete(oldest)
  }
}

type ReplySettling = {
  callId: string
  projectedReplies: Map<string, AssistantMessage>
  settleGauge: (message: AssistantMessage) => void
  fixedPrefix: PrefixVerdict['fixedPrefix']
}

export function* classifyDroppedThinking(run: RunCtx, iter: IterationState, emit: EventMint, settling: ReplySettling, message: AssistantMessage): Generator<RunEvent> {
  const { toolUseContext } = iter
  if (!responsesClassified.has(message.message.id)) {
    rememberClassifiedResponse(message.message.id)
    const allDrops = inputTransformationsOf(message.message)
    const prefixVerdict = isTurnOwningQuerySource(run.querySource)
      ? takePrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))
      : takeSidePrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))
    settling.fixedPrefix = prefixVerdict?.fixedPrefix
    if (allDrops.length > 0) recordDroppedThinking(String(rosterOwnerFromToolUseContext(toolUseContext)), allDrops)
    const strippedMarks = deadThinkingMarks(iter.messagesForRequest)
    const drops = freshDrops(allDrops, prefixVerdict?.wireMessageIds ?? [], strippedMarks, droppedThinkingMarks(iter.messagesForRequest))
    if (drops.length < allDrops.length) logForDebugging(`preserved thinking: the API dropped ${allDrops.length - drops.length} already-dropped block(s) again; they stay on the wire unbilled and the cached prefix stands`)
    const rewrite = prefixVerdict?.mismatch ?? null
    const outcome = classifyThinkingDrops(
      String(ownerFromToolUseContext(toolUseContext)),
      drops,
      prefixMarkOf(
        iter.messagesForRequest,
        iter.currentModel,
        { permissionMode: toolUseContext.getAppState().toolPermissionContext.mode },
        { requestPlan: iter.requestPlan },
      ),
      { byteMoved: rewrite !== null },
    )
    if (rewrite !== null && outcome.kind !== 'none' && outcome.lawful === null) outcome.part = rewrite.part
    const recordBehind = prefixVerdict?.behind ?? 0
    if (recordBehind > 0 && outcome.kind !== 'none' && outcome.lawful === null) outcome.behind = recordBehind
    const dropNotice = describeThinkingDrops(drops, outcome, turnOrdinalOfWirePath(outcome.path, prefixVerdict?.wireMessageIds ?? [], iter.messagesForRequest))
    if (outcome.kind !== 'none') {
      recordThinkingDropLedger(outcome, iter.currentModel, dropNotice)
      logForDebugging(`preserved thinking: ${JSON.stringify(drops)}`, { level: 'warn' })
    }
    if (dropNotice !== null) {
      const lawful = outcome.kind === 'lawful'
      logForDebugging(`preserved thinking: ${lawful ? 'note' : 'warning'}: ${dropNotice}`)
      yield emit({ kind: 'notice', message: createThinkingNoteMessage(dropNotice, lawful ? 'info' : 'warning') })
    } else if (rewrite !== null && outcome.kind === 'none') {
      const rewriteNotice = describePrefixRewrite(rewrite.part, rewrite.path)
      recordPrefixRewriteLedger(rewrite.part, rewrite.path, iter.currentModel, rewriteNotice)
      if (takeRewriteNoticeOnce(String(ownerFromToolUseContext(toolUseContext)))) {
        yield emit({ kind: 'notice', message: createThinkingNoteMessage(rewriteNotice, 'warning') })
      }
    }
    const dropped = marksFromDrops(drops, prefixVerdict?.wireMessageIds ?? [], strippedMarks)
    if (dropped.length > 0) {
      logForDebugging(`preserved thinking: ${dropped.length} dropped block(s) recorded as dropped; they stay on the wire as the API returned them (${dropped.map(mark => `${mark.messageId}#${mark.blockIndex}`).join(', ')})`)
      const record = createDroppedThinkingAttachment(dropped)
      yield emit({ kind: 'attachment', message: record })
      iter.thinkingRecords.push(record)
    }
  }
}

export async function* settleReply(run: RunCtx, iter: IterationState, emit: EventMint, settling: ReplySettling, message: AssistantMessage, yieldMessage: AssistantMessage): AsyncGenerator<RunEvent> {
  const { toolUseContext } = iter
  settling.projectedReplies.set(message.uuid, yieldMessage)
  settling.settleGauge(message)
  const waited = message.busyRecovery
  if (waited !== undefined && !busyRecoveriesReceipted.has(message.uuid)) {
    busyRecoveriesReceipted.add(message.uuid)
    yield emit({
      kind: 'notice',
      message: createBusyRecoveryMessage({
        provider: waited.provider,
        retries: waited.retries,
        elapsedMs: waited.elapsedMs,
        content: waited.detail,
        ...(waited.status !== undefined ? { status: waited.status } : {}),
        ...(waited.code !== undefined ? { code: waited.code } : {}),
      }),
    })
  }
  stampReply(message, iter.replyTo)
  if (yieldMessage !== message && message.inReplyTo !== undefined) yieldMessage.inReplyTo = message.inReplyTo
  yield emit({
    kind: 'assistant_settled',
    callId: settling.callId,
    message: yieldMessage,
    withheld: iter.streamChant !== undefined || isWithheldMaxOutputTokens(message) || (overflowSignalOf(message) !== null && overflowLadderArmed(run.querySource)),
  })
  iter.assistantMessages.push(message)
  yield* classifyDroppedThinking(run, iter, emit, settling, message)
  if (toolUseContext.rosterOwner === undefined) {
    const record = await boundPrefixRecordToEmit(
      String(rosterOwnerFromToolUseContext(toolUseContext)),
      iter.messagesForRequest,
      iter.currentModel,
      toolUseContext.agentId !== undefined
        ? { rosterOnly: true, context: { userContext: run.userContext, systemContext: run.systemContext } }
        : { rosterOnly: false },
    )
    if (record !== null) yield emit({ kind: 'attachment', message: record })
  }
  const calls = message.message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
  if (calls.length === 0) return
  iter.toolUseBlocks.push(...calls)
  iter.needsFollowUp = true
  if (iter.closingTurn) return
  for (const block of calls) iter.early.offer(block, message, iter.toolUseBlocks.indexOf(block))
}

function boundGaugeOf(iter: IterationState): RequestGaugeView | undefined {
  const planned = iter.requestPlan.gauge
  if (planned === undefined) return undefined
  const key = calibrationKeyFor(declaredRouteOf(iter.currentModel) ?? 'unrecognised', iter.currentModel)
  const epoch = getContextEpoch(ownerFromToolUseContext(iter.toolUseContext)).epoch
  const bound = bindRequestGauge(iter.messagesForRequest, key, epoch, planned.fixed, planned.rebase)
  return planned.digest === bound.digest && planned.sourceDigest !== undefined ? { ...bound, sourceDigest: planned.sourceDigest } : bound
}

function unlandedFoldBoundaryOf(view: readonly Message[]): string | undefined {
  const boundary = view.findLast((row): row is SystemFoldBoundaryMessage => row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.cacheEpoch !== undefined)
  if (boundary === undefined) return undefined
  const landed = view.some(row => row.type === 'assistant' && row.foldLanding?.boundaryId === boundary.uuid)
  return landed ? undefined : boundary.uuid
}

type StreamCall = {
  callId: string
  streamController: AbortController
}

type CallSending = {
  ownerKey: string
  sent: Message[]
  onStreamingFallback: () => void
  reachedTheRoad: () => void
}

type StreamSteps = {
  firstTurnContext: () => Promise<Record<string, string>> | null
  sent: (firstTurnContext: Record<string, string> | null) => Message[]
  open: (sending: CallSending) => ReturnType<RunCtx['deps']['callModel']>
  receipts: (iter: IterationState, emit: EventMint, settleGauge: (message: AssistantMessage) => void) => Generator<RunEvent>
}

export async function* readStream(run: RunCtx, iter: IterationState, emit: EventMint, call: StreamCall, steps: StreamSteps): AsyncGenerator<RunEvent> {
  const { toolUseContext } = iter
  const { options } = toolUseContext
  const { callId, streamController } = call
  const ownerKey = String(rosterOwnerFromToolUseContext(toolUseContext))
  const firstTurnContext = steps.firstTurnContext()
  const sent = steps.sent(firstTurnContext === null ? null : await firstTurnContext)

  const gauge = boundGaugeOf(iter)
  const settling: ReplySettling = {
    callId,
    projectedReplies: new Map(),
    fixedPrefix: undefined,
    settleGauge: message => {
      if (gauge === undefined || message.contextGauge !== undefined) return
      if (settleRequestGauge(gauge, message) === null) return
      const boundaryId = unlandedFoldBoundaryOf(iter.messagesForRequest)
      const landed = foldCacheUsage(message.message.usage)
      if (boundaryId !== undefined && landed !== null) {
        const fixedPrefix = settling.fixedPrefix ?? pendingPrefixVerdict(ownerKey)?.fixedPrefix
        message.foldLanding = { boundaryId, usage: landed, ...(fixedPrefix !== undefined ? { fixedPrefix } : {}) }
      }
      const shown = settling.projectedReplies.get(message.uuid)
      if (shown !== undefined && shown !== message) {
        shown.contextGauge = message.contextGauge
        if (message.foldLanding !== undefined) shown.foldLanding = message.foldLanding
      }
      if (callId !== `${iter.turnId}.c1`) return
      const { usage } = message.message
      reconcileAppliedPlanUsage(ownerFromToolUseContext(toolUseContext), (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0))
    },
  }

  let boardTold = false
  const reachedTheRoad = (): void => {
    if (boardTold) return
    try {
      if (!swarmRoad(toolUseContext.agentId)) return
      boardTold = true
      swarmPresented(toolUseContext.agentId, sent, callId)
    } catch (error) {
      logForDebugging(`crew board accounting: ${error}`)
    }
  }

  let restarted = false
  const stream = steps.open({
    ownerKey,
    sent,
    onStreamingFallback: () => {
      restarted = true
    },
    reachedTheRoad,
  })

  const findTool = (name: string): ReturnType<typeof findToolByName> => findToolByName(options.tools, name)
  let chantWatch = new StreamChantWatch()
  for await (const item of stream) {
    if (item.type === 'stream_event' || (item.type === 'assistant' && item.isApiErrorMessage !== true)) reachedTheRoad()
    if (restarted) {
      restarted = false
      for (const settled of iter.assistantMessages) {
        if (settled.inReplyTo !== undefined && settled.inReplyTo.length > 0) iter.replyTo.unshift(...settled.inReplyTo)
        yield emit({ kind: 'assistant_retracted', message: settled })
      }
      iter.needsFollowUp = resetForRetry(iter).needsFollowUp
      chantWatch = new StreamChantWatch()
    }
    if (item.type === 'assistant') {
      yield* settleReply(run, iter, emit, settling, item, backfillCloneForYield(item, findTool))
      continue
    }
    if (item.type === 'stream_event') {
      if (iter.streamChant !== undefined) continue
      const chant = chantWatch.feed(item.event)
      if (chant !== null) {
        iter.streamChant = chant
        streamController.abort('stream-chant')
        continue
      }
    }
    yield emit({ kind: 'stream_delta', callId, raw: backfillCloneForYield(item, findTool) })
  }

  yield* steps.receipts(iter, emit, settling.settleGauge)
}
