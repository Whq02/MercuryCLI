/**
 * The compact-warning suppression flag. Suppression is set after a successful
 * compaction (accurate token counts are unavailable until the next API
 * response) and cleared at the start of a new compaction attempt. This module
 * is deliberately React-free: microcompact imports the pure functions, and
 * pulling React into that graph would drag it into the print-mode startup
 * path. The React subscription lives in compactWarningHook.ts.
 */

type Listener = () => void

let suppressed = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const compactWarningStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): boolean {
    return suppressed
  },
}

/** Called after a successful compaction. */
export function suppressCompactWarning(): void {
  if (!suppressed) {
    suppressed = true
    emit()
  }
}

/** Called at the start of a new compaction attempt. */
export function clearCompactWarningSuppression(): void {
  if (suppressed) {
    suppressed = false
    emit()
  }
}
