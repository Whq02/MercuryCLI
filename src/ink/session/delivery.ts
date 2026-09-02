import { appendFileSync, writeSync } from 'node:fs'
import type { Writable } from 'stream'
import { terminalDoor } from '../../render-engine/cockpit/terminalOut.js'
import { getClearTerminalSequence } from './capabilities.js'
import type { Diff } from '../frame.js'
import { cursorMove, cursorTo, eraseLines } from '../termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'
import { link } from '../termio/osc.js'

// ============================================================================
//  delivery — the Mercury terminal write path.
//
//  RESPONSIBILITY: one frame's patches → one serialized string → LOSS-PROOF
//  delivery to the terminal. On a TTY whose open file description is
//  non-blocking (raw-mode stdin shares it), a burst frame can overrun the
//  kernel PTY buffer and complete PARTIALLY — the silently-dropped tail is
//  the ledgered STALE-PAINT ghost (model and terminal diverge and the diff
//  never heals). The fd path therefore writes with a bounded EAGAIN-waiting
//  loop; an undeliverable frame reports false so the caller can contaminate
//  the next frame into a full re-emit.
//
//  CONTRACT: LAW PATCH-BYTES + LAW DELIVERY in
//  scripts/core-runtime/prove-session-contract.ts; the INK_WRITE_TEE
//  forensics format is byte-compatible.
// ============================================================================

export type Terminal = {
  stdout: Writable
  stderr: Writable
}

/** Injectable syscalls — LAW DELIVERY drives partial writes, EAGAIN storms
 *  and EPIPE through this seam without a real TTY. */
export type DeliverySyscalls = {
  writeSync: (fd: number, data: Buffer, offset: number) => number
  /** Synchronous sleep (the EAGAIN backoff quantum). */
  sleep: (ms: number) => void
}

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
const defaultSyscalls: DeliverySyscalls = {
  writeSync: (fd, data, offset) => writeSync(fd, data, offset),
  sleep: ms => {
    Atomics.wait(SLEEP_BUF, 0, 0, ms)
  },
}

/** EAGAIN spins of the LAST delivery (×2.5ms ≈ backpressure wait) — the
 *  INK_WRITE_TEE forensics field. */
let lastWriteSpins = 0

const SPIN_LIMIT = 400
const SPIN_QUANTUM_MS = 2.5

/** Write ALL of data to fd, waiting out EAGAIN. False ⇒ gave up on a wedged
 *  reader (~1s); EPIPE/EIO ⇒ true (the process is exiting — a crash in the
 *  render loop would only replace an async stream error). */
export function writeAllSync(
  fd: number,
  data: Buffer,
  syscalls: DeliverySyscalls = defaultSyscalls,
): boolean {
  let offset = 0
  lastWriteSpins = 0
  while (offset < data.length) {
    try {
      offset += syscalls.writeSync(fd, data, offset)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        if (++lastWriteSpins > SPIN_LIMIT) return false
        syscalls.sleep(SPIN_QUANTUM_MS)
        continue
      }
      if (code === 'EPIPE' || code === 'EIO') return true
      throw e
    }
  }
  return true
}

/** Serialize one patch list to its terminal bytes (no sync markers). */
function serializePatches(diff: Diff): string {
  let out = ''
  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        out += patch.content
        break
      case 'clear':
        if (patch.count > 0) out += eraseLines(patch.count)
        break
      case 'clearTerminal':
        out += getClearTerminalSequence()
        break
      case 'cursorHide':
        out += HIDE_CURSOR
        break
      case 'cursorShow':
        out += SHOW_CURSOR
        break
      case 'cursorMove':
        out += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        out += cursorTo(patch.col)
        break
      case 'carriageReturn':
        out += '\r'
        break
      case 'hyperlink':
        out += link(patch.uri)
        break
      case 'styleStr':
        out += patch.str
        break
    }
  }
  return out
}

/** Whether a stream can still take a write: not destroyed, not ended, and
 *  not reporting itself unwritable. A terminal that hung up, or a stream
 *  torn down at exit, answers a write with an error instead of taking it —
 *  the mode reassert asks here before it writes. */
export function streamTakesWrites(
  stream: { destroyed?: boolean; writable?: boolean; writableEnded?: boolean },
): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true && stream.writable !== false
}

/** Deliver one frame's patches. BSU/ESU wrap unless the caller skips them
 *  (per-frame capability read — never frozen). Returns false when the fd
 *  path gave up on a wedged reader. */
export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
  syscalls: DeliverySyscalls = defaultSyscalls,
): boolean {
  if (diff.length === 0) return true

  // a non-empty diff whose patches all
  // serialize to ZERO bytes (cancelled pairs, empty clears) must not emit a
  // naked BSU/ESU pair — the field measured an empty ?2026 open+close on
  // every idle tick, pure wasted wake bytes on ConPTY. No body ⇒ no write.
  const body = serializePatches(diff)
  if (body === '') return true

  const useSync = !skipSyncMarkers
  const buffer = (useSync ? BSU : '') + body + (useSync ? ESU : '')

  // Loss-proof fd delivery on a real TTY; the stream path stays for pipes
  // and tests (genuine backpressure semantics, no data loss there).
  const out = terminal.stdout as Writable & { isTTY?: boolean; fd?: number }
  const useFd = out.isTTY === true && typeof out.fd === 'number'
  let delivered = true
  const door = terminalDoor()
  if (door !== null && useFd) {
    // THE ONE DOOR (engine law E4, flag-gated by the mount that bound it):
    // the frame enqueues WHOLE on the serialized channel beside every mode
    // toggle and probe — nothing can interleave into it, and the door's
    // owed-bytes truth feeds the choke gate. Delivery is complete-by-
    // construction (FIFO whole units), so the frame reports delivered.
    door.enqueue({ kind: 'frame', bytes: buffer })
  } else if (useFd) {
    delivered = writeAllSync(out.fd!, Buffer.from(buffer, 'utf8'), syscalls)
  } else {
    terminal.stdout.write(buffer)
  }

  // INK_WRITE_TEE forensics (the STALE-PAINT probe's third stage): what was
  // HANDED to the terminal, with delivery + backpressure fields. OFF ⇒ zero
  // work. Format byte-compatible with the historical writer.
  if (process.env.INK_WRITE_TEE) {
    try {
      appendFileSync(
        process.env.INK_WRITE_TEE,
        JSON.stringify({
          ts: Date.now(),
          len: buffer.length,
          path: useFd ? `fd${out.fd}` : 'stream',
          delivered,
          ...(useFd
            ? { spins: lastWriteSpins, waitMs: Math.round(lastWriteSpins * SPIN_QUANTUM_MS) }
            : {}),
          ...(process.env.INK_WRITE_TEE_FULL ? { content: buffer } : { sample: buffer.slice(0, 40) }),
        }) + '\n',
      )
      appendFileSync(process.env.INK_WRITE_TEE + '.raw', buffer)
    } catch {
      /* forensics only */
    }
  }
  return delivered
}
