import { createHash } from 'node:crypto'

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

export function actionFingerprint(nextAction: string): string {
  return digest(['action', nextAction.toLowerCase().replace(/\s+/g, ' ').trim()])
}


export interface RunProgressState {
  progressSinceDecision: number
}

export function emptyProgressState(): RunProgressState {
  return { progressSinceDecision: 0 }
}

export function foldEligibleProgress(prev: RunProgressState): RunProgressState {
  return { ...prev, progressSinceDecision: prev.progressSinceDecision + 1 }
}

export function foldStopDecision(prev: RunProgressState): RunProgressState {
  return { ...prev, progressSinceDecision: 0 }
}
