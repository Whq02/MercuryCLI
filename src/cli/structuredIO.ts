import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import type { z } from 'zod/v4'
import type { ElicitResult } from '../services/mcp/sdk.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { PermissionResultSchema } from '../entrypoints/sdk/coreSchemas.js'
import { HookJSONOutputSchema, type HookInput, type HookJSONOutput } from '../utils/hooks/contract.js'
import { SDKControlElicitationResponseSchema } from '../entrypoints/sdk/controlSchemas.js'
import type { JSONRPCMessage } from '../services/mcp/sdk.js'
import type {
  ControlErrorResponse,
  ControlResponse,
  SDKControlRequest,
  SDKControlResponse,
  SDKUserMessage,
  StdinMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { SDKControlCancelRequest } from '../entrypoints/sdk/controlTypes.js'
import { createRowStamper, type RowDraft } from '../rows/project.js'
import type { Row } from '../rows/vocabulary.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { HookCallback } from '../types/hooks.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { UNANSWERED_ASK_REJECT_MESSAGE } from '../utils/messages/rejectionText.js'
import { stripBOM } from '../utils/jsonRead.js'
import type { RequiresActionDetails } from '../utils/sessionState.js'
import { Stream } from '../utils/stream.js'
import type { PermissionAnswer, PermissionRequestParams } from '../runner/wire/methods.js'
import {
  PERMISSION_CHANNEL_CLOSED_CAUSE,
  SANDBOX_NETWORK_ACCESS_TOOL_NAME,
  createHostCanUseTool,
  createSandboxAsk,
  type AskChannel,
} from './headless/runnerAsks.js'

const RESOLVED_TOOL_USE_CAP = 1000

class AbortError extends Error {
  constructor(message = 'Request was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

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
  try {
    writeSync(2, `${reason}\n`)
  } catch {
  }
  process.exit(1)
}

export const BROKEN_STDOUT_LINE =
  "stdout closed before the run's output was delivered (broken pipe) — the undelivered output is lost; the session transcript is intact"

export function isBrokenPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

export type ControlLine = SDKControlRequest | SDKControlResponse | SDKControlCancelRequest
export type TransitionalLine = { type: 'system'; subtype: 'seat_verb_applied' | 'elicitation_complete'; [key: string]: unknown }
export type OutboundLine = RowDraft | ControlLine | TransitionalLine
export type WireLine = Row | ControlLine | TransitionalLine

const CONTROL_LINE_TYPES: ReadonlySet<string> = new Set(['control_request', 'control_response', 'control_cancel_request'])

export function isControlLine(line: OutboundLine): line is ControlLine {
  return CONTROL_LINE_TYPES.has((line as { type: string }).type)
}

export function isRowLine(line: OutboundLine): line is RowDraft {
  return !isControlLine(line) && (line as { type: string }).type !== 'system'
}

export { PERMISSION_CHANNEL_CLOSED_CAUSE, SANDBOX_NETWORK_ACCESS_TOOL_NAME, unansweredAskCause } from './headless/runnerAsks.js'

export class StructuredIO implements AskChannel {
  readonly structuredInput: AsyncGenerator<StdinMessage, void, unknown>
  readonly outbound: Stream<OutboundLine> = new Stream<OutboundLine>()
  readonly rows = createRowStamper()

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
    yield* this.#takePrepended()
    try {
      for await (const chunk of input) {
        buffer += chunk
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = stripBOM(buffer.slice(0, newlineIndex))
          buffer = buffer.slice(newlineIndex + 1)
          if (line.trim().length > 0) {
            const message = await this.#classifyLine(line, true)
            yield* this.#takePrepended()
            if (message !== undefined) yield message
          }
          newlineIndex = buffer.indexOf('\n')
        }
        yield* this.#takePrepended()
      }
      if (buffer.trim().length > 0) {
        const message = await this.#classifyLine(stripBOM(buffer), false)
        yield* this.#takePrepended()
        if (message !== undefined) yield message
      }
      yield* this.#takePrepended()
    } finally {
      this.#closeInput()
    }
  }


  async #classifyLine(
    line: string,
    emitDiagnostic: boolean,
  ): Promise<StdinMessage | undefined> {
    try {
      const parsed = JSON.parse(line) as {
        type?: string
        [key: string]: unknown
      }
      if (emitDiagnostic) {
        logForDiagnosticsNoPII('debug', 'headless_stdin_message', {
          type: parsed.type ?? 'unknown',
        })
      }
      switch (parsed.type) {
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

  pendingControlRequestCount(): number {
    return this.#pending.size
  }

  async #handleControlResponse(
    message: SDKControlResponse & { uuid?: string },
  ): Promise<boolean> {
    const response = message.response as ControlResponse | ControlErrorResponse
    if (typeof message.uuid === 'string' && message.uuid.length > 0) {
      notifyCommandLifecycle(message.uuid, 'completed')
    }
    const requestId = response?.request_id
    const pending = requestId !== undefined ? this.#pending.get(requestId) : undefined
    if (!pending) {
      if (response?.subtype === 'success') {
        const toolUseID = (response.response as { tool_use_id?: string } | undefined)
          ?.tool_use_id
        if (typeof toolUseID === 'string' && this.#resolvedToolUses.has(toolUseID)) {
          logForDebugging(
            `dropping duplicate control_response for already-resolved tool_use ${toolUseID}`,
          )
          return false
        }
      }
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
      this.outbound.enqueue(envelope)
    })
  }

  denyPendingPermissionRequests(cause: string): number {
    let settled = 0
    for (const [requestId, envelope] of [...this.#pendingCanUseTool]) {
      const pending = this.#pending.get(requestId)
      if (pending === undefined) continue
      const toolName = (envelope.request as { tool_name?: unknown }).tool_name
      this.outbound.enqueue({ type: 'control_cancel_request', request_id: requestId })
      if (pending.toolUseID !== undefined) this.#resolvedToolUses.add(pending.toolUseID)
      pending.resolve({
        behavior: 'deny',
        message: UNANSWERED_ASK_REJECT_MESSAGE(typeof toolName === 'string' && toolName !== '' ? toolName : 'the tool', cause),
      })
      this.#onControlRequestResolved?.(requestId)
      pending.cleanup()
      settled++
    }
    return settled
  }

  #closeInput(): void {
    if (this.#inputClosed) return
    this.#inputClosed = true
    this.denyPendingPermissionRequests(PERMISSION_CHANNEL_CLOSED_CAUSE)
    for (const [requestId, pending] of [...this.#pending]) {
      pending.reject(
        new Error(
          `Permission stream closed before response was received for request ${requestId}`,
        ),
      )
      pending.cleanup()
    }
  }


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
    void this.write({
      type: 'control_cancel_request',
      request_id: requestId,
    })
  }


  stdoutPipeBroken = false

  markStdoutPipeBroken(): void {
    if (this.stdoutPipeBroken) return
    this.stdoutPipeBroken = true
    process.exitCode = 1
    try {
      process.stderr.write(`${BROKEN_STDOUT_LINE}\n`)
    } catch {
    }
  }

  write(message: OutboundLine): Promise<WireLine | null> {
    return new Promise((resolve, reject) => {
      if (this.stdoutPipeBroken) return resolve(null)
      const line: WireLine = isRowLine(message) ? this.rows.stamp(message as never) : (message as ControlLine | TransitionalLine)
      process.stdout.write(`${ndjsonSafeStringify(line)}\n`, error => {
        if (error) {
          if (isBrokenPipeError(error)) {
            this.markStdoutPipeBroken()
            return resolve(null)
          }
          return reject(error)
        }
        resolve(line)
      })
    })
  }


  parkedAsks(): number {
    return this.#pendingCanUseTool.size
  }

  async askPermission(params: PermissionRequestParams, opts: { signal?: AbortSignal; key: string }): Promise<PermissionAnswer> {
    const request =
      params.kind === 'network'
        ? {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            input: { host: params.host },
            tool_use_id: randomUUID(),
            description: `Allow network access to ${params.host}?`,
          }
        : {
            subtype: 'can_use_tool',
            tool_name: params.tool_name,
            input: params.input,
            ...(params.suggestions !== undefined ? { permission_suggestions: params.suggestions } : {}),
            ...(params.blocked_path !== undefined ? { blocked_path: params.blocked_path } : {}),
            ...(params.reason !== undefined ? { decision_reason: params.reason } : {}),
            ...(params.reason_detail !== undefined ? { decision_reason_detail: params.reason_detail } : {}),
            tool_use_id: params.tool_use_id,
            ...(params.agent_id !== undefined ? { agent_id: params.agent_id } : {}),
          }
    const result = (await this.sendRequest(request, PermissionResultSchema(), opts.signal, opts.key)) as {
      behavior?: string
      message?: string
      updated_input?: Record<string, unknown>
      updated_permissions?: PermissionUpdate[]
      interrupt?: boolean
    }
    if (result.behavior === 'allow') {
      return {
        outcome: 'allow',
        ...(result.updated_input !== undefined ? { input: result.updated_input } : {}),
        ...(result.updated_permissions !== undefined ? { rules: result.updated_permissions } : {}),
      }
    }
    return {
      outcome: 'deny',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.interrupt === true ? { stop: true } : {}),
    }
  }

  createCanUseTool(
    onPermissionPrompt?: (details: RequiresActionDetails) => void,
  ): CanUseToolFn {
    return createHostCanUseTool(this, onPermissionPrompt)
  }


  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
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
              tool_use_id: toolUseID || undefined,
            },
            HookJSONOutputSchema(),
            abortSignal,
          )
          return raw as HookJSONOutput
        } catch (error) {
          process.stderr.write(
            `Hook callback ${callbackId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          return {}
        }
      },
    }
  }


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
      return { action: 'cancel' } as ElicitResult
    }
  }


  createSandboxAskCallback(): (ask: {
    host: string
    port?: number
  }) => Promise<boolean> {
    return createSandboxAsk(this)
  }


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
}
