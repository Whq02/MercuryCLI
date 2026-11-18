import type { Command } from '../../commands.js'
import type { Message } from '../../types/message.js'
import { createContentReplacementState, type ContentReplacementState } from '../../utils/toolResultStorage.js'

export type RunnerState = {
  awaitingSessionClaim: boolean
  bootRefusalFact: string | null
  turnsRun: number
  currentTurnId: string | null
  resumeOf: string | undefined
  turnMessages: (() => readonly Message[]) | null
  contentReplacementState: ContentReplacementState
  mcpInitialized: boolean
  claimSettling: Promise<void> | null
  sessionFactsHoldSpent: boolean
  sessionFactsHold: Promise<void> | null
  runnerRestartReason: string | undefined
  recoveredCommandIds: string[]
  activeModel: string | undefined
  activeCommands: Command[]
  inputClosed: boolean
  inFlightAbort: AbortController | null
  leaveAbort: AbortController | null
  heldSeatModel: { requestId: number; model: string; words?: string } | null
  heldSeatEffort: { requestId: number; effort: string } | null
  deferredSpawnSwitches: Array<{ kind: 'subagents'; on: boolean; requestId: number }>
}

export function createRunnerState(): RunnerState {
  return {
    awaitingSessionClaim: false,
    bootRefusalFact: null,
    turnsRun: 0,
    currentTurnId: null,
    resumeOf: undefined,
    turnMessages: null,
    contentReplacementState: createContentReplacementState(),
    mcpInitialized: false,
    claimSettling: null,
    sessionFactsHoldSpent: false,
    sessionFactsHold: null,
    runnerRestartReason: undefined,
    recoveredCommandIds: [],
    activeModel: undefined,
    activeCommands: [],
    inputClosed: false,
    inFlightAbort: null,
    leaveAbort: null,
    heldSeatModel: null,
    heldSeatEffort: null,
    deferredSpawnSwitches: [],
  }
}
