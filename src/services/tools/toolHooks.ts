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


function preToolHookName(toolName: string): string {
  return `PreToolUse:${toolName}`
}
function postToolHookName(toolName: string): string {
  return `PostToolUse:${toolName}`
}
function postToolFailureHookName(toolName: string): string {
  return `PostToolUseFailure:${toolName}`
}

export type HookPermissionOutcome = {
  behavior: 'allow' | 'ask' | 'deny'
  updatedInput?: AnyObject
  message?: string
  decisionReason?: PermissionDecisionReason
}

export type PreToolUseHookItem =
  | { kind: 'message'; message: Message }
  | { kind: 'permissionResult'; result: HookPermissionOutcome }
  | { kind: 'updatedInput'; updatedInput: AnyObject }
  | { kind: 'preventContinuation' }
  | { kind: 'stopReason'; stopReason: string }
  | { kind: 'additionalContext'; message: AttachmentMessage }
  | { kind: 'stop' }

type HookSeamArgs = {
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
    logError(error)
    yield { kind: 'stop' }
  }
}

export type PostToolUseHooksResult<Output> =
  | { kind: 'message'; message: Message }
  | { kind: 'updatedOutput'; output: Output }

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
      return { decision: ruleObjection, input: effectiveInput }
    }
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
