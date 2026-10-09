import type { Readable, Writable } from 'node:stream'
import type { LooseRow } from '../rows/read.js'
import type { InputRow } from '../rows/vocabulary.js'
import type { Capabilities, HostNotificationName, HostRequestName, InitializeResult, ParamsOf, PermissionAnswer, PermissionRequestParams, ResultOf, SessionAppliedParams } from '../runner/wire/methods.js'
import { createPeer, type Peer, type RequestOptions } from '../runner/wire/peer.js'
import type { RpcError } from '../runner/wire/errors.js'
import { MERCURY_VERSION } from '../constants/product.js'

export const SLOW_BOOT_FIRST_MARK_MS = 10_000

export function slowBootMarkMs(marks: number): number {
  return SLOW_BOOT_FIRST_MARK_MS * 2 ** marks
}

export function slowBootLine(elapsedMs: number): string {
  return `the runner has not answered initialize after ${Math.round(elapsedMs / 1000)} s — waiting while it lives`
}

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
  readonly startedAt: number
  private readonly hooks: RunnerConnectionHooks
  private bootMark: ReturnType<typeof setTimeout> | null = null

  constructor(ends: RunnerEnds, capabilities: Capabilities, hooks: RunnerConnectionHooks) {
    this.hooks = hooks
    this.startedAt = Date.now()
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
    this.armBootMark(0)
    this.initialized = this.peer
      .request('initialize', { protocol: 1, host: { name: 'mercury-daemon', version: MERCURY_VERSION }, capabilities })
      .catch((error: unknown) => {
        hooks.log(`the runner did not answer initialize: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      .finally(() => this.clearBootMark())
  }

  private armBootMark(marks: number): void {
    const due = this.startedAt + slowBootMarkMs(marks) - Date.now()
    this.bootMark = setTimeout(() => {
      this.bootMark = null
      if (this.peer.closed) return
      this.hooks.log(slowBootLine(Date.now() - this.startedAt))
      this.armBootMark(marks + 1)
    }, Math.max(0, due))
    this.bootMark.unref?.()
  }

  private clearBootMark(): void {
    if (this.bootMark !== null) clearTimeout(this.bootMark)
    this.bootMark = null
  }

  get bootMs(): number {
    return Date.now() - this.startedAt
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
    this.clearBootMark()
    this.peer.close(reason)
  }
}
