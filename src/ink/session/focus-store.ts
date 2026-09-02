
export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

let state: TerminalFocusState = 'unknown'
const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) cb()
}

export function setTerminalFocused(v: boolean): void {
  state = v ? 'focused' : 'blurred'
  notify()
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
  notify()
}
