
import type {
  HookEvent,
  HookJSONOutput,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import { createAttachmentMessage } from '../attachments.js'
import { logForDebugging } from '../debug.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { hookJSONOutputSchema } from '../../types/hooks.js'
import { isAsyncHookJSONOutput, isSyncHookJSONOutput } from '../../types/hooks.js'
import type {
  ElicitationResponse,
  HookBlockingError,
  HookOutsideReplResult,
  HookResult,
} from './types.js'

export function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    logForDebugging('Successfully parsed and validated hook JSON output')
    return { json: validation.data }
  }
  const errors = validation.error.issues
    .map(err => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

export function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    logForDebugging('Hook output does not start with {, treating as plain text')
    return { plainText: stdout }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    const errorMessage = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"block" (optional; never on PreToolUse — that event answers with hookSpecificOutput.permissionDecision)',
        reason: 'string (optional)',
        systemMessage: 'string (optional)',
        permissionDecision: '"allow" | "deny" | "ask" (optional)',
        hookSpecificOutput: {
          'for PreToolUse': {
            hookEventName: '"PreToolUse"',
            permissionDecision: '"allow" | "deny" | "ask" (optional)',
            permissionDecisionReason: 'string (optional)',
            updatedInput: 'object (optional) - Modified tool input to use',
          },
          'for UserPromptSubmit': {
            hookEventName: '"UserPromptSubmit"',
            additionalContext: 'string (required)',
          },
          'for PostToolUse': {
            hookEventName: '"PostToolUse"',
            additionalContext: 'string (optional)',
          },
        },
      },
      null,
      2,
    )}`
    logForDebugging(errorMessage)
    return { plainText: stdout, validationError: errorMessage }
  } catch (e) {
    logForDebugging(`Failed to parse hook output as JSON: ${e}`)
    return { plainText: stdout }
  }
}

export function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      logForDebugging(
        'HTTP hook returned empty body, treating as empty JSON object',
      )
      return { json: validation.data }
    }
  }

  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed}`
    logForDebugging(validationError)
    return { validationError }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    logForDebugging(result.validationError)
    return result
  } catch (e) {
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${e}`
    logForDebugging(validationError)
    return { validationError }
  }
}

export function processHookJSONOutput({
  json,
  command,
  hookName,
  toolUseID,
  hookEvent,
  expectedHookEvent,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: {
  json: SyncHookJSONOutput
  command: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  expectedHookEvent?: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}): Partial<HookResult> {
  const result: Partial<HookResult> = {}

  if (json.continue === false) {
    result.preventContinuation = true
    if (json.stopReason) {
      result.stopReason = json.stopReason
    }
  }

  if (json.decision !== undefined) {
    if (json.decision !== 'block') {
      throw new Error(`Unknown hook decision: ${String(json.decision)}. The one decision is block`)
    }
    if (hookEvent === 'PreToolUse') {
      throw new Error(
        'A PreToolUse hook answers with hookSpecificOutput.permissionDecision (allow, deny or ask); a top-level decision is not read on this event',
      )
    }
    result.permissionBehavior = 'deny'
    result.blockingError = {
      blockingError: json.reason || 'Blocked by hook',
      command,
    }
  }

  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  if (json.hookSpecificOutput) {
    if (
      expectedHookEvent &&
      json.hookSpecificOutput.hookEventName !== expectedHookEvent
    ) {
      throw new Error(
        `Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'. Full stdout: ${jsonStringify(json, null, 2)}`,
      )
    }

    switch (json.hookSpecificOutput.hookEventName) {
      case 'PreToolUse': {
        const specific = json.hookSpecificOutput
        if (specific.permissionDecision) {
          switch (specific.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow'
              break
            case 'deny':
              result.permissionBehavior = 'deny'
              result.blockingError = {
                blockingError:
                  specific.permissionDecisionReason ||
                  json.reason ||
                  'Blocked by hook',
                command,
              }
              break
            case 'ask':
              result.permissionBehavior = 'ask'
              break
            default:
              throw new Error(
                `Unknown hook permissionDecision type: ${specific.permissionDecision}. Valid types are: allow, deny, ask`,
              )
          }
        }
        result.hookPermissionDecisionReason =
          specific.permissionDecisionReason ??
          result.hookPermissionDecisionReason ??
          (result.permissionBehavior !== undefined ? json.reason : undefined)
        if (specific.updatedInput) {
          result.updatedInput = specific.updatedInput
        }
        result.additionalContext = specific.additionalContext
        break
      }
      case 'UserPromptSubmit':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SessionStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
        if (
          'watchPaths' in json.hookSpecificOutput &&
          json.hookSpecificOutput.watchPaths
        ) {
          result.watchPaths = json.hookSpecificOutput.watchPaths
        }
        break
      case 'Setup':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SubagentStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PostToolUse':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        if (json.hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput =
            json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'PermissionRequest':
        if (json.hookSpecificOutput.decision) {
          result.permissionRequestResult = json.hookSpecificOutput.decision
          result.permissionBehavior =
            json.hookSpecificOutput.decision.behavior === 'allow'
              ? 'allow'
              : 'deny'
          if (
            json.hookSpecificOutput.decision.behavior === 'allow' &&
            json.hookSpecificOutput.decision.updatedInput
          ) {
            result.updatedInput = json.hookSpecificOutput.decision.updatedInput
          }
        }
        break
      case 'Elicitation':
        if (json.hookSpecificOutput.action) {
          result.elicitationResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation denied by hook',
              command,
            }
          }
        }
        break
      case 'ElicitationResult':
        if (json.hookSpecificOutput.action) {
          result.elicitationResultResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError:
                json.reason || 'Elicitation result blocked by hook',
              command,
            }
          }
        }
        break
    }
  }

  return {
    ...result,
    message: result.blockingError
      ? createAttachmentMessage({
          type: 'hook_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          blockingError: result.blockingError,
        })
      : createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID,
          hookEvent,
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}

