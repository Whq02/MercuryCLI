import { PassThrough } from 'node:stream'
import { RunnerConnection, type RunnerConnectionHooks } from '../../src/daemon/runnerConnection.ts'
import type { SeatRosterPort } from '../../src/daemon/sessionSeat.ts'
import { createPeer, type Peer } from '../../src/runner/wire/peer.ts'
import { METHODS, methodsFrom, type Capabilities, type MethodName, type ParamsOf, type PermissionAnswer, type PermissionRequestParams, type ResultOf, type SessionAppliedParams } from '../../src/runner/wire/methods.ts'
import { RPC_REFUSED, RpcError, cancelled } from '../../src/runner/wire/errors.ts'

export type StandInRequest = {
  id: number
  method: string
  params: unknown
  at: number
  cancelled: boolean
  settled: boolean
  answer(result: unknown): void
  refuse(code: number, message: string, data?: unknown): void
}

export type StandInRunner = {
  connection: RunnerConnection
  runner: Peer
  requests: StandInRequest[]
  cancels: number[]
  notifications: Array<{ method: string; params: unknown }>
  nextRequest(method?: string, timeoutMs?: number): Promise<StandInRequest>
  row(row: Record<string, unknown>): void
  rawToHost(text: string): void
  applied(params: SessionAppliedParams): void
  ask(params: PermissionRequestParams, opts?: { signal?: AbortSignal }): Promise<PermissionAnswer>
  roster(extra?: Partial<SeatRosterPort>): SeatRosterPort
  close(reason?: string): void
}

const HOST_METHODS = methodsFrom('host', 'request').map(spec => spec.name as MethodName).filter(name => name !== 'initialize')

export const LEAVE_PENDING: unique symbol = Symbol('the stand-in leaves this request pending')
export type AutoAnswer = unknown | ((params: unknown) => unknown)
const AUTO_ANSWERS: Partial<Record<MethodName, AutoAnswer>> = { 'schedule/roster': {} }

export function standInRunner(opts: { capabilities?: Partial<Capabilities>; hooks?: Partial<RunnerConnectionHooks>; sessionId?: string | null; pid?: number; autoAnswer?: Partial<Record<MethodName, AutoAnswer>> | null } = {}): StandInRunner {
  const auto = opts.autoAnswer === null ? {} : { ...AUTO_ANSWERS, ...(opts.autoAnswer ?? {}) }
  const toRunner = new PassThrough()
  const toHost = new PassThrough()
  const requests: StandInRequest[] = []
  const cancels: number[] = []
  const notifications: Array<{ method: string; params: unknown }> = []
  const waiters: Array<{ method: string | undefined; resolve: (request: StandInRequest) => void }> = []
  const taken = new Set<StandInRequest>()
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log: () => {} })
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '0.0.0-stand-in', pid: opts.pid ?? process.pid }, session_id: opts.sessionId ?? null }))
  for (const method of HOST_METHODS) {
    runner.onRequest(method, (params, ctx) =>
      new Promise<ResultOf<typeof method>>((resolve, reject) => {
        const request: StandInRequest = {
          id: ctx.id,
          method,
          params,
          at: Date.now(),
          cancelled: false,
          settled: false,
          answer: result => {
            request.settled = true
            resolve(result as never)
          },
          refuse: (code, message, data) => {
            request.settled = true
            reject(new RpcError(code, message, data))
          },
        }
        ctx.signal.addEventListener(
          'abort',
          () => {
            request.cancelled = true
            request.settled = true
            cancels.push(ctx.id)
            reject(cancelled('the host withdrew the request'))
          },
          { once: true },
        )
        requests.push(request)
        if (method in auto) {
          const canned = auto[method]
          let value: unknown
          try {
            value = typeof canned === 'function' ? (canned as (params: unknown) => unknown)(params) : canned
          } catch (error) {
            if (error instanceof RpcError) request.refuse(error.code, error.message, error.data)
            else request.refuse(RPC_REFUSED, error instanceof Error ? error.message : String(error))
            return
          }
          if (value !== LEAVE_PENDING) {
            request.answer(value)
            return
          }
        }
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.method === undefined || waiters[i]!.method === method) waiters.splice(i, 1)[0]!.resolve(request)
        }
      }),
    )
  }
  runner.onNotification('credentials/changed', params => notifications.push({ method: 'credentials/changed', params }))
  const hooks: RunnerConnectionHooks = {
    onRow: () => {},
    onAsk: params => ({ answer: Promise.resolve({ outcome: 'deny', message: `the stand-in's host holds no asks (${params.kind})` }), withdraw: () => {} }),
    onApplied: () => {},
    log: () => {},
    ...(opts.hooks ?? {}),
  }
  const connection = new RunnerConnection({ input: toHost, output: toRunner }, { holds_asks: true, elicitation: false, partial_rows: false, ...(opts.capabilities ?? {}) }, hooks)
  return {
    connection,
    runner,
    requests,
    cancels,
    notifications,
    nextRequest: (method, timeoutMs = 5_000) =>
      new Promise((resolve, reject) => {
        const waiting = requests.find(r => !r.settled && !taken.has(r) && (method === undefined || r.method === method))
        if (waiting !== undefined) {
          taken.add(waiting)
          return resolve(waiting)
        }
        const waiter = {
          method,
          resolve: (request: StandInRequest) => {
            clearTimeout(timer)
            taken.add(request)
            resolve(request)
          },
        }
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          reject(new Error(`no ${method ?? 'request'} reached the stand-in runner within ${timeoutMs} ms; seen=${JSON.stringify(requests.map(r => r.method))}`))
        }, timeoutMs)
        waiters.push(waiter)
      }),
    row: row => runner.notify('row', row as ParamsOf<'row'>),
    rawToHost: text => {
      toHost.write(text)
    },
    applied: params => runner.notify('session/applied', params),
    ask: (params, askOpts = {}) => runner.request('permission/request', params, { deadlineMs: null, ...(askOpts.signal !== undefined ? { signal: askOpts.signal } : {}) }),
    roster: extra => ({
      door: () => (connection.closed ? undefined : connection),
      list: () => [],
      patchSeatModel: () => true,
      patchSeatEffort: () => true,
      ...(extra ?? {}),
    }),
    close: (reason = 'the proof closed the stand-in') => {
      connection.close(reason)
      runner.close(reason)
      toRunner.end()
      toHost.end()
    },
  }
}

export const methodTable = METHODS
