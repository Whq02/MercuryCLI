import type { DOMElement } from '../dom.js'
import { notBuilt } from '../../pi/holes.js'

export function useAnimationFrame(
  intervalMs?: number | null,
): [ref: (el: DOMElement | null) => void, time: number] {
  return notBuilt('src/ink/hooks/use-animation-frame.ts:11')
}
