
import type { Writable } from 'node:stream'
import type { Unit } from '../contracts.js'
import { ttySyscalls, WriteDoor } from '../door.js'

let door: WriteDoor | null = null
let boundStream: Writable | null = null
let restoreBlocking: (() => void) | null = null

export function bindTerminalDoor(
  stdout: Writable & { isTTY?: boolean; fd?: number; _handle?: { setBlocking(blocking: boolean): void } },
  syscallsForTest?: ConstructorParameters<typeof WriteDoor>[0],
): void {
  if (boundStream === stdout && door !== null && !door.isClosed()) return
  if (syscallsForTest === undefined && (stdout.isTTY !== true || typeof stdout.fd !== 'number')) {
    return
  }
  unbindTerminalDoor()
  if (stdout._handle?.setBlocking !== undefined) {
    stdout._handle.setBlocking(false)
    restoreBlocking = () => stdout._handle?.setBlocking(true)
  }
  door = new WriteDoor(syscallsForTest ?? ttySyscalls(stdout.fd!))
  boundStream = stdout
}

export function unbindTerminalDoor(stream?: Writable): void {
  if (stream !== undefined && stream !== boundStream) return
  door?.flushSync()
  door?.dispose()
  restoreBlocking?.()
  restoreBlocking = null
  door = null
  boundStream = null
}

export function terminalDoor(stream?: Writable): WriteDoor | null {
  return stream === undefined || stream === boundStream ? door : null
}

export function terminalOwedBytes(stream?: Writable): number {
  return terminalDoor(stream)?.owedBytes() ?? 0
}

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

export function flushDoorSync(): boolean {
  return door?.flushSync() ?? true
}
