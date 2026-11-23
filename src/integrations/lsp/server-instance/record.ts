import type { LSPClient, LSPStopResult } from '../LSPClient.js'
import type { LspServerState } from '../types.js'

export interface LspServerRecord {
  state: LspServerState
  client: LSPClient | null
  clientPromise: Promise<LSPClient> | null
  startTime: number | undefined
  lastError: Error | undefined
  restartCount: number
  crashRecoveries: number
  generation: number
  inFlightStart: Promise<void> | null
  initFailures: number
  lastInitFailureAt: number
  missingComponentCall: object | undefined
  idleTimer: NodeJS.Timeout | null
  lastActivityAt: number
  inFlightStop: Promise<LSPStopResult | undefined> | null
}
