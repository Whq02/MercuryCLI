// ============================================================================
//  render-engine/cockpit/terminalOut.ts — the cockpit's E4 fold: every byte
//  to the terminal leaves through ONE door.
//
//  Flag OFF (MERCURY_RENDER_ENGINE unset): no door exists; every caller's
//  bytes go to its own stream exactly as before — byte-identical, timing-
//  identical (the classic synchronous paths run untouched).
//
//  Flag ON with a bound TTY: ONE WriteDoor owns the terminal fd. Frames,
//  mode transitions, pointer-shape bytes, capability probes, clipboard OSC,
//  bells and teardown restores all enqueue as WHOLE UNITS in one FIFO —
//  the second buffered write path that spec 10 §1 measured (mode toggles
//  racing the synchronous frame path mid-sequence) folds in here, so
//  interleaving one unit into another is impossible by construction.
//
//  The door's owedBytes() is the drain truth the scheduler's choke gate
//  (E6) reads. Teardown callers use flushDoorSync() so the restore unit
//  lands even on a crash path (E4's bracket law on the exit path).
// ============================================================================

import type { Writable } from 'node:stream'
import type { Unit } from '../contracts.js'
import { ttySyscalls, WriteDoor } from '../door.js'

let door: WriteDoor | null = null
let boundStream: Writable | null = null

/** Bind the one door to the terminal's fd (the mount calls this exactly
 *  once, at attach, only when the engine flag is on and stdout is a TTY).
 *  Rebinding to the same stream is a no-op; a different stream rebinds.
 *  `syscallsForTest` lets provers drive EAGAIN/closed without a TTY. */
export function bindTerminalDoor(
  stdout: Writable & { isTTY?: boolean; fd?: number },
  syscallsForTest?: ConstructorParameters<typeof WriteDoor>[0],
): void {
  if (boundStream === stdout && door !== null && !door.isClosed()) return
  if (syscallsForTest === undefined && (stdout.isTTY !== true || typeof stdout.fd !== 'number')) {
    return
  }
  door = new WriteDoor(syscallsForTest ?? ttySyscalls(stdout.fd!))
  boundStream = stdout
}

/** Drop the binding (unmount / tests). Pending bytes are flushed within the
 *  teardown budget first so a restore unit is never abandoned. */
export function unbindTerminalDoor(): void {
  door?.flushSync()
  door = null
  boundStream = null
}

/** The bound door, when the fold is active (probe port; null flag-off). */
export function terminalDoor(): WriteDoor | null {
  return door
}

/** The door's drain truth; 0 when no door is bound (the classic path's
 *  synchronous writes never owe). */
export function terminalOwedBytes(): number {
  return door?.owedBytes() ?? 0
}

/**
 * Write one whole unit to the terminal. With a door bound and the write
 * aimed at the bound stream, the unit enqueues on the ONE channel; every
 * other case writes to the given stream directly (the flag-off path, a
 * non-TTY sink, stderr).
 */
export function termWrite(
  stream: Writable,
  bytes: string,
  kind: Unit['kind'] = 'mode',
): void {
  if (bytes === '') return
  if (door !== null && stream === boundStream) {
    door.enqueue({ kind, bytes })
    return
  }
  stream.write(bytes)
}

/** Teardown flush: spin the queue out within the door's bounded budget so
 *  bracket closes and mode restores land even when the process is dying. */
export function flushDoorSync(): boolean {
  return door?.flushSync() ?? true
}
