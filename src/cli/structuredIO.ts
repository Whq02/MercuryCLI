// ============================================================================
//  src/cli/structuredIO.ts — the structured stdio protocol layer: the wire
//  between Mercury and its SDK host.
//
//  Owns line framing, prepended turns, message classification, the
//  request/response correlation (with the duplicate/orphan/abort/close
//  laws), the SDK permission channel's hook-vs-host race, hook callbacks,
//  elicitation, sandbox network asks and the SDK-MCP relay. Every stdout
//  envelope leaves through ndjsonSafeStringify; requests ride the one
//  outbound FIFO so they can never overtake queued stream events.
// ============================================================================
import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import type { z } from 'zod/v4'
import type { ElicitResult } from '../services/mcp/sdk.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import {
  HookJSONOutputSchema,
  PermissionResultSchema,
} from '../entrypoints/sdk/coreSchemas.js'
import { SDKControlElicitationResponseSchema } from '../entrypoints/sdk/controlSchemas.js'
import type { JSONRPCMessage } from '../services/mcp/sdk.js'
import type {
  ControlErrorResponse,
  ControlResponse,
  SDKControlRequest,
  SDKControlResponse,
  SDKUserMessage,
  StdinMessage,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { HookCallback, PermissionRequestResult } from '../types/hooks.js'
import type { HookInput, HookJSONOutput } from '../entrypoints/agentSdkTypes.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionUpdate,
} from '../types/permissions.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { executePermissionRequestHooks } from '../utils/hooks.js'
import { logError } from '../utils/log.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { encodeDecisionReasonForWire } from '../utils/permissions/decisionReasonWire.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../utils/permissions/PermissionUpdate.js'
import type { SessionExternalMetadata } from '../utils/sessionState.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
} from '../utils/sessionState.js'
import { Stream } from '../utils/stream.js'

/** The synthetic tool name sandbox network asks ride on (contract data). */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess'

const RESOLVED_TOOL_USE_CAP = 1000

