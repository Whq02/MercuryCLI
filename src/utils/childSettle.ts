import type { ChildProcess } from 'node:child_process'

import { endProcessTree } from './processGroup.js'

/**
 * The ONE settle owner for a spawned run: a child's life always ends in a
 * settlement, and a settlement that had to force the end takes the whole
 * TREE with it.
 *
 * Two facts drove this. First, `close` is not the child's end — it is the
 * end of the child's STREAMS, and a descendant that inherited the pipes
 * (`cargo test`'s workers, a `npm run build` toolchain, a `python -m`
 * wrapper's grandchild) keeps them open after the leader is gone, so a
 * promise resolved from `close` alone never resolves: the turn stopped
 * progressing with no error, no timeout message and no exit code. Settling
 * on `exit` with a bounded drain window for `close` keeps the last buffered
 * bytes without ever waiting on a stranger's file descriptors.
 *
 * Second, a timeout that kills only the leader leaves those same
 * descendants running — holding ports, file locks and the object files the
 * user's next build needs — while the tool reports the run over. Both
 * forced ends (the deadline and the operator's abort) route through
 * `endProcessTree`, which the process-group module declares as the one
 * cross-platform tree-kill owner, and then settle under their own bounded
 * grace so a tree that refuses to die still cannot hold the turn.
 *
 * Never rejects.
 */

/** Bounded window for `close` to add the last buffered bytes after `exit`. */
export const CLOSE_DRAIN_MS = 250
/** Bounded window for the child to actually end after a tree strike. */
export const KILL_SETTLE_MS = 2_000

export interface ChildSettleOptions {
  /** Wall-clock budget for the whole run; the deadline ends the tree. */
  timeoutMs: number
  /** The operator's abort. Aborting ends the tree and settles. */
  signal?: AbortSignal
  /** Override the drain window (proofs; the default is the contract). */
  closeDrainMs?: number
  /** Override the post-strike grace (proofs). */
  killSettleMs?: number
}

export interface ChildSettlement {
  /** The child's exit code, or null when it was killed or never ran. */
  code: number | null
  /** The signal that ended it, when one did. */
  signal: NodeJS.Signals | null
  /** The deadline fired: the tree was ended. */
  timedOut: boolean
  /** The caller's signal fired: the tree was ended. */
  aborted: boolean
  /** The child could not be spawned or errored before settling. */
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
    /** A forced end: strike the TREE, then settle under a bounded grace
     *  whether or not the child reports its own end. */
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
      // `close` may still add the tail bytes — bounded, because a live
      // grandchild holding the pipes can delay it forever.
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