export function parseElicitationHookOutput(
  result: HookOutsideReplResult,
  expectedEventName: 'Elicitation' | 'ElicitationResult',
): {
  response?: ElicitationResponse
  blockingError?: HookBlockingError
} {
  if (result.blocked && !result.succeeded) {
    return {
      blockingError: {
        blockingError: result.output || `Elicitation blocked by hook`,
        command: result.command,
      },
    }
  }

  if (!result.output.trim()) {
    return {}
  }

  const trimmed = result.output.trim()
  if (!trimmed.startsWith('{')) {
    return {}
  }

  try {
    const parsed = hookJSONOutputSchema().parse(JSON.parse(trimmed))
    if (isAsyncHookJSONOutput(parsed)) {
      return {}
    }
    if (!isSyncHookJSONOutput(parsed)) {
      return {}
    }

    if (parsed.decision === 'block' || result.blocked) {
      return {
        blockingError: {
          blockingError: parsed.reason || 'Elicitation blocked by hook',
          command: result.command,
        },
      }
    }

    const specific = parsed.hookSpecificOutput
    if (!specific || specific.hookEventName !== expectedEventName) {
      return {}
    }

    if (!specific.action) {
      return {}
    }

    const response: ElicitationResponse = {
      action: specific.action,
      content: specific.content as ElicitationResponse['content'] | undefined,
    }

    const out: {
      response?: ElicitationResponse
      blockingError?: HookBlockingError
    } = { response }

    if (specific.action === 'decline') {
      out.blockingError = {
        blockingError:
          parsed.reason ||
          (expectedEventName === 'Elicitation'
            ? 'Elicitation denied by hook'
            : 'Elicitation result blocked by hook'),
        command: result.command,
      }
    }

    return out
  } catch {
    return {}
  }
}
