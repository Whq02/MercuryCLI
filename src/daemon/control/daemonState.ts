import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function daemonDir(): string {
  const override = flagEnv('MERCURY_DAEMON_DIR')
  if (override && override.trim() !== '') return override
  return join(getMercuryHome(), 'daemon')
}

export function daemonStatePath(): string {
  return join(daemonDir(), 'daemon.json')
}

export interface DaemonState {
  pid: number
  version: string
  origin: 'transient'
  startedAt: number
  dir: string
  controlSock: string
  proto?: number
  buildTree?: string | null
  script?: string
  ownerPid?: number | null
  foreground?: boolean
  startToken?: string | null
  startInstant?: string
  persist?: boolean
  state?: 'stopping'
  stoppingAt?: number
}

export async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const raw = await readFile(daemonStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as DaemonState
    }
    return null
  } catch (error) {
    passedOver(error)
    return null
  }
}
