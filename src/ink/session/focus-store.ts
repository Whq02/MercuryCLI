export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

let state: TerminalFocusState = 'unknown'
const subscribers = new Set<() => void>()

function tellSubscribers(): void {
  for (const subscriber of subscribers) subscriber()
}

export function setTerminalFocused(v: boolean): void {
  state = v ? 'focused' : 'blurred'
  tellSubscribers()
}

export function getTerminalFocused(): boolean {
  return state !== 'blurred'
}

export function getTerminalFocusState(): TerminalFocusState {
  return state
}

export function subscribeTerminalFocus(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function resetTerminalFocusState(): void {
  state = 'unknown'
  tellSubscribers()
}
