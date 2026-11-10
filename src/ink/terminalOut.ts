import type { Writable } from 'node:stream'

export function termWrite(stream: Writable, bytes: string): void {
  if (bytes === '') return
  stream.write(bytes)
}
