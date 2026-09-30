import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { advisorClock, advisorContextOptions, advisorNoteDue, composeAdvisorNote, type AdvisorNote, type AdvisorRoad } from './advisorNote.js'
import { loadAdvisorContext } from './advisorContext.js'
import { advisorSeatRefusal, advisorSessionSeat, readAdvisorSettings } from './advisorSettings.js'

const inFlight = new Set<string>()
const pendingNotes = new Map<string, AdvisorNote[]>()

export const ADVISOR_MAIN_TURN_MODES: ReadonlySet<string> = new Set(['prompt', 'task-notification'])

export function advisorMainTurnIsBoundary(command: Pick<QueuedCommand, 'mode'>): boolean {
  return ADVISOR_MAIN_TURN_MODES.has(command.mode)
}

export type AdvisorRoundVerdict = 'off' | 'waiting' | 'busy' | 'silent' | 'quiet' | 'delivered'

export async function advisorRound(
  agentId: string,
  rows: readonly Message[],
  deliver: (note: AdvisorNote) => void,
  road: AdvisorRoad = {},
): Promise<AdvisorRoundVerdict> {
  const settings = road.settings ?? readAdvisorSettings()
  if (advisorSeatRefusal(road.seat ?? advisorSessionSeat(), settings) !== undefined) return 'off'
  const context = await loadAdvisorContext(agentId, advisorContextOptions(road))
  if (!advisorNoteDue(context, settings.minutes, advisorClock(road)())) return 'waiting'
  if (inFlight.has(agentId)) {
    logForDebugging(`advisor: a note for ${agentId} is still being written — this boundary's note is skipped`)
    return 'busy'
  }
  inFlight.add(agentId)
  try {
    let quiet = false
    const note = await composeAdvisorNote(context, rows, {
      ...road,
      settings,
      onQuiet: verdict => {
        quiet = true
        road.onQuiet?.(verdict)
      },
    })
    if (note === null) return quiet ? 'quiet' : 'silent'
    deliver(note)
    return 'delivered'
  } catch (error) {
    logForDebugging(`advisor: the round for ${agentId} failed — ${error instanceof Error ? error.message : String(error)}`)
    return 'silent'
  } finally {
    inFlight.delete(agentId)
  }
}

export function stashAdvisorNote(agentId: string, note: AdvisorNote): void {
  const list = pendingNotes.get(agentId) ?? []
  list.push(note)
  pendingNotes.set(agentId, list)
}

export function takeAdvisorNotes(agentId: string): AdvisorNote[] {
  const list = pendingNotes.get(agentId) ?? []
  pendingNotes.delete(agentId)
  return list
}

export function peekAdvisorNotes(agentId: string): readonly AdvisorNote[] {
  return pendingNotes.get(agentId) ?? []
}

export function advisorMainRound(sessionId: string, rows: readonly Message[], road: AdvisorRoad = {}): Promise<AdvisorRoundVerdict> {
  return advisorRound(sessionId, rows, note => stashAdvisorNote(sessionId, note), road)
}

export function advisorMainTurnSettled(
  sessionId: string,
  command: Pick<QueuedCommand, 'mode'>,
  rows: readonly Message[],
  road: AdvisorRoad = {},
): Promise<AdvisorRoundVerdict | 'skipped'> {
  if (!advisorMainTurnIsBoundary(command)) return Promise.resolve('skipped')
  return advisorMainRound(sessionId, rows, road)
}

export function resetAdvisorRoadsForTests(): void {
  inFlight.clear()
  pendingNotes.clear()
}
