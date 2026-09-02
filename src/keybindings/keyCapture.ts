
import type { Key } from '../ink.js'

export type KeyCaptureFn = (input: string, key: Key) => void

let capture: KeyCaptureFn | null = null

export function claimKeyCapture(fn: KeyCaptureFn): () => void {
  capture = fn
  return () => {
    if (capture === fn) capture = null
  }
}

export function currentKeyCapture(): KeyCaptureFn | null {
  return capture
}

export function resetKeyCaptureForTesting(): void {
  capture = null
}
