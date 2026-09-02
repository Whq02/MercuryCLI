// Main-agent interactive permission flow: push the confirm-queue entry, race
// the permission hooks against the human, and guarantee the promise settles.
//
// The one invariant the whole flow is built around: the promise MUST settle
// when the turn's abort signal fires — even if the dialog is suppressed,
// hidden behind another surface, unmounted, or already removed from the
// queue. A resolver that is never called leaves the tool executor awaiting it
// for the rest of the session.

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

/** Keypresses inside this window after the prompt appears are treated as
 *  typing spillover, not dialog interaction. */
const USER_INTERACTION_GRACE_MS = 200


export type InteractivePermissionParams = {
  ctx: PermissionContext
  description: string
  result: PermissionAskDecision
  /** True when automated checks already ran (the coordinator branch). */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** The retired channel-relay slot: still in the shape, read nowhere. */
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

  // The channel subscription survives only as a cleanup seam; nothing arms it.
  let channelUnsubscribe: (() => void) | null = null
  // The checkmark-transition timer: the dialog still calls the dismiss
  // callback, but nothing ever arms the timer, so the callback is inert.
  let checkmarkTimer: ReturnType<typeof setTimeout> | null = null
  let userInteracted = false
  // A flow-classifier block that reached this card: the operator's answer is
  // booked — a "no" holds for the rest of the turn (the same action is not
  // re-asked), a "yes" ends the ledger's consecutive-block streak.
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

  // The settlement floor: claim once, clean up once, resolve once. The
  // dialog's own abort callback delegates here, so both routes share it.
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
    // A background-run ask carries its origin label (the workflow channel
    // stamps `workflow · agent`); the card's badge names the asker.
    ...((ctx.toolUseContext as { workflowAskBadge?: ToolUseConfirm['workerBadge'] })
      .workflowAskBadge
      ? {
          workerBadge: (
            ctx.toolUseContext as { workflowAskBadge?: ToolUseConfirm['workerBadge'] }
          ).workflowAskBadge,
        }
      : {}),

    onUserInteraction() {
      // Ignore the grace window so a stray keypress does not cancel an
      // in-flight automated check.
      if (Date.now() - permissionPromptStartTimeMs < USER_INTERACTION_GRACE_MS) {
        return
      }
      userInteracted = true
      void userInteracted
      // Live call — the classifier-approval store is still read elsewhere.
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
      // Claim atomically BEFORE awaiting, or an abort landing during the
      // await double-settles.
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
      // The await opened a race window — claim, never merely re-check.
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

  // Entry and listener are created together: push first, then arm — and if
  // the abort already landed in the async gap since the caller's last check,
  // settle immediately instead of arming.
  ctx.pushToQueue(entry)
  if (signal.aborted) {
    settleOnAbort()
    return
  }
  signal.addEventListener('abort', settleOnAbort, { once: true })

  // The background hook race: unless the caller already awaited automated
  // checks, permission hooks run against the live mode and the rule engine's
  // suggestions/updated input; a hook decision that can claim the guard wins.
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
