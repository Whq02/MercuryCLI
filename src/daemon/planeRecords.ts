import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonDir, supervisorStatePath } from './controlSocket.js'
import { isProcessAlive } from './ownerWatch.js'

export function supervisorLockPath(): string {
  return join(daemonDir(), 'supervisor.lock')
}

export function readLockHolderPidSync(path: string = supervisorLockPath()): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    return typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  } catch {
    return null
  }
}

export function lockHeldByLivePidSync(path: string = supervisorLockPath()): number | null {
  const pid = readLockHolderPidSync(path)
  if (pid === null || !isProcessAlive(pid)) return null
  return pid
}

export interface PlaneOwnerV1 {
  pid: number
  buildTree: string | null
  alive: boolean
}

export function readPlaneOwnerSync(path: string = supervisorStatePath()): PlaneOwnerV1 | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; buildTree?: unknown }
    if (typeof parsed?.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
    return {
      pid: parsed.pid,
      buildTree: typeof parsed.buildTree === 'string' ? parsed.buildTree : null,
      alive: isProcessAlive(parsed.pid),
    }
  } catch {
    return null
  }
}

export function supersededByLivePlaneOwnerSync(selfPid: number = process.pid): PlaneOwnerV1 | null {
  const owner = readPlaneOwnerSync()
  if (owner === null || owner.pid === selfPid || !owner.alive) return null
  return owner
}
