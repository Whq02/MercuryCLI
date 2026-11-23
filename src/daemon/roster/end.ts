import type { ChildProcess } from 'node:child_process'
import { killProcessGroup } from '../../platform/processes/processGroup.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { RosterOptions, WorkerHandle } from './types.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'
import { supportsGracefulSigterm } from '../../platform/host-os/processes.js'

export const RUNNER_ASK_BOUND_MS = 5_000

export function decideRunnerEnd(facts: {
  platform: NodeJS.Platform
  signal: NodeJS.Signals
  turnActive: boolean
  waitingOnAgents: number
  inputOpen: boolean
}): 'ask' | 'kill' {
  return !supportsGracefulSigterm(facts.platform) && facts.signal === 'SIGTERM' && !facts.turnActive && facts.waitingOnAgents === 0 && facts.inputOpen ? 'ask' : 'kill'
}

export class EndPart {
  private readonly asked = new Map<ChildProcess, ReturnType<typeof setTimeout>>()
  private readonly settledWaiters: Array<() => void> = []

  constructor(private readonly opts: RosterOptions) {}

  private dropAsked(child: ChildProcess): void {
    this.asked.delete(child)
    if (this.asked.size === 0 && this.settledWaiters.length > 0) {
      for (const resolve of this.settledWaiters.splice(0)) resolve()
    }
  }

  endChild(short: string, h: WorkerHandle, child: ChildProcess, signal: NodeJS.Signals): void {
    const standing = this.asked.get(child)
    if (standing !== undefined) {
      if (signal === 'SIGTERM') return
      stopTimeout(standing)
      this.dropAsked(child)
    }
    const input = child.stdin
    const verdict = decideRunnerEnd({
      platform: this.opts.platform ?? process.platform,
      signal,
      turnActive: h.longLived?.turnActive === true,
      waitingOnAgents: h.longLived?.waitingOnAgents ?? 0,
      inputOpen: h.longLived !== undefined && standing === undefined && input !== null && input !== undefined && !input.destroyed && !input.writableEnded,
    })
    if (verdict === 'kill' || input === null || input === undefined) {
      killProcessGroup(child, signal)
      return
    }
    logForDebugging(`[daemon] kill(${short}): the runner is idle, so its input is ended and it ends itself; its tree is killed if it stands after the bound`)
    const bound = startTimeout(() => {
      this.dropAsked(child)
      killProcessGroup(child, signal)
    }, this.opts.runnerAskBoundMs ?? RUNNER_ASK_BOUND_MS)
    bound.unref?.()
    this.asked.set(child, bound)
    child.once('exit', () => {
      stopTimeout(bound)
      this.dropAsked(child)
    })
    input.end()
  }

  async askedSettled(): Promise<void> {
    if (this.asked.size === 0) return
    await new Promise<void>(resolve => {
      this.settledWaiters.push(resolve)
    })
  }
}
