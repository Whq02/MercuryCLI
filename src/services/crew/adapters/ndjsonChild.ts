// ============================================================================
//  crew/adapters/ndjsonChild — the shared line-protocol child plumbing.
//
//  Every inward seat adapter speaks newline-delimited JSON over a child
//  process's stdio. This owner holds the ONE spawn/read/write/kill seam so
//  the provider profiles carry only their documented protocol differences —
//  and so conformance provers can inject a fake child (`spawnImpl`) and
//  drive the REAL adapter code without a real CLI or a paid turn.
//
//  bounds (extend IN PLACE — this file is the exemplar the
//  sibling transports mirror): bounded line buffer with typed resync;
//  exit → close → drain settlement (trailing partial line delivered, bounded
//  backstop for a close held open by an inherited fd); stdin failure settles
//  the child (a broken pipe seat is dead — awaitLine fails fast, never idles
//  out its timeout); a bounded stderr tail for failure diagnosis; and
//  killAndWait — SIGTERM → grace → SIGKILL, resolving at real settlement.
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process'
import { logForDebugging } from '../../../utils/debug.js'

// A single protocol frame should never legitimately exceed this; past it the
// stream is treated as an oversized line and resynced at the next newline.
const MAX_LINE_BUFFER_BYTES = 8 * 1024 * 1024
// After 'exit', 'close' should land promptly; an inherited fd can hold the
// streams open forever — settle anyway after this bound (draining what we have).
const EXIT_CLOSE_BACKSTOP_MS = 1_500
// Bounded stderr diagnostic ring (the last bytes are the diagnosis).
const STDERR_TAIL_BYTES = 4_096
// killAndWait: SIGTERM first, escalate to SIGKILL after this grace.
const KILL_ESCALATION_GRACE_MS = 1_500

export interface NdjsonChildLike {
  write(line: string): void
  onLine(listener: (line: string) => void): () => void
  /** Exit fan-out. `reason` is set when the child failed rather than exited
   *  (spawn error such as ENOENT) — the honest cause, never a silent hang. */
  onExit(listener: (code: number | null, reason?: string) => void): () => void
  kill(): void
  /** True when Mercury spawned the process (the ownership law). */
  readonly owned: boolean
  /** Bounded tail of the child's stderr — the failure diagnosis. Optional:
   *  fake children in conformance provers need not implement it. */
  stderrTail?(): string
  /** SIGTERM → grace → SIGKILL, resolving when the child actually settles
   *  (bounded — never hangs on an unkillable child). Optional for fakes;
   *  callers fall back to kill(). */
  killAndWait?(graceMs?: number): Promise<void>
}

export type SpawnImpl = (cmd: string, args: string[], opts: { cwd?: string }) => NdjsonChildLike

