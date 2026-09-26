import type { AgentControlReceiptV1, EngineCarrierKind } from '../../../services/engine-connector/types.js'
import type { PauseGate } from '../../../run-core/pauseGate.js'

export type CrewPauseReach =
  | { kind: 'blank' }
  | { kind: 'carrier'; carrier: EngineCarrierKind; hostedPaused: boolean; send: (paused: boolean) => Promise<AgentControlReceiptV1> }

export type CrewPauseReceipt =
  | { outcome: 'applied'; paused: boolean }
  | { outcome: 'refused'; detail: string }

export const CREW_PAUSE_BLANK_REFUSAL = 'no chat is focused — nothing runs here to pause'

export const CREW_PAUSE_UNANSWERED = "the session's runner gave no reason"

export const CREW_PAUSED_NOTE = 'paused — every agent and the chat parks at its next safe point (a stream or a tool in flight finishes first); p resumes them'

export const CREW_RESUMED_NOTE = 'resumed — every parked agent continues from where it stopped'

function pausedOfDetail(detail: string | undefined): boolean | null {
  if (detail === undefined) return null
  try {
    const parsed = JSON.parse(detail) as { paused?: unknown }
    return typeof parsed.paused === 'boolean' ? parsed.paused : null
  } catch {
    return null
  }
}

export async function pressCrewPause(reach: CrewPauseReach, gate: PauseGate): Promise<CrewPauseReceipt> {
  if (reach.kind === 'blank') return { outcome: 'refused', detail: CREW_PAUSE_BLANK_REFUSAL }
  if (reach.carrier === 'in-process') return { outcome: 'applied', paused: gate.toggle() }
  const next = !reach.hostedPaused
  const receipt = await reach.send(next)
  if (receipt.outcome !== 'applied') return { outcome: 'refused', detail: receipt.detail ?? CREW_PAUSE_UNANSWERED }
  return { outcome: 'applied', paused: pausedOfDetail(receipt.detail) ?? next }
}

export function crewPauseDoorKey(paused: boolean): string {
  return paused ? 'p resume' : 'p pause'
}

export function crewPauseDoorNote(receipt: CrewPauseReceipt): { tone: 'muted' | 'warning'; text: string } {
  if (receipt.outcome === 'refused') return { tone: 'warning', text: receipt.detail }
  return { tone: 'muted', text: receipt.paused ? CREW_PAUSED_NOTE : CREW_RESUMED_NOTE }
}
