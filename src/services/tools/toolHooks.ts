import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, AttachmentMessage, Message } from '../../types/message.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from '../../types/permissions.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import {
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreToolHooks,
  getPreToolHookBlockingMessage,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { checkRuleBasedPermissions } from '../../utils/permissions/permissions.js'
import { getRuleBehaviorDescription } from '../../utils/permissions/PermissionResult.js'
import type { McpServerType } from './toolExecution.js'

/**
 * Pre/post/failure hook adapters around the hook engine, plus the
 * hook-decision → permission-decision resolver.
 *
 * All three adapters accept the originating message id, the request id and
 * the MCP transport kind/base URL — kept on the signature even where a body
 * does not forward them yet, so the interface names the seam.
 */

/** Hook-name shapes (contract data). */
function preToolHookName(toolName: string): string {
  return `PreToolUse:${toolName}`
}
function postToolHookName(toolName: string): string {
  return `PostToolUse:${toolName}`
}
function postToolFailureHookName(toolName: string): string {
  return `PostToolUseFailure:${toolName}`
}

/** The aggregated permission verdict a pre-tool hook produced. */
export type HookPermissionOutcome = {
  behavior: 'allow' | 'ask' | 'deny'
  updatedInput?: AnyObject
  message?: string
  decisionReason?: PermissionDecisionReason
}

/** One item on the pre-tool hook stream. */
export type PreToolUseHookItem =
  | { kind: 'message'; message: Message }
  | { kind: 'permissionResult'; result: HookPermissionOutcome }
  | { kind: 'updatedInput'; updatedInput: AnyObject }
  | { kind: 'preventContinuation' }
  | { kind: 'stopReason'; stopReason: string }
  | { kind: 'additionalContext'; message: AttachmentMessage }
  | { kind: 'stop' }

type HookSeamArgs = {
  /** The uuid of the assistant message that issued the tool call. */
  messageId: string | undefined
  requestId: string | undefined
  mcpServerType: McpServerType
  mcpServerUrl: string | undefined
}

function hookDecisionReason(
  toolName: string,
  source: string | undefined,
  reason: string | undefined,
): PermissionDecisionReason {
  return {
    type: 'hook',
    hookName: preToolHookName(toolName),
    ...(source !== undefined ? { source } : {}),
    ...(reason !== undefined ? { reason } : {}),
  } as PermissionDecisionReason
}

/**
 * Adapt the pre-tool hook engine into the typed stream the transaction
 * consumes. A blocking error becomes a deny; a declared permission
 * behaviour maps to allow/ask/deny; an updated input with no behaviour is a
 * passthrough update; prevent-continuation is its own item, followed by a
 * stop-reason item only when the hook supplied one; additional contexts
 * become one attachment per batch; an abort mid-execution emits a
 * cancellation attachment and stops; a per-result exception converts to an
 * error-during-execution attachment and stops.
 */
export async function* runPreToolUseHooks(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  toolUseContext: ToolUseContext,
  permissionMode: string | undefined,
  signal: AbortSignal,
  _seam: HookSeamArgs,
): AsyncGenerator<PreToolUseHookItem> {
  const hookName = preToolHookName(tool.name)
  const toolInputSummary = tool.getToolUseSummary?.(input as never) ?? null
  try {
    for await (const result of executePreToolHooks(
      tool.name,
      toolUseID,
      input,
      toolUseContext,
      permissionMode,
      signal,
      undefined,
      toolUseContext.requestPrompt,
      toolInputSummary,
    )) {
      try {
        if (signal.aborted) {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName,
              toolUseID,
              hookEvent: 'PreToolUse',
            } as never),
          }
          yield { kind: 'stop' }
          return
        }

        if (result.message) {
          yield { kind: 'message', message: result.message as Message }
        }

        if (result.blockingError) {
          yield {
            kind: 'permissionResult',
            result: {
              behavior: 'deny',
              message: getPreToolHookBlockingMessage(hookName, result.blockingError),
              decisionReason: hookDecisionReason(
                tool.name,
                result.hookSource,
                result.hookPermissionDecisionReason,
              ),
            },
          }
        } else if (result.permissionBehavior === 'allow') {
          yield {
            kind: 'permissionResult',
            result: {
              behavior: 'allow',
              updatedInput: result.updatedInput,
              decisionReason: hookDecisionReason(
                tool.name,
                result.hookSource,
                result.hookPermissionDecisionReason,
              ),
            },
          }
        } else if (result.permissionBehavior === 'ask') {
          yield {
            kind: 'permissionResult',
            result: {
              behavior: 'ask',
              updatedInput: result.updatedInput,
              message:
                result.hookPermissionDecisionReason ??
                `The ${hookName} hook ${getRuleBehaviorDescription('ask')} this tool use`,
              decisionReason: hookDecisionReason(
                tool.name,
                result.hookSource,
                result.hookPermissionDecisionReason,
              ),
            },
          }
        } else if (result.permissionBehavior === 'deny') {
          yield {
            kind: 'permissionResult',
            result: {
              behavior: 'deny',
              message: result.hookPermissionDecisionReason,
              decisionReason: hookDecisionReason(
                tool.name,
                result.hookSource,
                result.hookPermissionDecisionReason,
              ),
            },
          }
        } else if (result.updatedInput !== undefined) {
          // No declared behaviour: a passthrough input update — the normal
          // permission flow continues over the new input.
          yield { kind: 'updatedInput', updatedInput: result.updatedInput }
        }

        if (result.preventContinuation) {
          yield { kind: 'preventContinuation' }
          if (result.stopReason !== undefined) {
            yield { kind: 'stopReason', stopReason: result.stopReason }
          }
        }

        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            kind: 'additionalContext',
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts.join('\n'),
              hookName,
              toolUseID,
              hookEvent: 'PreToolUse',
            } as never),
          }
        }
      } catch (error) {
        logError(error)
        yield {
          kind: 'message',
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content: error instanceof Error ? error.message : String(error),
            hookName,
            toolUseID,
            hookEvent: 'PreToolUse',
          } as never),
        }
        yield { kind: 'stop' }
        return
      }
    }
  } catch (error) {
    // An exception around the whole loop stops the stream after logging.
    logError(error)
    yield { kind: 'stop' }
  }
}

