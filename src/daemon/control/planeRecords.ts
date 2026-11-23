import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonDir, daemonStatePath } from './controlSocket.js'
import { isProcessAlive } from './ownerWatch.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function daemonLockPath(): string {
  return join(daemonDir(), 'daemon.lock')
}

function readLockHolderPidSync(path: string = daemonLockPath()): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    return typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function lockHeldByLivePidSync(path: string = daemonLockPath()): number | null {
  const pid = readLockHolderPidSync(path)
  if (pid === null || !isProcessAlive(pid)) return null
  return pid
}

export interface PlaneOwnerV1 {
  pid: number
  buildTree: string | null
  alive: boolean
}

type PlaneRecordReadV1 = { state: 'missing' } | { state: 'unreadable'; why: string } | { state: 'read'; owner: PlaneOwnerV1 }

export function readPlaneRecordSync(path: string = daemonStatePath()): PlaneRecordReadV1 {
  let parsed: { pid?: unknown; buildTree?: unknown } | null
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; buildTree?: unknown } | null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' }
    return { state: 'unreadable', why: error instanceof SyntaxError ? 'it is not valid JSON' : (code ?? (error instanceof Error ? error.message : String(error))) }
  }
  if (typeof parsed?.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return { state: 'unreadable', why: 'it names no daemon pid' }
  return {
    state: 'read',
    owner: {
      pid: parsed.pid,
      buildTree: typeof parsed.buildTree === 'string' ? parsed.buildTree : null,
      alive: isProcessAlive(parsed.pid),
    },
  }
}

export function readPlaneOwnerSync(path: string = daemonStatePath()): PlaneOwnerV1 | null {
  const record = readPlaneRecordSync(path)
  return record.state === 'read' ? record.owner : null
}

export function supersededByLivePlaneOwnerSync(selfPid: number = process.pid): PlaneOwnerV1 | null {
  const owner = readPlaneOwnerSync()
  if (owner === null || owner.pid === selfPid || !owner.alive) return null
  return owner
}
