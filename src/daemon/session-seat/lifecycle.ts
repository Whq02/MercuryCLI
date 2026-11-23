import { retireWorkerAsks, RUNNER_RESTARTED_ASK_CAUSE, RUNNER_ENDED_ASK_CAUSE } from './permissionAsks.js'
import { seatOf, seatGenerations, liveRecordByShort, type SeatRosterPort, seats } from './state.js'
import { setSeatTail, clearSeatProgress } from './stream.js'
import { drainPendingKitDials } from './kit.js'
import { forwardRecordSpawnSwitches, drainPendingSpawnSwitches } from './spawnSwitch.js'
import { pushScheduleRoster, publishSeatFacts, requestSessionFacts } from './facts.js'
import { stopTimeout } from '../../platform/async/timers.js'

export function onSeatSpawned(short: string, roster: SeatRosterPort, dir?: string): void {
  retireWorkerAsks(short, RUNNER_RESTARTED_ASK_CAUSE, dir)
  const seat = seatOf(short)
  seat.lastAnswer = null
  seat.generation += 1
  seatGenerations.set(short, seat.generation)
  seat.heldModel = null
  seat.heldEffort = null
  seat.heldSpawnSwitches = {}
  seat.sessionId = liveRecordByShort(short, dir)?.sessionId ?? null
  seat.turnChars = 0
  seat.turnOutputTokens = null
  seat.messageOutputTokens = 0
  seat.turnThinkingChars = 0
  seat.turnThinkingBlocks = 0
  seat.firstByteAtMs = null
  seat.tailMessageId = null
  seat.tailPhase = null
  seat.tailWithdrawn = null
  const hadWord = seat.stateWord !== null || seat.wait !== null
  seat.stateWord = null
  seat.waitingOnAgents = 0
  seat.fold = null
  seat.wait = null
  const hadLiveness = seat.lastEventAtMs !== null || seat.streamBlock !== null
  seat.lastEventAtMs = null
  seat.streamBlock = null
  seat.blockSinceMs = null
  if (seat.livenessTimer !== null) {
    stopTimeout(seat.livenessTimer)
    seat.livenessTimer = null
  }
  seat.livenessDirty = false
  if (seat.tail !== null || hadWord || hadLiveness) setSeatTail(seat, null, dir)
  clearSeatProgress(seat, dir)
  drainPendingKitDials(short, roster, dir)
  forwardRecordSpawnSwitches(short, roster, dir)
  drainPendingSpawnSwitches(short, roster, dir)
  pushScheduleRoster(short, roster, dir)
  publishSeatFacts(short, dir, roster)
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

export function onSeatSettled(short: string): void {
  retireWorkerAsks(short, RUNNER_ENDED_ASK_CAUSE)
  const seat = seats.get(short)
  if (seat?.debounce !== null && seat?.debounce !== undefined) stopTimeout(seat.debounce)
  if (seat?.workPoll !== null && seat?.workPoll !== undefined) stopTimeout(seat.workPoll)
  if (seat?.tailTimer !== null && seat?.tailTimer !== undefined) stopTimeout(seat.tailTimer)
  if (seat?.progressTimer !== null && seat?.progressTimer !== undefined) stopTimeout(seat.progressTimer)
  if (seat?.livenessTimer !== null && seat?.livenessTimer !== undefined) stopTimeout(seat.livenessTimer)
  seats.delete(short)
}
