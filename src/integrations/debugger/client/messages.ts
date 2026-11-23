import type { DapSession } from '../dapClient.js'
import { applyBreakpointEvent } from './breakpoints.js'
import type { OutputPart } from './output.js'
import type { ReversePart } from './reverse.js'
import type { TerminalPart } from './terminal.js'
import type { WirePart } from './wire.js'

let stopStamp = 0

interface MessagesNeeds {
  reverse(): ReversePart
  wire(): WirePart
  out(): OutputPart
  terminal(): TerminalPart
  lifetime(): AbortController
  resolveInitialized(): void
  hostsDebuggee(): void
  wakeStateWaiters(): void
}

export class MessagesPart {
  constructor(
    private readonly session: DapSession,
    private readonly needs: MessagesNeeds,
  ) {}

  onMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'request') {
      this.needs.reverse().onReverseRequest(msg)
      return
    }
    if (msg.type === 'response') {
      this.needs.wire().onResponse(msg)
      return
    }
    if (msg.type === 'event') {
      const body = (msg.body as Record<string, unknown>) ?? {}
      switch (msg.event) {
        case 'initialized':
          this.needs.resolveInitialized()
          break
        case 'process':
        case 'thread':
          this.needs.hostsDebuggee()
          break
        case 'stopped':
          this.needs.hostsDebuggee()
          this.session.lastStopped = {
            reason: String(body.reason ?? 'unknown'),
            threadId: typeof body.threadId === 'number' ? body.threadId : undefined,
            description:
              typeof body.description === 'string' ? body.description : undefined,
          }
          this.session.lastStoppedAt = ++stopStamp
          this.needs.wakeStateWaiters()
          break
        case 'continued':
          this.session.lastStopped = null
          break
        case 'output': {
          if (body.category === 'telemetry') break
          this.needs.out().pushOutputChunk(String(body.output ?? ''))
          break
        }
        case 'breakpoint': {
          applyBreakpointEvent(this.session, body)
          break
        }
        case 'terminated':
        case 'exited':
          this.session.terminated = true
          this.needs.lifetime().abort()
          void this.needs.terminal().reapTerminalProcesses()
          this.session.flushPartialOutput()
          if (msg.event === 'exited') {
            this.session.exitDetail = `debuggee exited (code ${String(body.exitCode ?? '?')})`
          }
          this.needs.wakeStateWaiters()
          break
        default:
          break
      }
    }
  }
}
