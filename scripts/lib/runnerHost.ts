import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPeer, type Peer } from '../../src/runner/wire/peer.ts'
import type { Capabilities, ElicitationRequestParams, InitializeResult, ParamsOf, PermissionRequestParams, ResultOf } from '../../src/runner/wire/methods.ts'
import type { Frame } from './rows.ts'

export type HostedRunner = {
  child: ChildProcess
  peer: Peer
  rows: Frame[]
  notifications: Array<{ method: string; params: unknown }>
  asks: Array<{ id: number; params: PermissionRequestParams }>
  withdrawn: Set<number>
  stderr: () => string
  exited: Promise<number | null>
  initialize(capabilities?: Partial<Capabilities>, deadlineMs?: number): Promise<InitializeResult>
  request<M extends 'session/claim' | 'session/facts' | 'session/set_model' | 'session/set_effort' | 'session/set_mode' | 'session/set_spawn_switch' | 'session/set_kit' | 'session/rewind' | 'session/pause_gate' | 'session/quiesce' | 'queue/add' | 'queue/withdraw' | 'turn/interrupt' | 'agent/stop' | 'agent/resume' | 'shell/background' | 'schedule/roster'>(method: M, params: ParamsOf<M>, deadlineMs?: number | null): Promise<ResultOf<M>>
  prompt(content: string, extra?: Record<string, unknown>): Promise<ResultOf<'queue/add'>>
  waitFor(label: string, pred: (row: Frame) => boolean, timeoutMs?: number): Promise<Frame>
  waitForAsk(label: string, timeoutMs?: number): Promise<{ id: number; params: PermissionRequestParams }>
  answerAsk(id: number, answer: ResultOf<'permission/request'>): void
  onAsk(handler: (params: PermissionRequestParams, id: number) => ResultOf<'permission/request'> | Promise<ResultOf<'permission/request'>>): void
  onElicitation(handler: (params: ElicitationRequestParams, id: number) => ResultOf<'elicitation/request'> | Promise<ResultOf<'elicitation/request'>>): void
  elicitations: Array<{ id: number; params: ElicitationRequestParams }>
  end(): void
  stop(graceMs?: number): Promise<number | null>
}

export type HostOptions = {
  dist: string
  node: string
  cwd?: string
  home?: string
  env?: Record<string, string | undefined>
  argv?: string[]
  raw?: (line: string) => void
}

