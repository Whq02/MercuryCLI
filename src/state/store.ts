import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type Store<T> = Unbuilt

export function createStore<T>(
  initialState: T,
  onChange?: (change: { newState: T; oldState: T }) => void,
): Store<T> {
  return notBuilt('src/state/store.ts:8')
}
