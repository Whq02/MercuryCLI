import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { LooseRow } from '../rows/read.js'
import type { InputBlock, PromptRow } from '../rows/vocabulary.js'
import { isRpcError } from '../runner/wire/errors.js'
import type { Capabilities, HostRequestName, InitializeResult, ParamsOf, PermissionAnswer, PermissionRequestParams, ResultOf } from '../runner/wire/methods.js'
import { createPeer, PeerClosed, type Peer } from '../runner/wire/peer.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME, seatVerbAppliedFrame, type SeatVerbLanded } from './runnerFrames.js'

export type RunnerConnectionHooks = {
  onLine: (line: string) => void
  onRow: (row: LooseRow) => void
  onAsk: (frame: Record<string, unknown>) => void
  log: (line: string) => void
}

type Verb = Exclude<HostRequestName, 'initialize'>

const SUBTYPE_METHODS: Record<string, Verb> = {
  interrupt: 'turn/interrupt',
  withdraw_send: 'queue/withdraw',
  set_permission_mode: 'session/set_mode',
  set_model: 'session/set_model',
  claim_session: 'session/claim',
  set_effort: 'session/set_effort',
  session_facts: 'session/facts',
  schedule_roster: 'schedule/roster',
  rewind_session: 'session/rewind',
  spawn_switch: 'session/set_spawn_switch',
  kit_edit: 'session/set_kit',
  pause_gate: 'session/pause_gate',
  background_shell: 'shell/background',
  stop_task: 'agent/stop',
  quiesce: 'session/quiesce',
  resume_task: 'agent/resume',
}

export function paramsOfSubtype(subtype: string, request: Record<string, unknown>, requestId: string): { method: Verb; params: unknown } | null {
  const method = SUBTYPE_METHODS[subtype]
  if (method === undefined) return null
  const str = (key: string): string | undefined => (typeof request[key] === 'string' && request[key] !== '' ? (request[key] as string) : undefined)
  switch (method) {
    case 'turn/interrupt':
      return { method, params: { ...(requestId.startsWith('concourse-interrupt-') ? { op_id: requestId } : {}), ...(request.hard === true ? { hard: true } : {}) } }
    case 'queue/withdraw':
      return { method, params: { id: String(request.client_message_id ?? '') } }
    case 'session/set_mode':
      return { method, params: { mode: String(request.mode ?? '') } }
    case 'session/set_model':
      return { method, params: { ...(str('model') !== undefined ? { model: str('model') } : {}) } }
    case 'session/claim':
      return {
        method,
        params: {
          session_id: String(request.session_id ?? ''),
          ...(str('model') !== undefined ? { model: str('model') } : {}),
          ...(str('permission_mode') !== undefined ? { mode: str('permission_mode') } : {}),
          ...(str('effort') !== undefined ? { effort: str('effort') } : {}),
          ...(request.resume === true ? { resume: true } : {}),
          ...(str('restart_reason') !== undefined ? { restart_reason: str('restart_reason') } : {}),
          ...(request.openai_catalogue !== undefined ? { openai_catalogue: request.openai_catalogue } : {}),
        },
      }
    case 'session/set_effort':
      return { method, params: { effort: String(request.effort ?? '') } }
    case 'session/facts':
      return { method, params: {} }
    case 'schedule/roster':
      return { method, params: { schedules: request.schedules } }
    case 'session/rewind':
      return { method, params: { user_message_id: String(request.user_message_id ?? ''), mode: request.mode, ...(request.dry_run !== undefined ? { dry_run: request.dry_run === true } : {}) } }
    case 'session/set_spawn_switch':
      return { method, params: { switch: request.switch, on: request.on === true } }
    case 'session/set_kit':
      return { method, params: { kit: request.kit } }
    case 'session/pause_gate':
      return { method, params: { paused: request.paused === true } }
    case 'shell/background':
      return { method, params: {} }
    case 'agent/stop':
    case 'agent/resume':
      return { method, params: { agent_id: String(request.task_id ?? ''), ...(str('note') !== undefined ? { note: str('note') } : {}) } }
    case 'session/quiesce':
      return { method, params: { action: request.action, token: String(request.token ?? '') } }
    default:
      return null
  }
}

export function answerPayloadOf(method: Verb, result: unknown): Record<string, unknown> | undefined {
  if (method === 'turn/interrupt' || method === 'schedule/roster') return undefined
  const record = (result ?? {}) as Record<string, unknown>
  if (method === 'session/set_model' || method === 'session/set_effort' || method === 'session/set_spawn_switch') {
    return { ...record, at: record.at === 'turn_end' ? 'turn-boundary' : 'now' }
  }
  return record
}

