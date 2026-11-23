import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Socket } from 'node:net'
import type { DapSession } from '../dapClient.js'
import { pythonSpawnEnv } from '../debugpyResolver.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { endProcessTree, endProcessTreeSurvivors, strikeProcessGroupNow } from '../../../platform/processes/processGroup.js'
import { childGetsOwnProcessGroup } from '../../../platform/host-os/processes.js'
import type { DapAdapterSpec, DapListenerTarget } from './shared.js'
import type { TerminalPart } from './terminal.js'
import type { WirePart } from './wire.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

interface LifeNeeds {
  lifetime(): AbortController
  terminal(): TerminalPart
  wire(): WirePart
  child(): ChildProcessWithoutNullStreams | null
  wakeStateWaiters(): void
  pushOutput(line: string): void
}

type Transport = { child: ChildProcessWithoutNullStreams | null; listener: DapListenerTarget | null; ready: Promise<void> }

export class LifePart {
  constructor(
    private readonly session: DapSession,
    private readonly needs: LifeNeeds,
  ) {}

  openTransport(
    spec: DapAdapterSpec,
    cwd: string,
    tcpPort: number | undefined,
    wire: 'spawn' | 'dial',
    listener: (DapListenerTarget & { socket?: Socket }) | undefined,
  ): Transport {
    if (wire === 'dial' && listener !== undefined) {
      return {
        child: null,
        listener: { host: listener.host, port: listener.port },
        ready:
          listener.socket !== undefined
            ? this.needs.wire().adoptSocket(listener.socket, `the program listening at ${listener.host}:${listener.port} closed the connection`)
            : this.needs.wire().connectTcp(listener.port, listener.host),
      }
    }
    if (wire === 'dial') {
      if (tcpPort === undefined) {
        this.session.terminated = true
        this.session.exitDetail = 'dial session has no server port'
        const ready: Promise<void> = Promise.reject(new Error(this.session.exitDetail))
        ready.catch(passedOver)
        return { child: null, listener: null, ready }
      }
      return { child: null, listener: null, ready: this.needs.wire().connectTcp(tcpPort) }
    }
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: childGetsOwnProcessGroup(),
      env: pythonSpawnEnv(),
    })
    child.stdin.on('error', err => logForDebugging(`dap: adapter stdin error: ${err.message}`))
    let ready: Promise<void>
    if (spec.connect === 'tcp' && tcpPort !== undefined) {
      child.stdout.on('data', (chunk: Buffer) => {
        this.needs.pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
      })
      ready = this.needs.wire().connectTcp(tcpPort)
    } else {
      child.stdout.on('data', (chunk: Buffer) => this.needs.wire().onData(chunk))
      ready = Promise.resolve()
    }
    this.watchChild(child)
    return { child, listener: null, ready }
  }

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
      } catch (error) {
        passedOver(error)
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

  killSync(): void {
    this.needs.lifetime().abort()
    for (const process of this.needs.terminal().processes()) {
      strikeProcessGroupNow(process, 'SIGKILL')
      process.kill('SIGKILL')
    }
    this.needs.terminal().processes().clear()
    for (const child of [...this.session.children]) {
      try {
        child.killSync()
      } catch (error) {
        passedOver(error)
      }
    }
    try {
      this.needs.wire().socket()?.destroy()
    } catch (error) {
      passedOver(error)
    }
    const adapter = this.needs.child()
    if (adapter && adapter.exitCode === null) adapter.kill('SIGKILL')
    this.session.terminated = true
    for (const [, p] of this.needs.wire().pending()) {
      p.cancelDeadline()
      p.reject(new Error('session disposed'))
    }
    this.needs.wire().pending().clear()
    this.needs.wakeStateWaiters()
  }
}

export function disconnectArguments(session: DapSession): Record<string, unknown> {
  if (session.capabilities?.supportTerminateDebuggee !== true) return {}
  return { terminateDebuggee: session.startMode !== 'attach' }
}
