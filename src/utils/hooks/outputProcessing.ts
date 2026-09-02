// Hook output processing — JSON validation against the zod schema, the
// stdout/HTTP-body parsers (schema-hint errors for command hooks), the
// sync-JSON → HookResult projection (per-event hookSpecificOutput routing,
// permission decisions, elicitation actions), and the elicitation output
// parser. Owned Mercury module.

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

/**
 * Run a raw JSON string through the hook-output zod schema. A pass returns
 * the typed output; a fail returns one message that names every offending
 * path and echoes the payload, so a hook author can see exactly what the
 * harness rejected.
 */
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

/**
 * Interpret a command hook's stdout. Anything that does not open a JSON
 * object stays plain text (the classic exit-code protocol); an object that
 * fails the schema keeps its text form AND carries a validation error with
 * the expected shape spelled out, so a mistyped field never silently
 * downgrades to prose.
 */
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
    // Command hooks get the full shape reference appended — their authors
    // edit shell scripts, not typed code, and the schema is the only spec
    // they will see at failure time.
    const errorMessage = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"approve" | "block" (optional)',
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

/**
 * Interpret an HTTP hook's response body. The contract is stricter than
 * stdout: JSON or nothing. An empty body counts as `{}` (a hook that has
 * nothing to say), and any non-JSON body is a validation error — there is
 * no plain-text lane on this transport.
 */
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

/**
 * Project a validated sync JSON output onto the HookResult fields the
 * engine aggregates. Three layers, applied in order:
 *
 *   1. transport-wide fields — continue/stopReason, the legacy top-level
 *      approve/block decision, systemMessage;
 *   2. the event-specific hookSpecificOutput, dispatched on its
 *      hookEventName (after that name is checked against the event the
 *      engine actually ran — a hook answering for the wrong event is a
 *      loud error, not a silent merge);
 *   3. the attachment message: a blocking error becomes the model-facing
 *      hook_blocking_error, anything else a content-less hook_success.
 *
 * An unknown decision or permissionDecision throws — fail loud, the engine
 * surfaces it as a non-blocking hook error rather than guessing.
 */
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

  // Layer 1 — transport-wide fields.
  if (json.continue === false) {
    result.preventContinuation = true
    if (json.stopReason) {
      result.stopReason = json.stopReason
    }
  }

  if (json.decision) {
    switch (json.decision) {
      case 'approve':
        result.permissionBehavior = 'allow'
        break
      case 'block':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      default:
        throw new Error(
          `Unknown hook decision type: ${json.decision}. Valid types are: approve, block`,
        )
    }
  }

  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  // A top-level reason accompanies whichever decision was just made.
  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  // Layer 2 — the event-specific output.
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
        // The event-specific reason outranks the top-level one, but its
        // absence never erases it: a hook pairing permissionDecision with a
        // top-level reason keeps that reason (pre-rewrite this arm clobbered
        // it to undefined), and the same top-level fallback applies when the
        // arm itself just decided.
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
        // The decision object is the verdict; permissionBehavior mirrors it
        // so aggregation sees one consistent field either way.
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

  // Layer 3 — the attachment the transcript machinery consumes.
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
          // JSON-output hooks contribute context through additionalContext →
          // hook_additional_context. Content stays empty on purpose: the
          // success renderer suppresses empty-content entries, so no turn is
          // polluted with a bare "hook success" reminder.
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}

/**
 * The non-REPL elicitation lane: read one HookOutsideReplResult and pull
 * out an elicitation response and/or blocking error, honoring the same
 * protocol as the engine path — exit code 2 blocks; a `decision: 'block'`
 * on exit 0 blocks; a decline action carries a blocking error beside its
 * response. Unparseable or off-event output contributes nothing.
 */
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
