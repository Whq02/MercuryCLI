import type { ChildProcess } from 'node:child_process'
import { killProcessGroup } from '../../utils/processGroup.js'
import { logForDebugging } from '../../utils/debug.js'
import { sleep } from '../../utils/sleep.js'
import type { RosterOptions, WorkerHandle } from './types.js'

export const RUNNER_ASK_BOUND_MS = 5_000

export function decideRunnerEnd(facts: {
  platform: NodeJS.Platform
  signal: NodeJS.Signals
  turnActive: boolean
  waitingOnAgents: number
  inputOpen: boolean
}): 'ask' | 'kill' {
  return facts.platform === 'win32' && facts.signal === 'SIGTERM' && !facts.turnActive && facts.waitingOnAgents === 0 && facts.inputOpen ? 'ask' : 'kill'
}

export class EndPart {
  private readonly asked = new Map<ChildProcess, ReturnType<typeof setTimeout>>()

  constructor(private readonly opts: RosterOptions) {}

  endChild(short: string, h: WorkerHandle, child: ChildProcess, signal: NodeJS.Signals): void {
    const standing = this.asked.get(child)
    if (standing !== undefined) {
      if (signal === 'SIGTERM') return
      clearTimeout(standing)
      this.asked.delete(child)
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
    const bound = setTimeout(() => {
      this.asked.delete(child)
      killProcessGroup(child, signal)
    }, this.opts.runnerAskBoundMs ?? RUNNER_ASK_BOUND_MS)
    bound.unref?.()
    this.asked.set(child, bound)
    child.once('exit', () => {
      clearTimeout(bound)
      this.asked.delete(child)
    })
    input.end()
  }

  async askedSettled(): Promise<void> {
    while (this.asked.size > 0) await sleep(25)
  }
}
