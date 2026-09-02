
export type CloseChordFn = () => void

let slot: CloseChordFn | null = null

export function claimConcourseCloseChord(fn: CloseChordFn): () => void {
  slot = fn
  return () => {
    if (slot === fn) slot = null
  }
}

export function invokeConcourseCloseChord(): void {
  slot?.()
}

export function concourseCloseChordClaimed(): boolean {
  return slot !== null
}

export function resetConcourseCloseChordForTesting(): void {
  slot = null
}