/** Wrap a real child process into the line contract. */
export function realNdjsonChild(cmd: string, args: string[], opts: { cwd?: string }): NdjsonChildLike {
  // child-env law: raw inherit by design — the crew child is a FOREIGN
  // agent CLI running on the operator's own account, and its session env
  // (the very spellings the scrub table strips) IS its auth.
  const child: ChildProcess = spawn(cmd, args, {
    windowsHide: true,
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lineListeners = new Set<(line: string) => void>()
  const exitListeners = new Set<(code: number | null, reason?: string) => void>()
  // The child's terminal fact, once observed: exit and error both settle it
  // exactly once, and a listener registered AFTER settlement still hears it —
  // a dead child must fail fast, never idle out a timeout.
  let settled: { code: number | null; reason?: string } | null = null
  let exitCloseBackstop: NodeJS.Timeout | null = null
  const settle = (code: number | null, reason?: string): void => {
    if (settled) return
    settled = { code, ...(reason !== undefined ? { reason } : {}) }
    if (exitCloseBackstop) {
      clearTimeout(exitCloseBackstop)
      exitCloseBackstop = null
    }
    for (const l of [...exitListeners]) {
      try {
        l(code, reason)
      } catch {
        // exit fan-out is best-effort
      }
    }
  }
  let buffer = ''
  // Oversized-line resync: past the cap the buffered prefix is dropped and
  // input is discarded until the next newline — one typed diagnostic, and
  // the stream stays alive instead of the heap growing without bound.
  let discardingOversizedLine = false
  let oversizedLinesDropped = 0
  const deliverLine = (line: string): void => {
    for (const l of [...lineListeners]) {
      try {
        l(line)
      } catch (e) {
        logForDebugging(`[crew/ndjsonChild] line listener threw (ignored): ${e}`)
      }
    }
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (discardingOversizedLine) {
        // This newline terminates the oversized line — resync from here.
        discardingOversizedLine = false
        oversizedLinesDropped++
        logForDebugging(
          `[crew/ndjsonChild:${cmd}] dropped an oversized line (> ${MAX_LINE_BUFFER_BYTES} bytes buffered) — resynced at the next newline (total dropped: ${oversizedLinesDropped})`,
        )
      } else if (line) {
        deliverLine(line)
      }
      nl = buffer.indexOf('\n')
    }
    if (!discardingOversizedLine && buffer.length > MAX_LINE_BUFFER_BYTES) {
      discardingOversizedLine = true
      buffer = ''
    } else if (discardingOversizedLine) {
      buffer = ''
    }
  })
  // Bounded stderr ring — the last bytes are the failure diagnosis.
  let stderrRing = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrRing = (stderrRing + chunk).slice(-STDERR_TAIL_BYTES)
    logForDebugging(`[crew/ndjsonChild:${cmd}] stderr: ${chunk.slice(0, 200)}`)
  })
  // A final line without a trailing newline must still be delivered — the
  // child said it; losing it on exit is a settlement lie.
  const flushTrailingPartialLine = (): void => {
    const tail = buffer.trim()
    buffer = ''
    if (tail && !discardingOversizedLine) {
      deliverLine(tail)
    }
  }
  // exit → close → drain: 'close' waits for stdio to drain, so it is the
  // settlement event; 'exit' only arms a bounded backstop for a close held
  // open by a grandchild-inherited fd (the ST-8 class at this owner).
  child.on('close', code => {
    flushTrailingPartialLine()
    settle(code)
  })
  child.on('exit', code => {
    if (settled || exitCloseBackstop) return
    exitCloseBackstop = setTimeout(() => {
      exitCloseBackstop = null
      flushTrailingPartialLine()
      settle(code)
    }, EXIT_CLOSE_BACKSTOP_MS)
    exitCloseBackstop.unref?.()
  })
  // Spawn failures (ENOENT: the CLI is not installed) and post-mortem pipe
  // errors emit 'error' — unowned, they escalate to the process-global
  // uncaughtException breaker. Own them: log + settle as a failed exit so
  // awaitLine callers fail fast with the real cause.
  child.on('error', err => {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`[crew/ndjsonChild:${cmd}] child error: ${msg}`)
    settle(null, msg)
  })
  // A broken stdin pipe means the seat can never be driven — that is a
  // TERMINAL fact for a bidirectional protocol child. Settle it so pending
  // awaitLine callers fail fast instead of idling out their timeouts.
  child.stdin?.on('error', err => {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`[crew/ndjsonChild:${cmd}] stdin error — settling as failed: ${msg}`)
    settle(null, `stdin error: ${msg}`)
  })
  return {
    write: line => {
      try {
        child.stdin?.write(line.endsWith('\n') ? line : `${line}\n`)
      } catch (e) {
        // The async 'error' event follows and settles the child.
        logForDebugging(`[crew/ndjsonChild:${cmd}] write failed: ${e}`)
      }
    },
    onLine: listener => {
      lineListeners.add(listener)
      return () => lineListeners.delete(listener)
    },
    onExit: listener => {
      if (settled) {
        const s = settled
        queueMicrotask(() => listener(s.code, s.reason))
        return () => {}
      }
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    kill: () => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    },
    stderrTail: () => stderrRing,
    killAndWait: (graceMs = KILL_ESCALATION_GRACE_MS) =>
      new Promise<void>(resolve => {
        if (settled) {
          resolve()
          return
        }
        let escalation: NodeJS.Timeout | null = null
        let hardBound: NodeJS.Timeout | null = null
        const finish = (): void => {
          if (escalation) clearTimeout(escalation)
          if (hardBound) clearTimeout(hardBound)
          resolve()
        }
        const unsub = (() => {
          const u = exitListeners
          const listener = (): void => {
            u.delete(listener)
            finish()
          }
          u.add(listener)
          return () => u.delete(listener)
        })()
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        escalation = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, graceMs)
        escalation.unref?.()
        // Never hang the shutdown sweep on an unkillable child — resolve
        // after the escalation had its own grace to land.
        hardBound = setTimeout(() => {
          unsub()
          finish()
        }, graceMs + KILL_ESCALATION_GRACE_MS)
        hardBound.unref?.()
      }),
    owned: true,
  }
}

/** Await one line matching `pred`, bounded — a silent child is 'unknown',
 *  never an invented acknowledgement, and a DEAD child fails immediately
 *  with its exit fact instead of idling out the full timeout. Malformed
 *  (unparseable) lines are counted and named in a failure reason — never
 *  silently indistinguishable from silence. */
export function awaitLine(
  child: NdjsonChildLike,
  pred: (parsed: unknown, raw: string) => boolean,
  timeoutMs: number,
): Promise<{ ok: true; parsed: unknown } | { ok: false; reason: string }> {
  return new Promise(resolve => {
    let done = false
    let malformedLines = 0
    const malformedNote = (): string =>
      malformedLines > 0 ? `; ${malformedLines} unparseable line(s) seen` : ''
    const settle = (result: { ok: true; parsed: unknown } | { ok: false; reason: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubLine()
      unsubExit()
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({ ok: false, reason: `no matching frame within ${timeoutMs}ms${malformedNote()}` })
    }, timeoutMs)
    timer.unref?.()
    const unsubLine = child.onLine(line => {
      if (done) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        malformedLines++
        if (malformedLines === 1) {
          logForDebugging(`[crew/ndjsonChild] unparseable frame (first sample): ${line.slice(0, 200)}`)
        }
        return
      }
      if (pred(parsed, line)) {
        settle({ ok: true, parsed })
      }
    })
    const unsubExit = child.onExit((code, reason) => {
      settle({
        ok: false,
        reason: `child exited (${reason ?? `code ${String(code)}`}) before a matching frame${malformedNote()}`,
      })
    })
  })
}