export function scratchHome(prefix = 'runner-host-'): { home: string; cwd: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}cwd-`))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  return {
    home,
    cwd,
    env: {
      HOME: home,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREWS_DIR: join(home, 'crews'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
    },
  }
}

export function hostRunner(opts: HostOptions): HostedRunner {
  const scratch = opts.home === undefined ? scratchHome() : null
  const cwd = opts.cwd ?? scratch?.cwd ?? process.cwd()
  const env: Record<string, string | undefined> = {
    PATH: `/usr/bin:/bin:${dirname(opts.node)}`,
    ...(scratch?.env ?? {}),
    ...(opts.env ?? {}),
  }
  const child = spawn(opts.node, [opts.dist, 'runner', ...(opts.argv ?? [])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', chunk => {
    stderr += String(chunk)
  })
  const rows: Frame[] = []
  const notifications: Array<{ method: string; params: unknown }> = []
  const asks: Array<{ id: number; params: PermissionRequestParams }> = []
  const withdrawn = new Set<number>()
  const elicitations: Array<{ id: number; params: ElicitationRequestParams }> = []
  const rowWaiters: Array<{ pred: (row: Frame) => boolean; resolve: (row: Frame) => void }> = []
  const askWaiters: Array<(ask: { id: number; params: PermissionRequestParams }) => void> = []
  let askHandler: ((params: PermissionRequestParams, id: number) => ResultOf<'permission/request'> | Promise<ResultOf<'permission/request'>>) | null = null
  const pendingAsks = new Map<number, { resolve: (answer: ResultOf<'permission/request'>) => void }>()
  if (opts.raw) child.stdout!.on('data', chunk => opts.raw!(String(chunk)))
  const peer = createPeer({ input: child.stdout!, output: child.stdin!, side: 'host', log: () => {} })
  peer.onNotification('row', params => {
    const row = params as Frame
    rows.push(row)
    for (let i = rowWaiters.length - 1; i >= 0; i--) {
      if (rowWaiters[i]!.pred(row)) rowWaiters.splice(i, 1)[0]!.resolve(row)
    }
  })
  peer.onNotification('session/applied', params => notifications.push({ method: 'session/applied', params }))
  peer.onNotification('elicitation/complete', params => notifications.push({ method: 'elicitation/complete', params }))
  peer.onNotification('$/cancel_request', params => notifications.push({ method: '$/cancel_request', params }))
  peer.onRequest('permission/request', (params, ctx) => {
    const ask = { id: ctx.id, params }
    asks.push(ask)
    for (const waiter of askWaiters.splice(0, askWaiters.length)) waiter(ask)
    if (askHandler !== null) return askHandler(params, ctx.id)
    return new Promise<ResultOf<'permission/request'>>(resolve => {
      pendingAsks.set(ctx.id, { resolve })
      ctx.signal.addEventListener(
        'abort',
        () => {
          pendingAsks.delete(ctx.id)
          withdrawn.add(ctx.id)
        },
        { once: true },
      )
    })
  })
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const host: HostedRunner = {
    child,
    peer,
    rows,
    notifications,
    asks,
    withdrawn,
    stderr: () => stderr,
    exited,
    initialize: (capabilities = {}, deadlineMs = 60_000) =>
      peer.request(
        'initialize',
        { protocol: 1, host: { name: 'proof-host', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false, ...capabilities } },
        { deadlineMs },
      ),
    request: (method, params, deadlineMs) => peer.request(method, params as never, deadlineMs === undefined ? {} : { deadlineMs }) as never,
    prompt: (content, extra = {}) => peer.request('queue/add', { type: 'prompt', content, ...extra } as never, { deadlineMs: 10_000 }),
    waitFor: (label, pred, timeoutMs = 60_000) =>
      new Promise<Frame>((resolve, reject) => {
        const hit = rows.find(pred)
        if (hit !== undefined) return resolve(hit)
        const timer = setTimeout(() => {
          const at = rowWaiters.findIndex(w => w.resolve === done)
          if (at !== -1) rowWaiters.splice(at, 1)
          reject(new Error(`${label}: no such row within ${timeoutMs} ms; rows=${JSON.stringify(rows.map(r => `${String(r.type)}:${String(r.state ?? r.status ?? '')}`))} stderr=${stderr.slice(0, 400)}`))
        }, timeoutMs)
        const done = (row: Frame): void => {
          clearTimeout(timer)
          resolve(row)
        }
        rowWaiters.push({ pred, resolve: done })
      }),
    waitForAsk: (label, timeoutMs = 60_000) =>
      new Promise((resolve, reject) => {
        const open = asks.find(ask => pendingAsks.has(ask.id))
        if (open !== undefined) return resolve(open)
        const timer = setTimeout(() => reject(new Error(`${label}: no permission/request within ${timeoutMs} ms; stderr=${stderr.slice(0, 400)}`)), timeoutMs)
        askWaiters.push(ask => {
          clearTimeout(timer)
          resolve(ask)
        })
      }),
    answerAsk: (id, answer) => {
      const pending = pendingAsks.get(id)
      if (pending === undefined) return
      pendingAsks.delete(id)
      pending.resolve(answer)
    },
    onAsk: handler => {
      askHandler = handler
    },
    onElicitation: handler => {
      peer.onRequest('elicitation/request', (params, ctx) => {
        elicitations.push({ id: ctx.id, params })
        return handler(params, ctx.id)
      })
    },
    elicitations,
    end: () => {
      try {
        child.stdin!.end()
      } catch {
        return
      }
    },
    stop: async (graceMs = 2_000) => {
      host.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
      const code = await exited
      clearTimeout(timer)
      peer.close('the proof stopped the runner')
      return code
    },
  }
  return host
}
