import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type TerminalFocusState = Unbuilt

export function setTerminalFocused(v: boolean): void {
  return notBuilt('src/ink/session/focus-store.ts:11')
}

export function getTerminalFocused(): boolean {
  return notBuilt('src/ink/session/focus-store.ts:16')
}

export function getTerminalFocusState(): TerminalFocusState {
  return notBuilt('src/ink/session/focus-store.ts:20')
}

export function subscribeTerminalFocus(cb: () => void): () => void {
  return notBuilt('src/ink/session/focus-store.ts:24')
}

export function resetTerminalFocusState(): void {
  return notBuilt('src/ink/session/focus-store.ts:31')
}
