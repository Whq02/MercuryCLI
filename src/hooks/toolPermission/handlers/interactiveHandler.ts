
import type { ToolUseConfirm } from '../../../components/permissions/PermissionRequest.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
} from '../../../types/permissions.js'
import { clearClassifierChecking } from '../../../utils/classifierApprovals.js'
import { logError } from '../../../utils/log.js'
import { decideToolPermissionWithModes } from '../../../utils/permissions/decision/wrapper.js'
import {
  noteOperatorAllowedFlowBlock,
  recordOperatorDeclinedFlowBlock,
} from '../../../utils/permissions/flowBlockReview.js'
import { createResolveOnce, type PermissionContext } from '../PermissionContext.js'

const USER_INTERACTION_GRACE_MS = 200


export type InteractivePermissionParams = {
  ctx: PermissionContext
  description: string
  result: PermissionAskDecision
  awaitAutomatedChecksBeforeDialog?: boolean
  channelCallbacks?: unknown
}

export function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void {
  const { ctx, description, result, awaitAutomatedChecksBeforeDialog } = params
  const guard = createResolveOnce(resolve)
  const permissionPromptStartTimeMs = Date.now()
  const displayedInput = result.updatedInput ?? ctx.input
  const signal = ctx.toolUseContext.abortController.signal

  let channelUnsubscribe: (() => void) | null = null
  let checkmarkTimer: ReturnType<typeof setTimeout> | null = null
  let userInteracted = false
  const flowBlocked =
    result.decisionReason?.type === 'classifier' &&
    result.decisionReason.classifier === 'auto-mode'

  const releaseResources = (): void => {
    signal.removeEventListener('abort', settleOnAbort)
    if (channelUnsubscribe) {
      channelUnsubscribe()
      channelUnsubscribe = null
    }
  }

  const settleOnAbort = (): void => {
    if (!guard.claim()) return
    releaseResources()
    ctx.removeFromQueue()
    ctx.logDecision(
      { decision: 'reject', source: { type: 'userAbort' } },
      { promptStartMs: permissionPromptStartTimeMs },
    )
    guard.resolve(ctx.cancelAndAbort(undefined, true))
  }

  const entry: ToolUseConfirm = {
    assistantMessage: ctx.assistantMessage,
    tool: ctx.tool,
    description,
    input: displayedInput,
    toolUseContext: ctx.toolUseContext,
    toolUseID: ctx.toolUseID,
    permissionResult: result,
    permissionPromptStartTimeMs,
    ...((ctx.toolUseContext as { workflowAskBadge?: ToolUseConfirm['workerBadge'] })
      .workflowAskBadge
      ? {
          workerBadge: (
            ctx.toolUseContext as { workflowAskBadge?: ToolUseConfirm['workerBadge'] }
          ).workflowAskBadge,
        }
      : {}),

    onUserInteraction() {
      if (Date.now() - permissionPromptStartTimeMs < USER_INTERACTION_GRACE_MS) {
        return
      }
      userInteracted = true
      void userInteracted
      clearClassifierChecking(ctx.toolUseID)
    },

    onDismissCheckmark() {
      if (checkmarkTimer === null) return
      clearTimeout(checkmarkTimer)
      checkmarkTimer = null
      signal.removeEventListener('abort', settleOnAbort)
      ctx.removeFromQueue()
    },

    onAbort: settleOnAbort,

    async onAllow(updatedInput, permissionUpdates, feedback, contentBlocks) {
      if (!guard.claim()) return
      releaseResources()
      if (flowBlocked) noteOperatorAllowedFlowBlock(ctx.toolUseContext)
      guard.resolve(
        await ctx.handleUserAllow(
          updatedInput,
          permissionUpdates,
          feedback,
          contentBlocks,
          {
            decisionReason: result.decisionReason,
            promptStartMs: permissionPromptStartTimeMs,
          },
        ),
      )
    },

    onReject(feedback, contentBlocks) {
      if (!guard.claim()) return
      releaseResources()
      if (flowBlocked) {
        recordOperatorDeclinedFlowBlock(ctx.toolUseContext, ctx.tool.name, ctx.input)
      }
      ctx.logDecision(
        {
          decision: 'reject',
          source: {
            type: 'userReject',
            hasFeedback: Boolean(feedback && feedback.trim()),
          },
        },
        { promptStartMs: permissionPromptStartTimeMs },
      )
      guard.resolve(ctx.cancelAndAbort(feedback, false, contentBlocks))
    },

    async recheckPermission() {
      if (guard.isResolved()) return
      const fresh = (
        await decideToolPermissionWithModes(
          ctx.tool,
          ctx.input,
          ctx.toolUseContext,
          ctx.assistantMessage,
          ctx.toolUseID,
        )
      ).decision
      if (fresh.behavior !== 'allow') return
      if (!guard.claim()) return
      releaseResources()
      ctx.removeFromQueue()
      ctx.logDecision(
        { decision: 'accept', source: 'config' },
        { promptStartMs: permissionPromptStartTimeMs },
      )
      guard.resolve(
        ctx.buildAllow(fresh.updatedInput ?? ctx.input, {
          decisionReason: fresh.decisionReason,
        }),
      )
    },
  }

  ctx.pushToQueue(entry)
  if (signal.aborted) {
    settleOnAbort()
    return
  }
  signal.addEventListener('abort', settleOnAbort, { once: true })

  if (!awaitAutomatedChecksBeforeDialog) {
    void (async () => {
      const liveMode =
        ctx.toolUseContext.getAppState().toolPermissionContext.mode
      const hookDecision = await ctx.runHooks(
        liveMode,
        result.suggestions,
        result.updatedInput,
        permissionPromptStartTimeMs,
      )
      if (hookDecision && guard.claim()) {
        releaseResources()
        ctx.removeFromQueue()
        guard.resolve(hookDecision)
      }
    })().catch(error => logError(error))
  }
}
