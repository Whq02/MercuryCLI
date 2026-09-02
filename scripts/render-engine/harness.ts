
import type { EngineClock } from '../../src/render-engine/contracts.js'
import type { DoorSyscalls } from '../../src/render-engine/door.js'

export let failures = 0
export const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
export const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
export const finish = (): never => {
  console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

export class FakeClock implements EngineClock {
  private t = 0
  private nextId = 1
  private timers = new Map<number, { due: number; fn: () => void }>()

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { due: this.t + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(t: unknown): void {
    this.timers.delete(t as number)
  }

  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      let bestId = -1
      let bestDue = Infinity
      for (const [id, rec] of this.timers) {
        if (rec.due <= target && rec.due < bestDue) {
          bestDue = rec.due
          bestId = id
        }
      }
      if (bestId === -1) break
      const rec = this.timers.get(bestId)!
      this.timers.delete(bestId)
      this.t = Math.max(this.t, rec.due)
      rec.fn()
    }
    this.t = target
  }

  pendingTimers(): number {
    return this.timers.size
  }
}

export type SinkMode =
  | { kind: 'accept-all' }
  | { kind: 'refuse' }
  | { kind: 'ration'; bytesPerCall: number }

export class SpySink implements DoorSyscalls {
  mode: SinkMode = { kind: 'accept-all' }
  chunks: Buffer[] = []
  calls = 0
  eagains = 0

  stream(): Buffer {
    return Buffer.concat(this.chunks)
  }

  text(): string {
    return this.stream().toString('utf8')
  }

  tryWrite(bytes: Buffer): number | 'EAGAIN' | 'closed' {
    this.calls++
    if (this.mode.kind === 'refuse') {
      this.eagains++
      return 'EAGAIN'
    }
    const take =
      this.mode.kind === 'ration' ? Math.min(this.mode.bytesPerCall, bytes.length) : bytes.length
    this.chunks.push(Buffer.from(bytes.subarray(0, take)))
    return take
  }

  sleepSync(): void {
  }
}
