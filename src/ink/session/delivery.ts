import { appendFileSync, writeSync } from 'node:fs'
import type { Writable } from 'stream'
import { terminalDoor } from '../../render-engine/cockpit/terminalOut.js'
import { getClearTerminalSequence } from './capabilities.js'
import type { Diff } from '../frame.js'
import { cursorMove, cursorTo, eraseLines } from '../termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'
import { link } from '../termio/osc.js'


export type Terminal = {
  stdout: Writable
  stderr: Writable
}

export type DeliverySyscalls = {
  writeSync: (fd: number, data: Buffer, offset: number) => number
  sleep: (ms: number) => void
}

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
const defaultSyscalls: DeliverySyscalls = {
  writeSync: (fd, data, offset) => writeSync(fd, data, offset),
  sleep: ms => {
    Atomics.wait(SLEEP_BUF, 0, 0, ms)
  },
}

let lastWriteSpins = 0

const SPIN_LIMIT = 400
const SPIN_QUANTUM_MS = 2.5

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

export function streamTakesWrites(
  stream: { destroyed?: boolean; writable?: boolean; writableEnded?: boolean },
): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true && stream.writable !== false
}

export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
  syscalls: DeliverySyscalls = defaultSyscalls,
): boolean {
  if (diff.length === 0) return true

  const body = serializePatches(diff)
  if (body === '') return true

  const useSync = !skipSyncMarkers
  const buffer = (useSync ? BSU : '') + body + (useSync ? ESU : '')

  const out = terminal.stdout as Writable & { isTTY?: boolean; fd?: number }
  const useFd = out.isTTY === true && typeof out.fd === 'number'
  let delivered = true
  const door = terminalDoor(out)
  if (door !== null && useFd) {
    lastWriteSpins = 0
    door.enqueue({ kind: 'frame', bytes: buffer })
  } else if (useFd) {
    delivered = writeAllSync(out.fd!, Buffer.from(buffer, 'utf8'), syscalls)
  } else {
    terminal.stdout.write(buffer)
  }

  if (process.env.INK_WRITE_TEE) {
    try {
      appendFileSync(
        process.env.INK_WRITE_TEE,
        JSON.stringify({
          ts: Date.now(),
          len: buffer.length,
          path: useFd ? `fd${out.fd}` : 'stream',
          delivered,
          ...(door !== null ? { queuedBytes: door.owedBytes() } : {}),
          ...(useFd
            ? { spins: lastWriteSpins, waitMs: Math.round(lastWriteSpins * SPIN_QUANTUM_MS) }
            : {}),
          ...(process.env.INK_WRITE_TEE_FULL ? { content: buffer } : { sample: buffer.slice(0, 40) }),
        }) + '\n',
      )
      appendFileSync(process.env.INK_WRITE_TEE + '.raw', buffer)
    } catch {
    }
  }
  return delivered
}
