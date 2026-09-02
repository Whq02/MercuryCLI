import { flagEnv } from '../../substrate/flagRegistry.js'


export type PointerShape = 'text' | 'default'

export function pointerShapeEnabled(): boolean {
  if (flagEnv('MERCURY_POINTER_SHAPE') === '0') return false
  return true
}

let lastShape: PointerShape | null = null

export function pointerShapeSeq(shape: PointerShape): string {
  return `\x1b]22;${shape}\x07`
}

export const POINTER_SHAPE_RESET = '\x1b]22;\x07'

export function applyPointerShape(
  selectable: boolean,
  write: (s: string) => void,
): void {
  if (!pointerShapeEnabled()) return
  const shape: PointerShape = selectable ? 'text' : 'default'
  if (shape === lastShape) return
  lastShape = shape
  write(pointerShapeSeq(shape))
}

export function resetPointerShape(write: (s: string) => void): void {
  if (lastShape === null) return
  lastShape = null
  if (!pointerShapeEnabled()) return
  write(POINTER_SHAPE_RESET)
}

export function resetPointerShapeForTest(): void {
  lastShape = null
}
