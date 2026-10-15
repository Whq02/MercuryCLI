import { logForDebugging } from '../utils/debug.js'

export interface SessionCloseContext {
  projectKey: string
  sessionId: string
  endedAt: string
  outcome: string
  transcriptPath: string
  handoff: string | null
}

type SessionCloser = (ctx: SessionCloseContext) => Promise<void>

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

export interface SessionCloseAsk {
  line: string
  tools?: string[]
}

type SessionCloseAskSource = (sessionId: string) => SessionCloseAsk | null

const asks: SessionCloseAskSource[] = []

export function registerSessionCloseAsk(fn: SessionCloseAskSource): () => void {
  asks.push(fn)
  return () => {
    const index = asks.indexOf(fn)
    if (index >= 0) asks.splice(index, 1)
  }
}

export function sessionCloseAsks(sessionId: string): SessionCloseAsk[] {
  const out: SessionCloseAsk[] = []
  for (const source of [...asks]) {
    try {
      const ask = source(sessionId)
      if (ask !== null && ask.line.trim() !== '') out.push(ask)
    } catch (error) {
      logForDebugging(`session close ask failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return out
}

export function _resetSessionClosersForTesting(): void {
  closers.length = 0
  asks.length = 0
  ranFor.clear()
}
