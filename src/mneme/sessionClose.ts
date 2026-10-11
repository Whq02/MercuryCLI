import { logForDebugging } from '../utils/debug.js'

export interface SessionCloseContext {
  projectKey: string
  sessionId: string
  endedAt: string
  outcome: string
  transcriptPath: string
  handoff: string | null
}

export type SessionCloser = (ctx: SessionCloseContext) => Promise<void>

const closers: SessionCloser[] = []
const ranFor = new Set<string>()

export function registerSessionCloser(fn: SessionCloser): () => void {
  closers.push(fn)
  return () => {
    const index = closers.indexOf(fn)
    if (index >= 0) closers.splice(index, 1)
  }
}

export function sessionClosersCount(): number {
  return closers.length
}

export async function runSessionClosers(ctx: SessionCloseContext): Promise<{ ran: number; failed: number; skipped: boolean }> {
  if (ranFor.has(ctx.sessionId)) return { ran: 0, failed: 0, skipped: true }
  ranFor.add(ctx.sessionId)
  let ran = 0
  let failed = 0
  for (const closer of [...closers]) {
    try {
      await closer(ctx)
      ran++
    } catch (error) {
      failed++
      logForDebugging(`session closer failed for ${ctx.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ran, failed, skipped: false }
}

export function _resetSessionClosersForTesting(): void {
  closers.length = 0
  ranFor.clear()
}