export function permissionAnswerOfFrame(response: Record<string, unknown> | undefined): PermissionAnswer {
  if (response?.behavior === 'allow') {
    const input = response.updated_input
    const rules = response.updated_permissions
    return {
      outcome: 'allow',
      ...(input !== null && typeof input === 'object' && Object.keys(input as object).length > 0 ? { input: input as Record<string, unknown> } : {}),
      ...(Array.isArray(rules) && rules.length > 0 ? { rules: rules as never } : {}),
    }
  }
  return {
    outcome: 'deny',
    ...(typeof response?.message === 'string' ? { message: response.message } : {}),
    ...(response?.interrupt === true ? { stop: true } : {}),
  }
}

export function askFrameOf(params: PermissionRequestParams, requestId: string): Record<string, unknown> {
  if (params.kind === 'network') {
    return {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME, input: { host: params.host }, tool_use_id: randomUUID(), description: `Allow network access to ${params.host}?` },
    }
  }
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: params.tool_name,
      input: params.input,
      ...(params.suggestions !== undefined && params.suggestions.length > 0 ? { permission_suggestions: params.suggestions } : {}),
      ...(params.blocked_path !== undefined ? { blocked_path: params.blocked_path } : {}),
      ...(params.reason !== undefined ? { decision_reason: params.reason } : {}),
      ...(params.reason_detail !== undefined ? { decision_reason_detail: params.reason_detail } : {}),
      tool_use_id: params.tool_use_id,
      ...(params.agent_id !== undefined ? { agent_id: params.agent_id } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    },
  }
}

export function inputRowOfFrame(frame: Record<string, unknown>): ParamsOf<'queue/add'> | null {
  if (frame.type !== 'user') return null
  const message = frame.message as { content?: unknown } | undefined
  const content = message?.content ?? ''
  const id = typeof frame.uuid === 'string' && frame.uuid !== '' ? { id: frame.uuid } : {}
  if (frame.mode === 'task-notification' && typeof frame.agent_id === 'string' && frame.agent_id !== '') {
    return { type: 'note', to: frame.agent_id, content: typeof content === 'string' ? content : JSON.stringify(content), ...id }
  }
  const priority = frame.priority === 'now' || frame.priority === 'next' || frame.priority === 'later' ? frame.priority : undefined
  const stamp: Pick<PromptRow, 'id' | 'priority' | 'sent_at' | 'origin'> = {
    ...id,
    ...(priority !== undefined ? { priority } : {}),
    ...(typeof frame.timestamp === 'string' ? { sent_at: frame.timestamp } : {}),
    ...(frame.origin !== null && typeof frame.origin === 'object' && typeof (frame.origin as { kind?: unknown }).kind === 'string' ? { origin: frame.origin as { kind: string } } : {}),
  }
  if (frame.mode === 'bash') return { type: 'shell', command: typeof content === 'string' ? content : '', ...stamp }
  if (typeof content === 'string') return { type: 'prompt', content, ...stamp }
  if (!Array.isArray(content)) return { type: 'prompt', content: '', ...stamp }
  const blocks: InputBlock[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
    if (block.type === 'image') {
      const source = block.source as { media_type?: unknown; data?: unknown } | undefined
      if (typeof source?.media_type === 'string' && typeof source.data === 'string') blocks.push({ type: 'image', media_type: source.media_type, data: source.data })
    }
  }
  return { type: 'prompt', content: blocks, ...stamp }
}

export class RunnerConnection {
  readonly peer: Peer
  readonly initialized: Promise<InitializeResult | null>
  private readonly hooks: RunnerConnectionHooks
  private readonly asks = new Map<string, (answer: PermissionAnswer) => void>()
  private readonly callerIds = new Map<number, string>()
  private sessionId: string | null = null

