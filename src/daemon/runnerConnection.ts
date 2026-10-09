import type { Readable, Writable } from 'node:stream'
import type { LooseRow } from '../rows/read.js'
import type { InputRow } from '../rows/vocabulary.js'
import type { Capabilities, HostNotificationName, HostRequestName, InitializeResult, ParamsOf, PermissionAnswer, PermissionRequestParams, ResultOf, SessionAppliedParams } from '../runner/wire/methods.js'
import { createPeer, PeerDeadline, type Peer, type RequestOptions } from '../runner/wire/peer.js'
import { refused, type RpcError } from '../runner/wire/errors.js'
import { MERCURY_VERSION } from '../constants/product.js'

export type Verb = Exclude<HostRequestName, 'initialize'>

export type HeldAsk = { answer: Promise<PermissionAnswer>; withdraw: (cause?: string) => void }

export type RunnerConnectionHooks = {
  onRow: (row: LooseRow) => void
  onAsk: (params: PermissionRequestParams) => HeldAsk
  onApplied: (params: SessionAppliedParams) => void
  onScheduleEdit?: (params: ParamsOf<'schedule/edit'>) => ResultOf<'schedule/edit'> | Promise<ResultOf<'schedule/edit'>>
  onProtocolError: (error: RpcError) => void
  log: (line: string) => void
}

export type RunnerEnds = { input: Readable; output: Writable }

export interface RunnerDoor {
  readonly closed: boolean
  send<M extends Verb>(method: M, params: ParamsOf<M>, opts?: RequestOptions): { id: number; answer: Promise<ResultOf<M>> }
  request<M extends Verb>(method: M, params: ParamsOf<M>, opts?: RequestOptions): Promise<ResultOf<M>>
  notify<M extends HostNotificationName>(method: M, params: ParamsOf<M>): void
  deliver(row: InputRow): Promise<boolean>
}

export class RunnerConnection implements RunnerDoor {
  readonly peer: Peer
  readonly initialized: Promise<InitializeResult | null>
  private readonly hooks: RunnerConnectionHooks

  constructor(ends: RunnerEnds, capabilities: Capabilities, hooks: RunnerConnectionHooks) {
    this.hooks = hooks
    this.peer = createPeer({ input: ends.input, output: ends.output, side: 'host', log: hooks.log, onProtocolError: error => hooks.onProtocolError(error) })
    this.peer.onNotification('row', row => hooks.onRow(row as LooseRow))
    this.peer.onNotification('session/applied', params => hooks.onApplied(params))
    this.peer.onRequest('permission/request', (params, ctx) => {
      const held = hooks.onAsk(params)
      ctx.signal.addEventListener(
        'abort',
        () => {
          if (this.peer.closed) return
          const reason = ctx.signal.reason
          held.withdraw(typeof reason === 'string' && reason !== '' ? reason : undefined)
        },
        { once: true },
      )
      return held.answer
    })
    if (hooks.onScheduleEdit) this.peer.onRequest('schedule/edit', params => hooks.onScheduleEdit!(params))
    this.initialized = this.peer
      .request('initialize', { protocol: 1, host: { name: 'mercury-daemon', version: MERCURY_VERSION }, capabilities })
      .catch((error: unknown) => {
        hooks.log(`the runner did not answer initialize: ${error instanceof Error ? error.message : String(error)}`)
        if (error instanceof PeerDeadline) hooks.onProtocolError(refused(`the runner did not answer initialize within ${error.deadlineMs} ms`, 'protocol', { deadline_ms: error.deadlineMs }))
        return null
      })
  }

  get closed(): boolean {
    return this.peer.closed
  }

  send<M extends Verb>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): { id: number; answer: Promise<ResultOf<M>> } {
    return this.peer.send(method, params, opts)
  }

  request<M extends Verb>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): Promise<ResultOf<M>> {
    return this.peer.request(method, params, opts)
  }

  notify<M extends HostNotificationName>(method: M, params: ParamsOf<M>): void {
    this.peer.notify(method, params)
  }

  async deliver(row: InputRow): Promise<boolean> {
    if (this.peer.closed) return false
    if ((await this.initialized) === null) return false
    try {
      const answer = await this.peer.request('queue/add', row)
      if (!answer.accepted) this.hooks.log(`queue/add was not accepted: ${answer.reason}`)
      return answer.accepted
    } catch (error) {
      this.hooks.log(`queue/add was not accepted: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  close(reason: string): void {
    this.peer.close(reason)
  }
}
