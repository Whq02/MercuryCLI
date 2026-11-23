import type { Writable } from 'node:stream'

let heldMs = 0

export function noteTerminalWriteHeld(ms: number): void {
  if (ms > 0) heldMs += ms
}

export function takeTerminalWriteHeldMs(): number {
  const held = heldMs
  heldMs = 0
  return held
}

export function termWrite(stream: Writable, bytes: string): void {
  if (bytes === '') return
  const startedAt = performance.now()
  try {
    stream.write(bytes)
  } finally {
    noteTerminalWriteHeld(performance.now() - startedAt)
  }
}
