import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const DOUBLE_PRESS_TIMEOUT_MS: Unbuilt = unbuilt('src/hooks/useDoublePress.ts:6')

export const EXIT_CHORD_WINDOW_MS: Unbuilt = unbuilt('src/hooks/useDoublePress.ts:8')

export function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void,
  windowMs?: number,
): () => void {
  return notBuilt('src/hooks/useDoublePress.ts:10')
}
