import type { ChildProcess } from 'node:child_process'

import { endProcessTree } from './processGroup.js'


export const CLOSE_DRAIN_MS = 250
export const KILL_SETTLE_MS = 2_000

export interface ChildSettleOptions {
  timeoutMs: number
  signal?: AbortSignal
  closeDrainMs?: number
  killSettleMs?: number
}

export interface ChildSettlement {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  spawnError?: string
}

export function settleChildRun(child: ChildProcess, opts: ChildSettleOptions): Promise<ChildSettlement> {
  const closeDrainMs = opts.closeDrainMs ?? CLOSE_DRAIN_MS
  const killSettleMs = opts.killSettleMs ?? KILL_SETTLE_MS
  return new Promise<ChildSettlement>(resolve => {
    let settled = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let timedOut = false
    let aborted = false
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const arm = (fn: () => void, ms: number): void => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      timers.push(timer)
    }
    const settle = (settlement: Omit<ChildSettlement, 'timedOut' | 'aborted'>): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ ...settlement, timedOut, aborted })
    }
    const settleFromExit = (): void =>
      settle({ code: exited?.code ?? null, signal: exited?.signal ?? null })
    const forceEnd = (): void => {
      void endProcessTree(child, 'SIGKILL')
      arm(settleFromExit, killSettleMs)
    }
    function onAbort(): void {
      if (settled) return
      aborted = true
      forceEnd()
    }

    child.on('exit', (code, signal) => {
      exited = { code, signal }
      arm(settleFromExit, closeDrainMs)
    })
    child.on('close', (code, signal) => {
      exited = exited ?? { code, signal }
      settleFromExit()
    })
    child.on('error', err => {
      settle({ code: null, signal: null, spawnError: err.message })
    })

    arm(() => {
      if (settled) return
      timedOut = true
      forceEnd()
    }, opts.timeoutMs)

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
