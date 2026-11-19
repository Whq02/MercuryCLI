import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DapSession } from '../dapClient.js'
import { endProcessTree, endProcessTreeSurvivors } from '../../../utils/processGroup.js'
import type { TerminalPart } from './terminal.js'
import type { WirePart } from './wire.js'

interface LifeNeeds {
  lifetime(): AbortController
  terminal(): TerminalPart
  wire(): WirePart
  child(): ChildProcessWithoutNullStreams | null
  wakeStateWaiters(): void
  pushOutput(line: string): void
}

export class LifePart {
  constructor(
    private readonly session: DapSession,
    private readonly needs: LifeNeeds,
  ) {}

  watchChild(child: ChildProcessWithoutNullStreams): void {
    child.stderr.on('data', (chunk: Buffer) => {
      this.needs.pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      if (!this.session.terminated) this.session.exitDetail = `adapter exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`
      this.session.terminated = true
      this.needs.lifetime().abort()
      void this.needs.terminal().reapTerminalProcesses()
      for (const [, p] of this.needs.wire().pending()) {
        p.cancelDeadline()
        p.reject(new Error(this.session.exitDetail))
      }
      this.needs.wire().pending().clear()
      this.needs.wakeStateWaiters()
    })
    child.on('error', err => {
      this.session.terminated = true
      this.session.exitDetail = `adapter failed to start: ${err.message}`
      this.needs.lifetime().abort()
      void this.needs.terminal().reapTerminalProcesses()
      for (const [, p] of this.needs.wire().pending()) {
        p.cancelDeadline()
        p.reject(new Error(this.session.exitDetail))
      }
      this.needs.wire().pending().clear()
      this.needs.wakeStateWaiters()
    })
  }

  socketClosed(closedDetail: string): void {
    if (!this.session.terminated) {
      this.session.terminated = true
      this.session.exitDetail = this.session.exitDetail || closedDetail
      this.needs.lifetime().abort()
      void this.needs.terminal().reapTerminalProcesses()
      this.needs.wakeStateWaiters()
    }
  }

  async dispose(signal: AbortSignal | undefined): Promise<void> {
    this.needs.lifetime().abort()
    await this.needs.terminal().reapTerminalProcesses()
    for (const child of [...this.session.children]) {
      await child.dispose(signal)
    }
    if (this.session.listener === null || this.session.capabilities !== null) {
      try {
        await this.session.request('disconnect', this.session.disconnectArguments(), 2_000, signal)
      } catch {
      }
    }
    const child = this.needs.child()
    if (child !== null && child.exitCode === null) {
      const receipt = await endProcessTree(child, 'SIGKILL')
      if (receipt.survivors.length > 0 && child.pid) {
        await endProcessTreeSurvivors(child.pid, receipt.survivors, 'SIGKILL')
      }
    }
    this.session.killSync()
  }
}

export function disconnectArguments(session: DapSession): Record<string, unknown> {
  if (session.capabilities?.supportTerminateDebuggee !== true) return {}
  return { terminateDebuggee: session.startMode !== 'attach' }
}