/** One item on the post-tool hook stream. */
export type PostToolUseHooksResult<Output> =
  | { kind: 'message'; message: Message }
  | { kind: 'updatedOutput'; output: Output }

/**
 * Adapt the post-tool hook engine. A cancellation attachment observed
 * mid-stream is re-emitted with this hook's name/event and the loop
 * continues (cancellation is per-hook); a blocking error yields exactly ONE
 * blocking-error attachment (the engine's own blocking-error attachment for
 * JSON-decision blocks is suppressed so the reason never shows twice);
 * prevent-continuation yields a stopped-continuation attachment and ends
 * the stream; a replaced MCP output is yielded as its own variant; an outer
 * exception is logged and swallowed — post hooks never fail the call.
 */
export async function* runPostToolUseHooks<Output>(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  output: Output,
  toolUseContext: ToolUseContext,
  permissionMode: string | undefined,
  signal: AbortSignal | undefined,
  _seam: HookSeamArgs,
): AsyncGenerator<PostToolUseHooksResult<Output>> {
  const hookName = postToolHookName(tool.name)
  try {
    for await (const result of executePostToolHooks(
      tool.name,
      toolUseID,
      input,
      output,
      toolUseContext,
      permissionMode,
      signal,
    )) {
      try {
        const attachment =
          result.message && result.message.type === 'attachment'
            ? (result.message.attachment as { type?: string })
            : undefined
        if (attachment?.type === 'hook_cancelled') {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              ...(result.message as AttachmentMessage).attachment,
              hookName,
              hookEvent: 'PostToolUse',
            } as never),
          }
          continue
        }
        if (attachment?.type === 'hook_blocking_error') {
          // Suppressed: the blocking error itself is emitted once below.
          continue
        }
        if (result.message) {
          yield { kind: 'message', message: result.message as Message }
        }
        if (result.blockingError) {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              type: 'hook_blocking_error',
              blockingError: result.blockingError,
              hookName,
              toolUseID,
              hookEvent: 'PostToolUse',
            } as never),
          }
        }
        if (result.preventContinuation) {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              type: 'hook_stopped_continuation',
              content:
                result.stopReason ?? 'A post-tool hook stopped execution',
              hookName,
              toolUseID,
              hookEvent: 'PostToolUse',
            } as never),
          }
          return
        }
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts.join('\n'),
              hookName,
              toolUseID,
              hookEvent: 'PostToolUse',
            } as never),
          }
        }
        if (result.updatedMCPToolOutput !== undefined) {
          yield { kind: 'updatedOutput', output: result.updatedMCPToolOutput as Output }
        }
      } catch (error) {
        logError(error)
        yield {
          kind: 'message',
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content: error instanceof Error ? error.message : String(error),
            hookName,
            toolUseID,
            hookEvent: 'PostToolUse',
          } as never),
        }
      }
    }
  } catch (error) {
    logError(error)
  }
}

/**
 * Adapt the post-tool-use-failure hook engine: the post-tool shape minus
 * output replacement and prevent-continuation (a failure path has nothing
 * left to prevent), plus the formatted error and the is-interrupt flag.
 */