  constructor(child: ChildProcess, capabilities: Capabilities, hooks: RunnerConnectionHooks) {
    this.hooks = hooks
    this.peer = createPeer({ input: child.stdout!, output: child.stdin!, side: 'host', log: hooks.log })
    this.peer.onNotification('row', row => {
      const loose = row as LooseRow
      if (loose.type === 'session' && typeof loose.session_id === 'string') this.sessionId = loose.session_id
      hooks.onRow(loose)
      hooks.onLine(JSON.stringify(row))
    })
    this.peer.onNotification('session/applied', params => {
      const requestId = this.callerIds.get(params.request_id)
      this.callerIds.delete(params.request_id)
      if (requestId === undefined) return
      const landed: SeatVerbLanded =
        params.verb === 'set_model'
          ? { verb: 'set_model', model: params.model ?? '' }
          : params.verb === 'set_effort'
            ? { verb: 'set_effort', effort: params.effort ?? '' }
            : { verb: 'spawn_switch', switch: params.switch ?? 'subagents', on: params.on === true }
      hooks.onLine(JSON.stringify(seatVerbAppliedFrame(this.sessionId ?? '', requestId, landed, randomUUID())))
    })
    this.peer.onRequest('permission/request', (params, ctx) => {
      const requestId = randomUUID()
      const frame = askFrameOf(params, requestId)
      return new Promise<PermissionAnswer>(resolve => {
        this.asks.set(requestId, answer => {
          this.asks.delete(requestId)
          resolve(answer)
        })
        ctx.signal.addEventListener(
          'abort',
          () => {
            if (!this.asks.has(requestId)) return
            this.asks.delete(requestId)
            if (!this.peer.closed) hooks.onLine(JSON.stringify({ type: 'control_cancel_request', request_id: requestId }))
          },
          { once: true },
        )
        hooks.onAsk(frame)
        hooks.onLine(JSON.stringify(frame))
      })
    })
    this.initialized = this.peer
      .request('initialize', { protocol: 1, host: { name: 'mercury-daemon', version: MERCURY_VERSION }, capabilities }, { deadlineMs: null })
      .then(result => {
        if (typeof result.session_id === 'string') this.sessionId = result.session_id
        return result
      })
      .catch((error: unknown) => {
        hooks.log(`the runner did not answer initialize: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
  }

  get closed(): boolean {
    return this.peer.closed
  }

  deliver(frame: Record<string, unknown>): Promise<boolean> {
    const row = inputRowOfFrame(frame)
    if (row === null || this.peer.closed) return Promise.resolve(false)
    return this.peer.request('queue/add', row, { deadlineMs: null }).then(
      () => true,
      (error: unknown) => {
        this.hooks.log(`queue/add was not accepted: ${error instanceof Error ? error.message : String(error)}`)
        return false
      },
    )
  }

  control(frame: Record<string, unknown>): boolean {
    if (this.peer.closed) return false
    if (frame.type === 'control_response') {
      const response = frame.response as Record<string, unknown> | undefined
      const requestId = String(response?.request_id ?? '')
      const settle = this.asks.get(requestId)
      if (settle === undefined) return true
      settle(permissionAnswerOfFrame(response?.subtype === 'error' ? { behavior: 'deny', message: String(response.error ?? 'refused') } : (response?.response as Record<string, unknown> | undefined)))
      return true
    }
    if (frame.type !== 'control_request') return false
    const requestId = String(frame.request_id ?? '')
    const request = (frame.request ?? {}) as Record<string, unknown>
    const subtype = String(request.subtype ?? '')
    if (subtype === 'credential_change') {
      this.peer.notify('credentials/changed', {})
      this.answer(requestId, { subtype: 'success' })
      return true
    }
    const mapped = paramsOfSubtype(subtype, request, requestId)
    if (mapped === null) {
      this.answer(requestId, { subtype: 'error', error: `unsupported control request subtype: ${subtype}` })
      return true
    }
    const sent = this.peer.send(mapped.method, mapped.params as never, { deadlineMs: null })
    this.callerIds.set(sent.id, requestId)
    sent.answer
      .then(result => {
        const payload = answerPayloadOf(mapped.method, result as ResultOf<Verb>)
        if (mapped.method !== 'session/set_model' && mapped.method !== 'session/set_effort' && mapped.method !== 'session/set_spawn_switch') this.callerIds.delete(sent.id)
        else if ((result as { at?: string } | undefined)?.at !== 'turn_end') this.callerIds.delete(sent.id)
        this.answer(requestId, { subtype: 'success', ...(payload !== undefined ? { response: payload } : {}) })
      })
      .catch((error: unknown) => {
        this.callerIds.delete(sent.id)
        if (error instanceof PeerClosed) return
        this.answer(requestId, { subtype: 'error', error: isRpcError(error) ? error.message : error instanceof Error ? error.message : String(error) })
      })
    return true
  }

  private answer(requestId: string, response: Record<string, unknown>): void {
    this.hooks.onLine(JSON.stringify({ type: 'control_response', response: { request_id: requestId, ...response } }))
  }

  close(reason: string): void {
    this.peer.close(reason)
  }
}
