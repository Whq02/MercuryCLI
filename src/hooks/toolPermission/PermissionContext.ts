// The React-free permission-decision context: one frozen object per
// permission request carrying the decision builders, hook execution,
// persistence, cancellation, and the confirm-queue bridge. The interactive,
// coordinator and swarm handlers do everything through this object — none of
// them touches React.

import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionUpdate,
} from '../../types/permissions.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  withMemoryCorrectionHint,
} from '../../utils/messages.js'
import { executePermissionRequestHooks } from '../../utils/hooks.js'
import { decideRuleBasedPermissions } from '../../utils/permissions/decision/engine.js'
import { guardHookUpdatedInput } from '../../utils/permissions/decision/wrapper.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
  supportsPersistence,
} from '../../utils/permissions/PermissionUpdate.js'
import {
  logPermissionDecision,
  type PermissionApprovalSource,
  type PermissionDecisionArgs,
  type PermissionLogContext,
  type PermissionRejectionSource,
} from './permissionLogging.js'

export type { PermissionApprovalSource, PermissionRejectionSource }



/** The three confirm-queue verbs over the queue state. */
export type PermissionQueueOps = {
  push(entry: ToolUseConfirm): void
  remove(toolUseID: string): void
  update(toolUseID: string, patch: Partial<ToolUseConfirm>): void
}

/** A resolver wrapped so it can settle at most once, with an atomic claim. */
export type ResolveOnce<T> = {
  resolve(value: T): void
  isResolved(): boolean
  claim(): boolean
}

/**
 * Wrap a resolver with at-most-once delivery. `claim()` atomically
 * test-and-sets: async callbacks must claim BEFORE awaiting, closing the
 * window between checking and resolving. Claiming marks the guard resolved
 * even before delivery, so every claim path must end in a resolve — a
 * claimant that never delivers wedges the promise.
 */
export function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let resolved = false
  let delivered = false
  return {
    resolve(value: T): void {
      if (delivered) return
      delivered = true
      resolved = true
      resolve(value)
    },
    isResolved(): boolean {
      return resolved
    },
    claim(): boolean {
      if (resolved) return false
      resolved = true
      return true
    },
  }
}

type LogDecisionOptions = {
  input?: unknown
  promptStartMs?: number
}

type BuildAllowOptions = {
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  acceptFeedback?: string
  contentBlocks?: ContentBlockParam[]
}

type HandleUserAllowOptions = {
  decisionReason?: PermissionDecisionReason
  promptStartMs?: number
}

export type PermissionContext = {
  readonly tool: Tool
  readonly input: Record<string, unknown>
  readonly toolUseContext: ToolUseContext
  readonly assistantMessage: AssistantMessage
  readonly messageId: string
  readonly toolUseID: string

  logDecision(args: PermissionDecisionArgs, opts?: LogDecisionOptions): void
  logCancelled(): void
  persistPermissions(updates: PermissionUpdate[]): boolean
  resolveIfAborted(resolve: (decision: PermissionDecision) => void): boolean
  cancelAndAbort(
    feedback?: string,
    isAbort?: boolean,
    contentBlocks?: ContentBlockParam[],
  ): PermissionDecision
  runHooks(
    permissionMode: string | undefined,
    suggestions: PermissionUpdate[] | undefined,
    updatedInput?: Record<string, unknown>,
    promptStartMs?: number,
  ): Promise<PermissionDecision | null>
  buildAllow(
    updatedInput: Record<string, unknown>,
    opts?: BuildAllowOptions,
  ): PermissionDecision
  buildDeny(
    message: string,
    decisionReason?: PermissionDecisionReason,
  ): PermissionDecision
  handleUserAllow(
    updatedInput: Record<string, unknown>,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
    opts?: HandleUserAllowOptions,
  ): Promise<PermissionDecision>
  handleHookAllow(
    updatedInput: Record<string, unknown>,
    permissionUpdates: PermissionUpdate[],
    promptStartMs?: number,
  ): Promise<PermissionDecision>

  pushToQueue(entry: ToolUseConfirm): void
  removeFromQueue(): void
  updateQueueItem(patch: Partial<ToolUseConfirm>): void
}

/** Adapt a React array-state setter into the three queue verbs. */
export function createPermissionQueueOps(
  setToolUseConfirmQueue: (
    updater: (prev: ToolUseConfirm[]) => ToolUseConfirm[],
  ) => void,
): PermissionQueueOps {
  return {
    push(entry) {
      setToolUseConfirmQueue(prev => [...prev, entry])
    },
    remove(toolUseID) {
      setToolUseConfirmQueue(prev =>
        prev.filter(item => item.toolUseID !== toolUseID),
      )
    },
    update(toolUseID, patch) {
      setToolUseConfirmQueue(prev =>
        prev.map(item =>
          item.toolUseID === toolUseID ? { ...item, ...patch } : item,
        ),
      )
    },
  }
}

