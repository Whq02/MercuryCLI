import type { Readable, Writable } from 'node:stream'
import type { LooseRow } from '../rows/read.js'
import type { InputRow } from '../rows/vocabulary.js'
import type { Capabilities, HostNotificationName, HostRequestName, InitializeResult, ParamsOf, PermissionAnswer, PermissionRequestParams, ResultOf, SessionAppliedParams } from '../runner/wire/methods.js'
import { createPeer, type Peer, type RequestOptions } from '../runner/wire/peer.js'
import { MERCURY_VERSION } from '../constants/product.js'

export type Verb = Exclude<HostRequestName, 'initialize'>

export type HeldAsk = { answer: Promise<PermissionAnswer>; withdraw: () => void }

export type RunnerConnectionHooks = {
  onRow: (row: LooseRow) => void
  onAsk: (params: PermissionRequestParams) => HeldAsk
  onApplied: (params: SessionAppliedParams) => void
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
    this.peer = createPeer({ input: ends.input, output: ends.output, side: 'host', log: hooks.log })
    this.peer.onNotification('row', row => hooks.onRow(row as LooseRow))
    this.peer.onNotification('session/applied', params => hooks.onApplied(params))
    this.peer.onRequest('permission/request', (params, ctx) => {
      const held = hooks.onAsk(params)
      ctx.signal.addEventListener(
        'abort',
        () => {
          if (!this.peer.closed) held.withdraw()
        },
        { once: true },
      )
      return held.answer
    })
    this.initialized = this.peer
      .request('initialize', { protocol: 1, host: { name: 'mercury-daemon', version: MERCURY_VERSION }, capabilities }, { deadlineMs: null })
      .catch((error: unknown) => {
        hooks.log(`the runner did not answer initialize: ${error instanceof Error ? error.message : String(error)}`)
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

  deliver(row: InputRow): Promise<boolean> {
    if (this.peer.closed) return Promise.resolve(false)
    return this.peer.request('queue/add', row, { deadlineMs: null }).then(
      () => true,
      (error: unknown) => {
        this.hooks.log(`queue/add was not accepted: ${error instanceof Error ? error.message : String(error)}`)
        return false
      },
    )
  }

  close(reason: string): void {
    this.peer.close(reason)
  }
}
