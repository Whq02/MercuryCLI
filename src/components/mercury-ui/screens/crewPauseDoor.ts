import type { EngineCarrierKind } from '../../../services/engine-connector/types.js'
import type { PauseGate } from '../../../run-core/pauseGate.js'

export type CrewPauseReach =
  | { kind: 'blank' }
  | { kind: 'carrier'; carrier: EngineCarrierKind }

export type CrewPauseReceipt =
  | { outcome: 'applied'; paused: boolean }
  | { outcome: 'refused'; detail: string }

export const CREW_PAUSE_BLANK_REFUSAL = 'no chat is focused — nothing runs here to pause'

export const CREW_PAUSE_HOSTED_REFUSAL = "the pause cannot reach this session's runner yet — it runs in another process and no control verb carries a pause; the gate parks only loops in this process"

export const CREW_PAUSED_NOTE = 'paused — every agent and the chat parks at its next safe point (a stream or a tool in flight finishes first); p resumes them'

export const CREW_RESUMED_NOTE = 'resumed — every parked agent continues from where it stopped'

export function pressCrewPause(reach: CrewPauseReach, gate: PauseGate): CrewPauseReceipt {
  if (reach.kind === 'blank') return { outcome: 'refused', detail: CREW_PAUSE_BLANK_REFUSAL }
  if (reach.carrier !== 'in-process') return { outcome: 'refused', detail: CREW_PAUSE_HOSTED_REFUSAL }
  return { outcome: 'applied', paused: gate.toggle() }
}

export function crewPauseDoorKey(paused: boolean): string {
  return paused ? 'p resume' : 'p pause'
}

export function crewPauseDoorNote(receipt: CrewPauseReceipt): { tone: 'muted' | 'warning'; text: string } {
  if (receipt.outcome === 'refused') return { tone: 'warning', text: receipt.detail }
  return { tone: 'muted', text: receipt.paused ? CREW_PAUSED_NOTE : CREW_RESUMED_NOTE }
}
