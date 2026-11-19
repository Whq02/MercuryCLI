import type { DapSession } from '../dapClient.js'

const CHILD_SESSION_MAX_DEFAULT = 16
const CHILD_SESSION_DEPTH_MAX_DEFAULT = 4
let childSessionMax = CHILD_SESSION_MAX_DEFAULT
let childSessionDepthMax = CHILD_SESSION_DEPTH_MAX_DEFAULT

export function _setDapChildBoundsForTesting(
  maxChildren = CHILD_SESSION_MAX_DEFAULT,
  maxDepth = CHILD_SESSION_DEPTH_MAX_DEFAULT,
): void {
  childSessionMax = maxChildren
  childSessionDepthMax = maxDepth
}

export function childBoundRefusal(session: DapSession): string | null {
  if (session.root().treeSize() - 1 >= childSessionMax) {
    return `child-session bound reached (${childSessionMax} per tree) — op:"disconnect" and re-launch to reset`
  }
  if (session.depth + 1 > childSessionDepthMax) {
    return `child-session depth bound reached (${childSessionDepthMax}) — refusing a deeper session`
  }
  return null
}

interface ReverseNeeds {
  respondToReverse(request: Record<string, unknown>, success: boolean, message?: string, body?: Record<string, unknown>): void
  pushOutput(line: string): void
  childBoundRefusal(): string | null
  createChildSession(configuration: Record<string, unknown>): DapSession
  operationSignal(): AbortSignal | undefined
  runChildDance(child: DapSession, requestKind: 'launch' | 'attach', configuration: Record<string, unknown>): Promise<void>
  runInTerminal(msg: Record<string, unknown>): Promise<number>
}

export class ReversePart {
  constructor(private readonly needs: ReverseNeeds) {}

  onReverseRequest(msg: Record<string, unknown>): void {
    const command = String(msg.command ?? '')
    if (command === 'startDebugging') {
      const args = (msg.arguments as Record<string, unknown> | undefined) ?? {}
      const configuration = (args.configuration as Record<string, unknown> | undefined) ?? {}
      const requestKind: 'launch' | 'attach' = args.request === 'attach' ? 'attach' : 'launch'
      const refusal = this.needs.childBoundRefusal()
      if (refusal) {
        this.needs.respondToReverse(msg, false, refusal)
        this.needs.pushOutput(`[dap] refused startDebugging: ${refusal}`)
        return
      }
      let child: DapSession
      try {
        child = this.needs.createChildSession(configuration)
      } catch (e) {
        const reason = `child session could not start: ${(e as Error).message}`
        this.needs.respondToReverse(msg, false, reason)
        this.needs.pushOutput(`[dap] ${reason}`)
        return
      }
      this.needs.respondToReverse(msg, true)
      void child.withOperation(this.needs.operationSignal(), () => this.needs.runChildDance(child, requestKind, configuration)).catch(err => {
        this.needs.pushOutput(
          `[dap] child session '${child.label}' failed to start: ${(err as Error).message}`,
        )
        child.killSync()
      })
      return
    }
    if (command === 'runInTerminal') {
      void this.needs.runInTerminal(msg).then(
        processId => this.needs.respondToReverse(msg, true, undefined, { processId }),
        error => {
          const reason = error instanceof Error ? error.message : String(error)
          this.needs.respondToReverse(msg, false, reason)
          this.needs.pushOutput(`[dap] runInTerminal: ${reason}`)
        },
      )
      return
    }
    this.needs.respondToReverse(msg, false, `unsupported reverse request '${command}'`)
  }
}