export async function* runPostToolUseFailureHooks(
  tool: Tool,
  toolUseID: string,
  input: AnyObject,
  error: string,
  isInterrupt: boolean,
  toolUseContext: ToolUseContext,
  permissionMode: string | undefined,
  signal: AbortSignal | undefined,
  _seam: HookSeamArgs,
): AsyncGenerator<{ kind: 'message'; message: Message }> {
  const hookName = postToolFailureHookName(tool.name)
  try {
    for await (const result of executePostToolUseFailureHooks(
      tool.name,
      toolUseID,
      input,
      error,
      toolUseContext,
      isInterrupt,
      permissionMode,
      signal,
    )) {
      try {
        const attachment =
          result.message && result.message.type === 'attachment'
            ? (result.message.attachment as { type?: string })
            : undefined
        if (attachment?.type === 'hook_cancelled') {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              ...(result.message as AttachmentMessage).attachment,
              hookName,
              hookEvent: 'PostToolUseFailure',
            } as never),
          }
          continue
        }
        if (attachment?.type === 'hook_blocking_error') {
          continue
        }
        if (result.message) {
          yield { kind: 'message', message: result.message as Message }
        }
        if (result.blockingError) {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              type: 'hook_blocking_error',
              blockingError: result.blockingError,
              hookName,
              toolUseID,
              hookEvent: 'PostToolUseFailure',
            } as never),
          }
        }
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            kind: 'message',
            message: createAttachmentMessage({
              type: 'hook_additional_context',
              content: result.additionalContexts.join('\n'),
              hookName,
              toolUseID,
              hookEvent: 'PostToolUseFailure',
            } as never),
          }
        }
      } catch (perResultError) {
        logError(perResultError)
        yield {
          kind: 'message',
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            content:
              perResultError instanceof Error
                ? perResultError.message
                : String(perResultError),
            hookName,
            toolUseID,
            hookEvent: 'PostToolUseFailure',
          } as never),
        }
      }
    }
  } catch (outerError) {
    logError(outerError)
  }
}

/**
 * Resolve a hook's permission verdict into the final decision — the
 * invariant this encapsulates: a hook allow does NOT bypass settings
 * deny/ask rules. Exported so any inner-call path resolves permissions
 * identically to the main transaction (the intended second consumer is the
 * REPL's tool wrappers, build-absent today — keep the sharing seam).
 */
export async function resolveHookPermissionDecision(
  hookResult: HookPermissionOutcome | undefined,
  tool: Tool,
  input: AnyObject,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{ decision: PermissionDecision; input: AnyObject }> {
  if (hookResult?.behavior === 'allow') {
    const effectiveInput = hookResult.updatedInput ?? input
    const interactionUnsatisfied =
      tool.requiresUserInteraction?.() === true && hookResult.updatedInput === undefined
    if (interactionUnsatisfied || context.alwaysCallCanUseTool) {
      // A hook that provided updated input for an interactive tool IS the
      // user interaction (a headless wrapper that collected the answers);
      // without one, the dialog is still owed.
      const decision = await canUseTool(
        tool,
        effectiveInput,
        context,
        assistantMessage,
        toolUseID,
      )
      return { decision, input: effectiveInput }
    }
    const ruleObjection = await checkRuleBasedPermissions(tool, effectiveInput, context)
    if (ruleObjection === null) {
      return {
        decision: {
          behavior: 'allow',
          updatedInput: effectiveInput,
          ...(hookResult.decisionReason !== undefined
            ? { decisionReason: hookResult.decisionReason }
            : {}),
        } as PermissionDecision,
        input: effectiveInput,
      }
    }
    if (ruleObjection.behavior === 'deny') {
      // A settings deny rule overrides the hook's allow.
      return { decision: ruleObjection, input: effectiveInput }
    }
    // An ask rule requires the dialog despite hook approval.
    const decision = await canUseTool(
      tool,
      effectiveInput,
      context,
      assistantMessage,
      toolUseID,
    )
    return { decision, input: effectiveInput }
  }

  if (hookResult?.behavior === 'deny') {
    return {
      decision: {
        behavior: 'deny',
        message: hookResult.message,
        ...(hookResult.decisionReason !== undefined
          ? { decisionReason: hookResult.decisionReason }
          : {}),
      } as PermissionDecision,
      input,
    }
  }

  // No hook decision, or a hook ask: the normal permission flow — a hook
  // ask rides along as the forced decision so the dialog shows its message,
  // and its updated input (if any) is what the callback receives.
  const inputForCallback = hookResult?.updatedInput ?? input
  const forcedDecision =
    hookResult?.behavior === 'ask'
      ? ({
          behavior: 'ask',
          ...(hookResult.message !== undefined ? { message: hookResult.message } : {}),
          ...(hookResult.updatedInput !== undefined
            ? { updatedInput: hookResult.updatedInput }
            : {}),
          ...(hookResult.decisionReason !== undefined
            ? { decisionReason: hookResult.decisionReason }
            : {}),
        } as PermissionDecision)
      : undefined
  const decision = await canUseTool(
    tool,
    inputForCallback,
    context,
    assistantMessage,
    toolUseID,
    forcedDecision,
  )
  return { decision, input: inputForCallback }
}
