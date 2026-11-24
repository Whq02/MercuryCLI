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
