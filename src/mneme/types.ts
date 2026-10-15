export interface LedgerEngine {
  model: string
  at: string
}

interface LedgerHandoff {
  text: string
  at: string
}

export interface LedgerEntry {
  ordinal: number
  sessionId: string
  startedAt: string
  endedAt: string | null
  engines: LedgerEngine[]
  rulings: string[]
  retained: string[]
  corrected: string[]
  files: string[]
  outcome: string | null
  handoff: LedgerHandoff | null
}

export interface LiveSession {
  sessionId: string
  startedAt: string
}