class AbortError extends Error {
  constructor(message = 'Request was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

/** Insertion-ordered bounded set: oldest evicted at the cap. */
class BoundedSet {
  readonly #set = new Set<string>()
  constructor(private readonly cap: number) {}
  add(value: string): void {
    if (this.#set.has(value)) return
    this.#set.add(value)
    if (this.#set.size > this.cap) {
      const oldest = this.#set.values().next().value
      if (oldest !== undefined) this.#set.delete(oldest)
    }
  }
  has(value: string): boolean {
    return this.#set.has(value)
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  schema: z.ZodType | undefined
  toolUseID: string | undefined
  cleanup: () => void
}

function fatalProtocolError(reason: string): never {
  // writeSync: a win32 TTY stream write is async and process.exit can
  // discard it — a fatal protocol error must never exit silent (the
  // failLoud discipline).
  try {
    writeSync(2, `${reason}\n`)
  } catch {
    /* a closed fd must not mask the exit */
  }
  process.exit(1)
}

/** Reasons whose text rides the wire; structural reasons contribute none. */
function serializeDecisionReason(reason: unknown): string | undefined {
  if (!reason || typeof reason !== 'object') return undefined
  const typed = reason as { type?: string; reason?: string; hookName?: string }
  switch (typed.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResult':
    case 'permissionPromptTool':
      return undefined
    default: {
      if (typeof typed.reason === 'string' && typed.reason.length > 0) {
        return typed.reason
      }
      return undefined
    }
  }
}

/** The ONE broken-pipe sentence every output format shares (FC-077). */
export const BROKEN_STDOUT_LINE =
  "stdout closed before the run's output was delivered (broken pipe) — the undelivered output is lost; the session transcript is intact"

/** A write failure meaning the CONSUMER is gone (not a product fault):
 *  EPIPE from the OS, or node's own destroyed/ended-stream spellings. */
export function isBrokenPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

export class StructuredIO {
  /** The parsed input stream. */
  readonly structuredInput: AsyncGenerator<StdinMessage, void, unknown>
  /** The single outbound FIFO every writer enqueues to. */
  readonly outbound: Stream<StdoutMessage> = new Stream<StdoutMessage>()
  /** Assigned by the remote transport subclass; must resolve by default. */
  restoredWorkerState: Promise<SessionExternalMetadata | null> =
    Promise.resolve(null)

  readonly #replayUserMessages: boolean
  #inputClosed = false
  readonly #prepended: string[] = []
  readonly #pending = new Map<string, PendingRequest>()
  readonly #pendingCanUseTool = new Map<string, SDKControlRequest>()
  readonly #resolvedToolUses = new BoundedSet(RESOLVED_TOOL_USE_CAP)
  #onUnexpectedResponse:
    | ((response: SDKControlResponse['response']) => Promise<void>)
    | undefined
  #onControlRequestSent: ((request: SDKControlRequest) => void) | undefined
  #onControlRequestResolved: ((requestId: string) => void) | undefined

  constructor(
    input: AsyncIterable<string>,
    replayUserMessages?: boolean,
  ) {
    this.#replayUserMessages = replayUserMessages ?? false
    this.structuredInput = this.#createInputStream(input)
  }

  // ── framing + prepends ────────────────────────────────────

  /** Queue a synthetic user turn; it lands before the next input message. */
  prependUserMessage(content: string): void {
    this.#prepended.push(content)
  }

  #takePrepended(): SDKUserMessage[] {
    const taken = this.#prepended.splice(0, this.#prepended.length)
    return taken.map(content => ({
      type: 'user' as const,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    })) as SDKUserMessage[]
  }

  async *#createInputStream(
    input: AsyncIterable<string>,
  ): AsyncGenerator<StdinMessage, void, unknown> {
    let buffer = ''
    // The pre-iteration pass: with no chunk ever arriving, prepended turns
    // would otherwise be lost.
    yield* this.#takePrepended()
    try {
      for await (const chunk of input) {
        buffer += chunk
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          if (line.trim().length > 0) {
            const message = await this.#classifyLine(line, true)
            // The prepend check runs between every yielded message, not once
            // per chunk — a mid-stream prepend must beat the next message
            // already sitting in the same buffer block.
            yield* this.#takePrepended()
            if (message !== undefined) yield message
          }
          newlineIndex = buffer.indexOf('\n')
        }
        yield* this.#takePrepended()
      }
      // The final unterminated line still processes — without the per-line
      // diagnostic event (deliberate asymmetry).
      if (buffer.trim().length > 0) {
        const message = await this.#classifyLine(buffer, false)
        yield* this.#takePrepended()
        if (message !== undefined) yield message
      }
      yield* this.#takePrepended()
    } finally {
      this.#closeInput()
    }
  }

  // ── classification ──────────────────────────────────────────────

  async #classifyLine(
    line: string,
    emitDiagnostic: boolean,
  ): Promise<StdinMessage | undefined> {
    // The guard wraps the WHOLE of classification — including the awaited
    // orphan callback — so any failure here is a fatal protocol error
    // rather than an unhandled rejection.
    try {
      const parsed = normalizeControlMessageKeys(JSON.parse(line)) as {
        type?: string
        [key: string]: unknown
      }
      if (emitDiagnostic) {
        logForDiagnosticsNoPII('debug', 'headless_stdin_message', {
          type: parsed.type ?? 'unknown',
        })
      }
      // The five wire-shape assertions below are the ONE stdin trust
      // boundary: lines come JSON-parsed from the SDK caller, each arm makes
      // its minimal structural check, and the payload is trusted from there
      // (the schemas validate replies, not this inbound stream).
      switch (parsed.type) {
        case 'keep_alive':
          return undefined
        case 'update_environment_variables': {
          const variables = (parsed.variables ?? {}) as Record<string, string>
          for (const [key, value] of Object.entries(variables)) {
            process.env[key] = value
          }
          logForDebugging(
            `update_environment_variables applied: ${Object.keys(variables).join(', ')}`,
          )
          return undefined
        }
        case 'control_response': {
          const known = await this.#handleControlResponse(
            parsed as unknown as SDKControlResponse & { uuid?: string },
          )
          if (this.#replayUserMessages && known) {
            return parsed as unknown as StdinMessage
          }
          return undefined
        }
        case 'control_request': {
          if (!(parsed as { request?: unknown }).request) {
            fatalProtocolError('Error: control_request is missing its request body')
          }
          return parsed as unknown as StdinMessage
        }
        case 'assistant':
        case 'system':
          return parsed as unknown as StdinMessage
        case 'user': {
          const role = (parsed as { message?: { role?: string } }).message?.role
          if (role !== 'user') {
            fatalProtocolError(
              `Error: expected message role 'user', got '${String(role)}'`,
            )
          }
          return parsed as unknown as StdinMessage
        }
        default:
          logForDebugging(`unknown stdin message type dropped: ${String(parsed.type)}`)
          return undefined
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'FatalExit') throw error
      fatalProtocolError(
        `Error parsing stdin line: ${line}\n${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // ── correlation ─────────────────────────────────────────────────

  setUnexpectedResponseCallback(
    cb: (response: SDKControlResponse['response']) => Promise<void>,
  ): void {
    this.#onUnexpectedResponse = cb
  }

  setOnControlRequestSent(
    cb: ((request: SDKControlRequest) => void) | undefined,
  ): void {
    this.#onControlRequestSent = cb
  }

  setOnControlRequestResolved(
    cb: ((requestId: string) => void) | undefined,
  ): void {
    this.#onControlRequestResolved = cb
  }

  getPendingPermissionRequests(): SDKControlRequest[] {
    return [...this.#pendingCanUseTool.values()]
  }

  /** Returns whether the response matched a known pending request. */
  async #handleControlResponse(
    message: SDKControlResponse & { uuid?: string },
  ): Promise<boolean> {
    const response = message.response as ControlResponse | ControlErrorResponse
    // Every control_response — matched, duplicate, or orphan — closes the
    // command lifecycle for the uuid the host injected as a TOP-LEVEL field
    // on the response message.
    if (typeof message.uuid === 'string' && message.uuid.length > 0) {
      notifyCommandLifecycle(message.uuid, 'completed')
    }
    const requestId = response?.request_id
    const pending = requestId !== undefined ? this.#pending.get(requestId) : undefined
    if (!pending) {
      // The duplicate guard reads the tool-use id from SUCCESS payloads
      // only; error-subtype orphans always reach the callback.
      if (response?.subtype === 'success') {
        const toolUseID = (response.response as { toolUseID?: string } | undefined)
          ?.toolUseID
        if (typeof toolUseID === 'string' && this.#resolvedToolUses.has(toolUseID)) {
          logForDebugging(
            `dropping duplicate control_response for already-resolved tool_use ${toolUseID}`,
          )
          return false
        }
      }
      // Awaited inside the classification guard — a rejection is fatal.
      await this.#onUnexpectedResponse?.(response)
      return false
    }
    try {
      if (pending.toolUseID !== undefined) {
        this.#resolvedToolUses.add(pending.toolUseID)
      }
      if (response.subtype === 'error') {
        pending.reject(new Error(response.error))
      } else if (pending.schema) {
        try {
          pending.resolve(pending.schema.parse(response.response ?? {}))
        } catch (schemaError) {
          pending.reject(
            schemaError instanceof Error
              ? schemaError
              : new Error(String(schemaError)),
          )
        }
      } else {
        pending.resolve({})
      }
      if (this.#pendingCanUseTool.has(response.request_id)) {
        this.#onControlRequestResolved?.(response.request_id)
      }
    } finally {
      pending.cleanup()
    }
    return true
  }

  /** Enqueue a control request on the outbound FIFO and await its reply. */
  sendRequest(
    request: Record<string, unknown>,
    schema?: z.ZodType,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<unknown> {
    if (this.#inputClosed) {
      return Promise.reject(new Error('Stream closed'))
    }
    if (signal?.aborted) {
      return Promise.reject(new AbortError('Request aborted before send'))
    }
    const envelope: SDKControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request: request as SDKControlRequest['request'],
    }
    return new Promise((resolve, reject) => {
      const toolUseID =
        (request as { tool_use_id?: string }).tool_use_id ?? undefined
      const onAbort = (): void => {
        // Cancel on the wire, immunize the tool-use against a late host
        // answer, and reject immediately without waiting for the host.
        this.outbound.enqueue({
          type: 'control_cancel_request',
          request_id: requestId,
        })
        if (toolUseID !== undefined) this.#resolvedToolUses.add(toolUseID)
        const pending = this.#pending.get(requestId)
        pending?.cleanup()
        reject(new AbortError('Tool permission request was aborted'))
      }
      const cleanup = (): void => {
        this.#pending.delete(requestId)
        this.#pendingCanUseTool.delete(requestId)
        signal?.removeEventListener('abort', onAbort)
      }
      this.#pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        schema,
        toolUseID,
        cleanup,
      })
      if ((request as { subtype?: string }).subtype === 'can_use_tool') {
        this.#pendingCanUseTool.set(requestId, envelope)
        this.#onControlRequestSent?.(envelope)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      // Enqueued, never written directly: stream events already queued must
      // reach the host before a request issued after them.
      this.outbound.enqueue(envelope)
    })
  }

  #closeInput(): void {
    if (this.#inputClosed) return
    this.#inputClosed = true
    for (const [requestId, pending] of [...this.#pending]) {
      pending.reject(
        new Error(
          `Permission stream closed before response was received for request ${requestId}`,
        ),
      )
      pending.cleanup()
    }
  }

  // ── injected responses ──────────────────────────────────────────

  /** Resolve a pending request out of band and cancel the host's copy. */
  injectControlResponse(response: SDKControlResponse): void {
    const inner = response.response as ControlResponse | ControlErrorResponse
    const requestId = inner?.request_id
    if (!requestId) return
    const pending = this.#pending.get(requestId)
    if (!pending) return
    try {
      if (pending.toolUseID !== undefined) {
        this.#resolvedToolUses.add(pending.toolUseID)
      }
      if (inner.subtype === 'error') {
        pending.reject(new Error(inner.error))
      } else if (pending.schema) {
        try {
          pending.resolve(pending.schema.parse(inner.response ?? {}))
        } catch (schemaError) {
          pending.reject(
            schemaError instanceof Error
              ? schemaError
              : new Error(String(schemaError)),
          )
        }
      } else {
        pending.resolve({})
      }
    } finally {
      pending.cleanup()
    }
    // The SDK host's own permission callback must be aborted rather than
    // left hanging.
    void this.write({
      type: 'control_cancel_request',
      request_id: requestId,
    })
  }

  // ── stdout writer ──────────────────────────────────────────────────────

  /** Once stdout's consumer is gone every later write is waste; the latch
   *  makes the outcome ONE thing across formats (FC-077): a named stderr
   *  line and exit code 1 — instead of a raw libuv crash under text/json
   *  and a silent exit-0 loss under stream-json (whose writes were
   *  fire-and-forget). Reads as a plain fact for the final-output path. */
  stdoutPipeBroken = false

  markStdoutPipeBroken(): void {
    if (this.stdoutPipeBroken) return
    this.stdoutPipeBroken = true
    process.exitCode = 1
    try {
      process.stderr.write(`${BROKEN_STDOUT_LINE}\n`)
    } catch {
      /* stderr may be gone too — the exit code still carries the verdict */
    }
  }

  /** Serialize NDJSON-safely and write one line to stdout. A broken-pipe
   *  class error latches (see above) and RESOLVES — the caller's road winds
   *  down normally with the exit code already set; every other write error
   *  still rejects. */
  write(message: StdoutMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stdoutPipeBroken) return resolve()
      process.stdout.write(`${ndjsonSafeStringify(message)}\n`, error => {
        if (error) {
          if (isBrokenPipeError(error)) {
            this.markStdoutPipeBroken()
            return resolve()
          }
          return reject(error)
        }
        resolve()
      })
    })
  }

  // ── the SDK permission channel ──────────────────────────────────

  createCanUseTool(
    onPermissionPrompt?: (details: RequiresActionDetails) => void,
  ): CanUseToolFn {
    const canUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const requestId = randomUUID()
      const parentSignal = toolUseContext.abortController.signal
      const requestController = new AbortController()
      const forwardParentAbort = (): void => requestController.abort()
      parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
      try {
        const engineResult = (forceDecision ??
          (await hasPermissionsToUseTool(
            tool,
            input,
            toolUseContext,
            assistantMessage,
            toolUseID,
          ))) as PermissionDecision
        if (
          engineResult.behavior === 'allow' ||
          engineResult.behavior === 'deny'
        ) {
          // Short-circuit: no control request goes out and permission hooks
          // never run.
          return engineResult
        }

        // The permission mode is read at hook-start time, never captured
        // earlier.
        const permissionMode = (
          toolUseContext.getAppState() as {
            toolPermissionContext: { mode: string }
          }
        ).toolPermissionContext.mode
        const askResult = engineResult as {
          suggestions?: PermissionUpdate[]
          blockedPath?: string
          decisionReason?: PermissionDecisionReason
        }

        onPermissionPrompt?.({
          tool_name: tool.name,
          action_description: this.#describeToolAction(tool as Tool, input),
          tool_use_id: toolUseID,
          request_id: requestId,
          input,
        })

        // The hook chain and the host request start concurrently; whichever
        // settles first wins.
        const hookDecisionPromise = (async (): Promise<PermissionRequestResult | null> => {
          for await (const result of executePermissionRequestHooks(
            tool.name,
            toolUseID,
            input,
            toolUseContext,
            permissionMode,
            askResult.suggestions,
            parentSignal,
          )) {
            const decision = result.permissionRequestResult
            if (decision) {
              // Only the first decision-carrying result is taken.
              return decision
            }
          }
          return null
        })()

        // The reason crosses twice: the plain-text form any host reads, and
        // the STRUCTURED form (the matched rule, the mode, a hook, a safety
        // check, a compound command's per-part verdicts) so a host that
        // paints Mercury's own consent card explains the ask exactly as
        // the session started at boot would.
        const reasonOnWire = encodeDecisionReasonForWire(askResult.decisionReason)
        const requestPromise = this.sendRequest(
          {
            subtype: 'can_use_tool',
            tool_name: tool.name,
            input,
            ...(askResult.suggestions && askResult.suggestions.length > 0
              ? { permission_suggestions: askResult.suggestions }
              : {}),
            ...(askResult.blockedPath !== undefined
              ? { blocked_path: askResult.blockedPath }
              : {}),
            ...(serializeDecisionReason(askResult.decisionReason) !== undefined
              ? { decision_reason: serializeDecisionReason(askResult.decisionReason) }
              : {}),
            ...(reasonOnWire !== undefined ? { decision_reason_detail: reasonOnWire } : {}),
            tool_use_id: toolUseID,
            ...(toolUseContext.agentId !== undefined
              ? { agent_id: toolUseContext.agentId }
              : {}),
          },
          PermissionResultSchema(),
          requestController.signal,
          requestId,
        )

        const raceOutcome = await Promise.race([
          hookDecisionPromise.then(decision => ({ source: 'hook' as const, decision })),
          requestPromise.then(result => ({ source: 'host' as const, result })),
        ])

        if (raceOutcome.source === 'hook' && raceOutcome.decision) {
          const hookDecision = raceOutcome.decision
          // Abort the pending host request; its expected abort rejection is
          // suppressed.
          requestController.abort()
          requestPromise.catch(() => {})
          if (hookDecision.behavior === 'allow') {
            if (hookDecision.updatedPermissions?.length) {
              // Persisted and applied to the live permission context; the
              // app-state write is skipped when the update is identity.
              persistPermissionUpdates(hookDecision.updatedPermissions)
              toolUseContext.setAppState(previous => {
                const updated = applyPermissionUpdates(
                  previous.toolPermissionContext,
                  hookDecision.updatedPermissions ?? [],
                )
                return updated === previous.toolPermissionContext
                  ? previous
                  : { ...previous, toolPermissionContext: updated }
              })
            }
            return {
              behavior: 'allow',
              updatedInput: hookDecision.updatedInput ?? input,
              userModified: false,
              decisionReason: {
                type: 'hook',
                hookName: 'PermissionRequest',
              },
            }
          }
          return {
            behavior: 'deny',
            message:
              hookDecision.message ??
              'The PermissionRequest hook denied this permission request',
            decisionReason: {
              type: 'hook',
              hookName: 'PermissionRequest',
            },
          }
        }

        // Either the hook passed through (wait on the host) or the host won
        // outright; a later hook result is ignored.
        const hostResult = (raceOutcome.source === 'host'
          ? raceOutcome.result
          : await requestPromise) as {
          behavior?: string
          message?: string
          updatedInput?: Record<string, unknown>
          updatedPermissions?: PermissionUpdate[]
          interrupt?: boolean
        }
        return this.#convertHostPermissionResult(
          hostResult,
          tool as Tool,
          input,
          toolUseContext,
        )
      } catch (error) {
        // Any thrown error in the band fails closed.
        return {
          behavior: 'deny',
          message: `Tool permission request failed: ${error instanceof Error ? error.message : String(error)}`,
          decisionReason: {
            type: 'other',
            reason: 'permission request failed',
          },
        }
      } finally {
        parentSignal.removeEventListener('abort', forwardParentAbort)
        if (this.#pendingCanUseTool.size === 0) {
          notifySessionStateChanged('running')
        }
      }
    }
    return canUseTool
  }

  /** The shared conversion for host permission answers. */
  #convertHostPermissionResult(
    result: {
      behavior?: string
      message?: string
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      interrupt?: boolean
    },
    tool: Tool,
    originalInput: Record<string, unknown>,
    toolUseContext: Pick<ToolUseContext, 'abortController' | 'setAppState'>,
  ): PermissionDecision {
    if (result.behavior === 'allow') {
      const updatedInput =
        result.updatedInput && Object.keys(result.updatedInput).length > 0
          ? result.updatedInput
          : originalInput
      if (result.updatedPermissions?.length) {
        // Persisted AND applied to the live permission context — "allow
        // always" from the focused chat's consent card sticks for the rest
        // of this session exactly as it does in the in-process engine (the
        // hook path applies the same way).
        const updates = result.updatedPermissions
        persistPermissionUpdates(updates)
        toolUseContext.setAppState(previous => {
          const updated = applyPermissionUpdates(previous.toolPermissionContext, updates)
          return updated === previous.toolPermissionContext
            ? previous
            : { ...previous, toolPermissionContext: updated }
        })
      }
      return {
        behavior: 'allow',
        updatedInput,
        userModified: false,
        decisionReason: {
          type: 'permissionPromptTool',
          permissionPromptToolName: tool.name,
          toolResult: result,
        },
      }
    }
    if (result.interrupt) {
      toolUseContext.abortController.abort()
    }
    return {
      behavior: 'deny',
      message: result.message ?? 'Permission denied by the SDK host',
      decisionReason: {
        type: 'permissionPromptTool',
        permissionPromptToolName: tool.name,
        toolResult: result,
      },
    }
  }

  /** Guarded action description: any accessor may throw on malformed input,
   *  and a throw must not break permission handling. */
  #describeToolAction(tool: Tool, input: Record<string, unknown>): string {
    try {
      const described =
        (tool as { getActivityDescription?: (i: unknown) => string | null })
          .getActivityDescription?.(input) ??
        (tool as { getToolUseSummary?: (i: unknown) => string | null })
          .getToolUseSummary?.(input) ??
        (tool as { userFacingName?: (i: unknown) => string }).userFacingName?.(
          input,
        )
      return described || tool.name
    } catch {
      return tool.name
    }
  }

  // ── hook callbacks ──────────────────────────────────────────────

  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
      // Carried through verbatim — enforcement belongs to the hooks engine.
      timeout,
      callback: async (
        hookInput: HookInput,
        toolUseID: string | null,
        abortSignal: AbortSignal | undefined,
      ): Promise<HookJSONOutput> => {
        try {
          const raw = await this.sendRequest(
            {
              subtype: 'hook_callback',
              callback_id: callbackId,
              input: hookInput,
              // A null OR EMPTY id drops from the wire object, never sent
              // null (the || projection is the wire contract).
              tool_use_id: toolUseID || undefined,
            },
            HookJSONOutputSchema(),
            abortSignal,
          )
          return raw as HookJSONOutput
        } catch (error) {
          // A failed host callback never blocks or denies.
          process.stderr.write(
            `Hook callback ${callbackId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          return {}
        }
      },
    }
  }

  // ── elicitation ─────────────────────────────────────────────────

  async handleElicitation(
    serverName: string,
    message: string,
    requestedSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    mode?: 'form' | 'url',
    url?: string,
    elicitationId?: string,
  ): Promise<ElicitResult> {
    try {
      const reply = await this.sendRequest(
        {
          subtype: 'elicitation',
          mcp_server_name: serverName,
          message,
          ...(mode !== undefined ? { mode } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(elicitationId !== undefined ? { elicitation_id: elicitationId } : {}),
          ...(requestedSchema !== undefined
            ? { requested_schema: requestedSchema }
            : {}),
        },
        SDKControlElicitationResponseSchema(),
        signal,
      )
      return reply as ElicitResult
    } catch (error) {
      logForDebugging(
        `elicitation for ${serverName} failed; resolving as cancel: ${error instanceof Error ? error.message : String(error)}`,
      )
      // An MCP server always gets a well-formed answer.
      return { action: 'cancel' } as ElicitResult
    }
  }

  // ── sandbox network asks ────────────────────────────────────────

  createSandboxAskCallback(): (ask: {
    host: string
    port?: number
  }) => Promise<boolean> {
    return async ask => {
      try {
        const result = (await this.sendRequest(
          {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            // Only the host rides the wire; the accepted port does not.
            input: { host: ask.host },
            tool_use_id: randomUUID(),
            description: `Allow network access to ${ask.host}?`,
          },
          PermissionResultSchema(),
        )) as { behavior?: string }
        return result.behavior === 'allow'
      } catch {
        // Fail closed.
        return false
      }
    }
  }

  // ── SDK-MCP relay ──────────────────────────────────────────────

  async sendMcpMessage(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> {
    const reply = (await this.sendRequest({
      subtype: 'mcp_message',
      server_name: serverName,
      message,
    })) as { mcp_response?: JSONRPCMessage }
    return reply.mcp_response as JSONRPCMessage
  }

  // ── remote-transport extension points ──────────────────────────

  async flushInternalEvents(): Promise<void> {
    // Overridden by the remote IO subclass; the base flush is immediate.
  }

  get internalEventsPending(): number {
    return 0
  }
}
