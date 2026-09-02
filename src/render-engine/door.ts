// ============================================================================
//  render-engine/door.ts — ONE WRITER, WHOLE UNITS (law E4).
//
//  Every byte the engine sends to the terminal leaves through this one
//  serialized channel. A logical unit — a frame, a mode transition, a probe,
//  a bell, the teardown restore — is enqueued whole and delivered whole, in
//  enqueue order. There is no second buffered path, so interleaving one unit
//  into the middle of another is impossible by construction. The kernel may
//  accept a unit across several writes under backpressure; the remainder of
//  the head unit always goes out before the first byte of the next, so the
//  concatenated stream equals the concatenation of whole units.
//
//  Paint brackets (cursor hide/show, synchronized-output begin/end when
//  armed) open and close INSIDE one unit on every path including teardown —
//  the door carries bytes and never injects any.
//
//  The door is also where the terminal's drain truth lives (E6's input):
//  owedBytes() is the backlog the terminal still owes us acceptance for; the
//  scheduler reads it and declines to compose for a choked terminal.
// ============================================================================

import { writeSync } from 'node:fs'
import type { EngineClock, Unit } from './contracts.js'
import { REAL_ENGINE_CLOCK } from './contracts.js'

/** Injectable write syscalls — provers drive partial writes, EAGAIN storms
 *  and closed-pipe endings without a terminal. */
export interface DoorSyscalls {
  /** Attempt one write; returns bytes accepted, 'EAGAIN' for a full kernel
   *  buffer, 'closed' for a gone reader (EPIPE/EIO class). */
  tryWrite(bytes: Buffer): number | 'EAGAIN' | 'closed'
  /** Bounded synchronous sleep for the teardown flush only. */
  sleepSync(ms: number): void
}

const RETRY_MS = 8
const TEARDOWN_SPIN_QUANTUM_MS = 2
const TEARDOWN_BUDGET_MS = 400

export interface DoorEvents {
  /** Fires when the queue drains to zero owed bytes. */
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

  /** Bytes enqueued and not yet accepted by the kernel — the drain truth. */
  owedBytes(): number {
    return this.owed
  }

  /** Units fully delivered (diagnostics). */
  deliveredUnits(): number {
    return this.unitsWritten
  }

  /** Bytes fully delivered (diagnostics). */
  deliveredBytes(): number {
    return this.bytesWritten
  }

  isClosed(): boolean {
    return this.closed
  }

  /** Enqueue one whole unit and pump. The unit's bytes are serialized here,
   *  once; nothing may write around the door. */
  enqueue(unit: Unit): void {
    if (this.closed) return
    const buf = Buffer.from(unit.bytes, 'utf8')
    if (buf.length === 0) return
    this.queue.push({ unit, buf, offset: 0 })
    this.owed += buf.length
    this.pump()
  }

  /** Drive the head of the queue as far as the kernel accepts. EAGAIN arms
   *  one bounded retry timer; delivery order is FIFO always. */
  private pump = (): void => {
    if (this.closed) return
    while (this.queue.length > 0) {
      const head = this.queue[0]!
      const slice = head.offset === 0 ? head.buf : head.buf.subarray(head.offset)
      const res = this.syscalls.tryWrite(slice)
      if (res === 'closed') {
        // The reader is gone (process exit class): drop everything quietly.
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

  /**
   * Teardown flush: spin the queue out synchronously within a bounded budget
   * so the restore unit (bracket close, cursor show, mode resets) lands even
   * on a crash path. A terminal that stays wedged past the budget forfeits
   * the tail — the process is exiting either way.
   */
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

/** The real-TTY syscall binding (non-blocking fd writes). */
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
