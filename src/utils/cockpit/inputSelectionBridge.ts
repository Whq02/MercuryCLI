
export type InputSelectionRange = { start: number; end: number }

export type InputSelectionOwner = {
  range: () => InputSelectionRange | null
  own: () => (InputSelectionRange & { text: string }) | null
  clear: () => void
}

let owner: InputSelectionOwner | null = null

export function registerInputSelectionOwner(next: InputSelectionOwner): () => void {
  owner = next
  return () => {
    if (owner === next) owner = null
  }
}

export function peekInputSelectionRange(): InputSelectionRange | null {
  try {
    return owner?.range() ?? null
  } catch {
    return null
  }
}

export function peekOwnInputSelection(): (InputSelectionRange & { text: string }) | null {
  try {
    return owner?.own() ?? null
  } catch {
    return null
  }
}

export function clearOwnInputSelection(): void {
  try {
    owner?.clear()
  } catch {
    return
  }
}

type Listener = () => void
const changeListeners = new Set<Listener>()
const settleListeners = new Set<Listener>()
let changeVersion = 0

export function noteOwnInputSelectionChanged(): void {
  changeVersion += 1
  for (const listener of [...changeListeners]) {
    try {
      listener()
    } catch {
      continue
    }
  }
}

export function subscribeOwnInputSelection(listener: Listener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function ownInputSelectionVersion(): number {
  return changeVersion
}

export function noteOwnInputSelectionSettled(): void {
  for (const listener of [...settleListeners]) {
    try {
      listener()
    } catch {
      continue
    }
  }
}

export function subscribeOwnInputSelectionSettled(listener: Listener): () => void {
  settleListeners.add(listener)
  return () => {
    settleListeners.delete(listener)
  }
}
