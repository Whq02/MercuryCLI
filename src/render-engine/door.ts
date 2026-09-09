
import { writeSync } from 'node:fs'
import type { EngineClock, Unit } from './contracts.js'
import { REAL_ENGINE_CLOCK } from './contracts.js'

export interface DoorSyscalls {
  tryWrite(bytes: Buffer): number | 'EAGAIN' | 'closed'
  sleepSync(ms: number): void
}

const RETRY_MS = 8
const TEARDOWN_SPIN_QUANTUM_MS = 2
const TEARDOWN_BUDGET_MS = 400

export interface DoorEvents {
  onIdle?: () => void
}

export class WriteDoor {
  private queue: { unit: Unit; buf: Buffer; offset: number }[] = []
  private owed = 0
  private retryTimer: unknown = null
  private closed = false
  private unitsWritten = 0
  private bytesWritten = 0

  constructor(
    private readonly syscalls: DoorSyscalls,
    private readonly clock: EngineClock = REAL_ENGINE_CLOCK,
    private readonly events: DoorEvents = {},
  ) {}

  owedBytes(): number {
    return this.owed
  }

  deliveredUnits(): number {
    return this.unitsWritten
  }

  deliveredBytes(): number {
    return this.bytesWritten
  }

  isClosed(): boolean {
    return this.closed
  }

  enqueue(unit: Unit): void {
    if (this.closed) return
    const buf = Buffer.from(unit.bytes, 'utf8')
    if (buf.length === 0) return
    this.queue.push({ unit, buf, offset: 0 })
    this.owed += buf.length
    this.pump()
  }

  private pump = (): void => {
    if (this.closed) return
    while (this.queue.length > 0) {
      const head = this.queue[0]!
      const slice = head.offset === 0 ? head.buf : head.buf.subarray(head.offset)
      const res = this.syscalls.tryWrite(slice)
      if (res === 'closed') {
        this.closed = true
        this.owed = 0
        this.queue = []
        return
      }
      if (res === 'EAGAIN' || res === 0) {
        if (this.retryTimer === null) {
          this.retryTimer = this.clock.setTimeout(() => {
            this.retryTimer = null
            this.pump()
          }, RETRY_MS)
        }
        return
      }
      head.offset += res
      this.owed -= res
      this.bytesWritten += res
      if (head.offset >= head.buf.length) {
        this.queue.shift()
        this.unitsWritten++
      }
    }
    this.events.onIdle?.()
  }

  dispose(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.closed = true
    this.queue = []
    this.owed = 0
  }

  flushSync(budgetMs: number = TEARDOWN_BUDGET_MS): boolean {
    const start = this.clock.now()
    while (this.queue.length > 0 && !this.closed) {
      const head = this.queue[0]!
      const slice = head.offset === 0 ? head.buf : head.buf.subarray(head.offset)
      const res = this.syscalls.tryWrite(slice)
      if (res === 'closed') {
        this.closed = true
        this.owed = 0
        this.queue = []
        return false
      }
      if (res === 'EAGAIN' || res === 0) {
        if (this.clock.now() - start > budgetMs) return false
        this.syscalls.sleepSync(TEARDOWN_SPIN_QUANTUM_MS)
        continue
      }
      head.offset += res
      this.owed -= res
      this.bytesWritten += res
      if (head.offset >= head.buf.length) {
        this.queue.shift()
        this.unitsWritten++
      }
    }
    return this.queue.length === 0
  }
}

export function ttySyscalls(fd: number): DoorSyscalls {
  const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
  return {
    tryWrite(bytes: Buffer): number | 'EAGAIN' | 'closed' {
      try {
        return writeSync(fd, bytes)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return 'EAGAIN'
        if (code === 'EPIPE' || code === 'EIO') return 'closed'
        throw e
      }
    },
    sleepSync(ms: number): void {
      Atomics.wait(SLEEP_BUF, 0, 0, ms)
    },
  }
}
