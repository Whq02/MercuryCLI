import type { DOMElement } from '../dom.js'
import { notBuilt } from '../../pi/holes.js'

export function useAnimationValue<T extends string | number | boolean>(
  intervalMs: number | null,
  derive: (timeMs: number) => T,
): [ref: (element: DOMElement | null) => void, value: T] {
  return notBuilt('src/ink/hooks/use-animation-value.ts:8')
}
