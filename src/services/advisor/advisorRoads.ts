import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { isAdvisorOrigin } from '../../utils/messages/noticeRows.js'
import { advanceAdvisorTurn, composeAdvisorNote, type AdvisorNote, type AdvisorRoad } from './advisorNote.js'
import { loadAdvisorContext } from './advisorContext.js'
import { readAdvisorSettings } from './advisorSettings.js'

const inFlight = new Set<string>()
const pendingNotes = new Map<string, AdvisorNote[]>()

export const ADVISOR_COUNTED_MODES: ReadonlySet<string> = new Set(['prompt', 'task-notification'])

export function advisorCountsTurn(command: Pick<QueuedCommand, 'mode' | 'origin'>): boolean {
  return ADVISOR_COUNTED_MODES.has(command.mode) && !isAdvisorOrigin(command.origin)
}

export type AdvisorRoundVerdict = 'off' | 'counted' | 'busy' | 'silent' | 'quiet' | 'delivered'

export async function advisorRound(
  agentId: string,
  rows: readonly Message[],
  deliver: (note: AdvisorNote) => void,
  road: AdvisorRoad = {},
): Promise<AdvisorRoundVerdict> {
  const settings = road.settings ?? readAdvisorSettings()
  if (!settings.enabled) return 'off'
  const context = await loadAdvisorContext(agentId, {
    ...(road.dir !== undefined ? { dir: road.dir } : {}),
    ...(road.persist !== undefined ? { persist: road.persist } : {}),
  })
  if (!advanceAdvisorTurn(context, settings.seats)) return 'counted'
  if (inFlight.has(agentId)) {
    logForDebugging(`advisor: a note for ${agentId} is still being written — this round's note is skipped`)
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

export function advisorMainTurnSettled(
  sessionId: string,
  command: Pick<QueuedCommand, 'mode' | 'origin'>,
  rows: readonly Message[],
  deliver: (note: AdvisorNote) => void,
  road: AdvisorRoad = {},
): Promise<AdvisorRoundVerdict | 'uncounted'> {
  if (!advisorCountsTurn(command)) return Promise.resolve('uncounted')
  return advisorRound(sessionId, rows, deliver, road)
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

export function advisorAgentRound(agentId: string, rows: readonly Message[], road: AdvisorRoad = {}): Promise<AdvisorRoundVerdict> {
  return advisorRound(agentId, rows, note => stashAdvisorNote(agentId, note), road)
}

export function resetAdvisorRoadsForTests(): void {
  inFlight.clear()
  pendingNotes.clear()
}
