
export interface BoardReturnState {
  rowKey?: string
  sectionId?: string
  drafts?: Record<string, string>
  atMs: number
}

const states = new Map<string, BoardReturnState>()

export function captureReturnState(surface: string, state: BoardReturnState): void {
  const prev = states.get(surface)
  states.set(surface, {
    ...prev,
    ...state,
    ...(state.rowKey === undefined && prev?.rowKey !== undefined ? { rowKey: prev.rowKey } : {}),
    ...(state.drafts === undefined && prev?.drafts !== undefined ? { drafts: prev.drafts } : {}),
  })
}

export function restoreReturnState(surface: string): BoardReturnState | null {
  return states.get(surface) ?? null
}

export function clearReturnState(surface: string): void {
  states.delete(surface)
}

export function _resetReturnStateForTesting(): void {
  states.clear()
}