export function createPermissionContext(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  setToolPermissionContext: (next: ToolPermissionContext) => void,
  queueOps?: PermissionQueueOps,
): PermissionContext {
  // The decision recorder writes into the TOOL-USE CONTEXT's own decisions
  // map (lazily created there), keyed by this tool-use id — the execution
  // layer reads and cleans that map (L4). The frozen context object
  // below is never mutated.
  const logContext: PermissionLogContext = { toolUseID, toolUseContext }
  const ctx: PermissionContext = {
    tool,
    input,
    toolUseContext,
    assistantMessage,
    messageId: assistantMessage.message.id,
    toolUseID,

    logDecision(args, opts) {
      logPermissionDecision(logContext, args, opts?.promptStartMs)
    },

    // Settlement bookkeeping this once fed was deleted with the telemetry
    // estate. The empty method survives only while the not-yet-rewritten
    // useCanUseTool still calls it (stubsPendingImporterRewrite).
    logCancelled() {},

    persistPermissions(updates) {
      if (updates.length === 0) return false
      const { error } = persistPermissionUpdates(updates)
      setToolPermissionContext(
        applyPermissionUpdates(
          toolUseContext.getAppState()
            .toolPermissionContext as ToolPermissionContext,
          updates,
        ),
      )
      // "permanent" is the truth of the write, not the intent: a refused
      // settings write (a file mid-edit, a refused publish) leaves the
      // grant applied for this session only — the persist owner logged
      // why (release-hardening audit rank 17).
      return error === null && updates.some(update => supportsPersistence(update.destination))
    },

    resolveIfAborted(resolve) {
      if (!toolUseContext.abortController.signal.aborted) return false
      resolve(ctx.cancelAndAbort(undefined, true))
      return true
    },

    cancelAndAbort(feedback, isAbort, contentBlocks) {
      const isSubagent = Boolean(toolUseContext.agentId)
      let message: string
      if (feedback) {
        message =
          (isSubagent
            ? SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX
            : REJECT_MESSAGE_WITH_REASON_PREFIX) + feedback
      } else {
        message = isSubagent ? SUBAGENT_REJECT_MESSAGE : REJECT_MESSAGE
      }
      if (!isSubagent) {
        message = withMemoryCorrectionHint(message)
      }
      if (
        isAbort ||
        (!feedback && (!contentBlocks || contentBlocks.length === 0) && !isSubagent)
      ) {
        toolUseContext.abortController.abort()
      }
      if (contentBlocks && contentBlocks.length > 0) {
        return { behavior: 'ask', message, contentBlocks }
      }
      return { behavior: 'ask', message }
    },

    async runHooks(permissionMode, suggestions, updatedInput, promptStartMs) {
      for await (const hookResult of executePermissionRequestHooks(
        tool.name,
        toolUseID,
        input,
        toolUseContext,
        permissionMode,
        suggestions,
        toolUseContext.abortController.signal,
      )) {
        const decision = hookResult.permissionRequestResult
        if (!decision) continue

        if (decision.behavior === 'allow') {
          const finalInput = decision.updatedInput ?? updatedInput ?? input
          if (decision.updatedInput) {
            // A hook that rewrites inputs could otherwise turn an action the
            // rules forbid into one they allow; the rewritten input is
            // re-checked and a deny/ask rule overrides the hook's allow.
            const override = guardHookUpdatedInput(
              (await decideRuleBasedPermissions(tool, finalInput, toolUseContext))
                .decision,
              tool.name,
            )
            if (override) {
              if (override.behavior === 'deny') {
                ctx.logDecision(
                  { decision: 'reject', source: { type: 'hook' } },
                  { promptStartMs },
                )
                return override
              }
              // An ask override falls through to the normal prompt, which
              // logs its own decision — logging here would be premature.
              return null
            }
          }
          return ctx.handleHookAllow(
            finalInput,
            decision.updatedPermissions ?? [],
            promptStartMs,
          )
        }

        if (decision.behavior === 'deny') {
          ctx.logDecision(
            { decision: 'reject', source: { type: 'hook' } },
            { promptStartMs },
          )
          if (decision.interrupt) {
            toolUseContext.abortController.abort()
          }
          return ctx.buildDeny(
            decision.message || 'A PermissionRequest hook denied this tool use.',
            {
              type: 'hook',
              hookName: 'PermissionRequest',
              reason: decision.message,
            },
          )
        }
      }
      return null
    },

    buildAllow(updatedInput, opts) {
      const allow: PermissionDecision = {
        behavior: 'allow',
        updatedInput,
        userModified: opts?.userModified ?? false,
      }
      const mutable = allow as {
        decisionReason?: PermissionDecisionReason
        acceptFeedback?: string
        contentBlocks?: ContentBlockParam[]
      }
      if (opts?.decisionReason) mutable.decisionReason = opts.decisionReason
      if (opts?.acceptFeedback) mutable.acceptFeedback = opts.acceptFeedback
      if (opts?.contentBlocks && opts.contentBlocks.length > 0) {
        mutable.contentBlocks = opts.contentBlocks
      }
      return allow
    },

    buildDeny(message, decisionReason) {
      return {
        behavior: 'deny',
        message,
        decisionReason: decisionReason ?? { type: 'other', reason: message },
      }
    },

    async handleUserAllow(updatedInput, permissionUpdates, feedback, contentBlocks, opts) {
      const permanent = ctx.persistPermissions(permissionUpdates)
      ctx.logDecision(
        { decision: 'accept', source: { type: 'user', permanent } },
        { input: updatedInput, promptStartMs: opts?.promptStartMs },
      )
      const userModified = tool.inputsEquivalent
        ? !tool.inputsEquivalent(input, updatedInput)
        : false
      const trimmedFeedback = feedback?.trim()
      return ctx.buildAllow(updatedInput, {
        userModified,
        decisionReason: opts?.decisionReason,
        acceptFeedback: trimmedFeedback || undefined,
        contentBlocks,
      })
    },

    async handleHookAllow(updatedInput, permissionUpdates, promptStartMs) {
      const permanent = ctx.persistPermissions(permissionUpdates)
      ctx.logDecision(
        { decision: 'accept', source: { type: 'hook', permanent } },
        { input: updatedInput, promptStartMs },
      )
      return ctx.buildAllow(updatedInput, {
        decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
      })
    },

    pushToQueue(entry) {
      queueOps?.push(entry)
    },
    removeFromQueue() {
      queueOps?.remove(toolUseID)
    },
    updateQueueItem(patch) {
      queueOps?.update(toolUseID, patch)
    },
  }
  return Object.freeze(ctx)
}
