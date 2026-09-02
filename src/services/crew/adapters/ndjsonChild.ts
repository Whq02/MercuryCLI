
import { spawn, type ChildProcess } from 'node:child_process'
import { logForDebugging } from '../../../utils/debug.js'

const MAX_LINE_BUFFER_BYTES = 8 * 1024 * 1024
const EXIT_CLOSE_BACKSTOP_MS = 1_500
const STDERR_TAIL_BYTES = 4_096
const KILL_ESCALATION_GRACE_MS = 1_500

export interface NdjsonChildLike {
  write(line: string): void
  onLine(listener: (line: string) => void): () => void
  onExit(listener: (code: number | null, reason?: string) => void): () => void
  kill(): void
  readonly owned: boolean
  stderrTail?(): string
  killAndWait?(graceMs?: number): Promise<void>
}

export type SpawnImpl = (cmd: string, args: string[], opts: { cwd?: string }) => NdjsonChildLike

export function realNdjsonChild(cmd: string, args: string[], opts: { cwd?: string }): NdjsonChildLike {
  const child: ChildProcess = spawn(cmd, args, {
    windowsHide: true,
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lineListeners = new Set<(line: string) => void>()
  const exitListeners = new Set<(code: number | null, reason?: string) => void>()
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
      }
    }
  }
  let buffer = ''
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
  let stderrRing = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrRing = (stderrRing + chunk).slice(-STDERR_TAIL_BYTES)
    logForDebugging(`[crew/ndjsonChild:${cmd}] stderr: ${chunk.slice(0, 200)}`)
  })
  const flushTrailingPartialLine = (): void => {
    const tail = buffer.trim()
    buffer = ''
    if (tail && !discardingOversizedLine) {
      deliverLine(tail)
    }
  }
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
  child.on('error', err => {
    const msg = err instanceof Error ? err.message : String(err)
    logForDebugging(`[crew/ndjsonChild:${cmd}] child error: ${msg}`)
    settle(null, msg)
  })
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
        }
        escalation = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
          }
        }, graceMs)
        escalation.unref?.()
        hardBound = setTimeout(() => {
          unsub()
          finish()
        }, graceMs + KILL_ESCALATION_GRACE_MS)
        hardBound.unref?.()
      }),
    owned: true,
  }
}

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
