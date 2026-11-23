import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { DaemonBreaker } from '../control/daemonBreaker.js'
import { runTaskHeadless, buildHeadlessPrompt } from '../runner-link/headlessRun.js'
import { resolveWorkerReconAllow } from '../concourse-workers/workerRecon.js'
import { currentVersion } from '../control/controlSocket.js'
import type { DispatchBody, DispatchSource } from '../control/protocol.js'
import type { DispatchOutcome, RosterEntry, RosterOptions, WorkerHandle } from './types.js'

interface DispatchNeeds {
  reapSettled(keepRecent?: number): void
}

export class DispatchPart {
  private inFlight = 0

  constructor(
    private readonly opts: RosterOptions,
    private readonly handles: Map<string, WorkerHandle>,
    private readonly needs: DispatchNeeds,
  ) {}

  async dispatch(d: DispatchBody): Promise<DispatchOutcome> {
    const short = d.short || `w-${randomUUID().slice(0, 8)}`

    const existing = this.handles.get(short)
    if (existing && !existing.entry.outcome) {
      return { ok: false, short, code: 'EALIVE', error: 'a live worker already holds this id' }
    }

    if (this.opts.breaker.shouldSuppressFire()) {
      return {
        ok: false,
        short,
        code: 'ENOCONN',
        error: 'circuit-breaker OPEN — dispatch suppressed (cooling down)',
      }
    }
    if (this.inFlight >= this.opts.maxInflight) {
      return {
        ok: false,
        short,
        code: 'ENOCONN',
        error: `at max in-flight (${this.opts.maxInflight}) — retry shortly`,
      }
    }

    const cwd = d.cwd || this.opts.dir
    const source: DispatchSource = d.source ?? 'dispatch'
    const entry: RosterEntry = {
      short,
      sessionId: randomUUID(),
      prompt: d.prompt,
      source,
      state: 'spawning',
      startedAt: Date.now(),
      cliVersion: currentVersion(),
    }

    const via = await this.resolveVia()
    entry.via = via

    this.inFlight++
    let settleChild: ChildProcess | undefined
    const headlessPrompt = buildHeadlessPrompt({
      prompt: d.prompt,
      workflow: d.workflow,
    })
    const run = runTaskHeadless(
      { id: short, prompt: headlessPrompt, allowedTools: resolveWorkerReconAllow() },
      cwd,
      child => {
        settleChild = child
        entry.pid = child.pid
        entry.state = 'running'
      },
    )
      .then(res => {
        const failed = DaemonBreaker.isFailureExit(res.code)
        entry.outcome = res.code === null ? 'killed' : failed ? 'failed' : 'ok'
        entry.state = failed ? (res.code === null ? 'retiring' : 'crashed') : 'settled'
        if (res.timedOut === true && !DaemonBreaker.timeoutIsFleetFailure()) {
          this.opts.breaker.recordTimeout()
        } else {
          this.opts.breaker.recordResult(!failed)
        }
      })
      .catch(e => {
        logForDebugging(`[daemon] dispatch ${short} run error: ${e}`)
        entry.outcome = 'crashed'
        entry.state = 'crashed'
        this.opts.breaker.recordResult(false)
      })
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1)
        this.needs.reapSettled(32)
      })

    this.handles.set(short, { entry, child: settleChild, done: run })

    logForDebugging(`[daemon] dispatched ${short} via ${via} (source=${source})`)
    return { ok: true, short, pid: entry.pid, via }
  }

  private async resolveVia(): Promise<string> {
    return 'headless'
  }
}
