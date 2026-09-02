
import type { Writable } from 'node:stream'
import type { Unit } from '../contracts.js'
import { ttySyscalls, WriteDoor } from '../door.js'

let door: WriteDoor | null = null
let boundStream: Writable | null = null

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

export function unbindTerminalDoor(): void {
  door?.flushSync()
  door = null
  boundStream = null
}

export function terminalDoor(): WriteDoor | null {
  return door
}

export function terminalOwedBytes(): number {
  return door?.owedBytes() ?? 0
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
