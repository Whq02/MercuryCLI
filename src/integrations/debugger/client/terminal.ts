import type { ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { createCombinedAbortSignal } from '../../../platform/async/combinedAbortSignal.js'
import { endProcessTree, endProcessTreeSurvivors } from '../../../platform/processes/processGroup.js'
import { throwIfDapAborted } from '../dapCancellation.js'
import type { DapTerminalRequest, DapTerminalRunner } from '../dapTerminal.js'
import { PARTIAL_OUTPUT_KEEP_BYTES, RING_LINE_MAX_CHARS } from './output.js'

interface TerminalNeeds {
  cwd(): string
  rootRunner(): DapTerminalRunner | undefined
  operationSignal(): AbortSignal | undefined
  lifetimeSignal(): AbortSignal
  cleanup(): { ended: number; survivors: number[] }
  pushOutput(line: string): void
  hostsDebuggee(): void
}

export class TerminalPart {
  #terminalRunner: DapTerminalRunner | undefined
  #terminalProcesses = new Set<ChildProcess>()
  #terminalReaps = new Map<ChildProcess, Promise<void>>()

  constructor(private readonly needs: TerminalNeeds) {}

  runner(): DapTerminalRunner | undefined {
    return this.#terminalRunner
  }

  setRunner(runner: DapTerminalRunner): void {
    this.#terminalRunner = runner
  }

  processes(): Set<ChildProcess> {
    return this.#terminalProcesses
  }

  #reapTerminalProcess(child: ChildProcess): Promise<void> {
    const pending = this.#terminalReaps.get(child)
    if (pending) return pending
    const reaped = (async () => {
      let receipt = await endProcessTree(child, 'SIGKILL')
      this.needs.cleanup().ended += receipt.ended
      if (receipt.survivors.length > 0 && child.pid !== undefined) {
        receipt = await endProcessTreeSurvivors(child.pid, receipt.survivors, 'SIGKILL')
        this.needs.cleanup().ended += receipt.ended
      }
      this.needs.cleanup().survivors.push(...receipt.survivors)
      if (receipt.survivors.length) this.needs.pushOutput(`[dap] debuggee cleanup could not end process(es): ${receipt.survivors.join(', ')}`)
      this.#terminalProcesses.delete(child)
      this.#terminalReaps.delete(child)
    })()
    this.#terminalReaps.set(child, reaped)
    return reaped
  }

  async reapTerminalProcesses(): Promise<void> {
    await Promise.all([...this.#terminalProcesses].map(child => this.#reapTerminalProcess(child)))
  }

  async runInTerminal(msg: Record<string, unknown>): Promise<number> {
    const args = (msg.arguments ?? {}) as Record<string, unknown>
    if (!Array.isArray(args.args) || args.args.length === 0 || !args.args.every(arg => typeof arg === 'string')) {
      throw new Error('runInTerminal needs a nonempty command argv of strings')
    }
    if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new Error('runInTerminal cwd must be a string')
    if (args.env !== undefined && (args.env === null || typeof args.env !== 'object' || Array.isArray(args.env) || !Object.values(args.env).every(value => value === null || typeof value === 'string'))) {
      throw new Error('runInTerminal env values must be strings or null')
    }
    const request: DapTerminalRequest = {
      args: args.args,
      cwd: path.resolve(this.needs.cwd(), typeof args.cwd === 'string' ? args.cwd : '.'),
      ...(args.env !== undefined ? { env: args.env as Record<string, string | null> } : {}),
    }
    const runner = this.needs.rootRunner()
    if (!runner) throw new Error('runInTerminal requires the session’s Bash permission context')
    const combined = createCombinedAbortSignal(this.needs.operationSignal(), { signalB: this.needs.lifetimeSignal() })
    const started: ChildProcess[] = []
    let partial = ''
    const output = (chunk: string): void => {
      const lines = (partial + chunk).split(/\r\n|\r|\n/)
      partial = (lines.pop() ?? '').slice(-PARTIAL_OUTPUT_KEEP_BYTES)
      for (const line of lines) this.needs.pushOutput(`[debuggee] ${line.slice(0, RING_LINE_MAX_CHARS)}`)
    }
    try {
      throwIfDapAborted(combined.signal)
      const processId = await runner(request, combined.signal, child => {
        this.#terminalProcesses.add(child)
        started.push(child)
        this.needs.hostsDebuggee()
        child.once('exit', () => { void this.#reapTerminalProcess(child) })
        child.once('close', () => { if (partial) { this.needs.pushOutput(`[debuggee] ${partial.slice(0, RING_LINE_MAX_CHARS)}`); partial = '' } })
      }, output)
      throwIfDapAborted(combined.signal)
      return processId
    } catch (error) {
      await Promise.all(started.map(child => this.#reapTerminalProcess(child)))
      throw error
    } finally {
      combined.cleanup()
    }
  }
}
