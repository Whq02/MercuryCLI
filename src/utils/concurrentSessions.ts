import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getOriginalCwd, getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getPlatform } from './platform.js'
import { getMercuryHome } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

type SessionKind = 'interactive' | 'bg' | 'daemon'

type SessionRecord = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: SessionKind
  entrypoint?: string
  name?: string
  bridgeSessionId?: string | null
}

const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600
const RECORD_NAME = /^(\d+)\.json$/

const sessionsDir = (): string => join(getMercuryHome(), 'sessions')
const recordPathOf = (pid: number): string => join(sessionsDir(), `${pid}.json`)

const note = (what: string, err: unknown): void => notBuilt('src/utils/concurrentSessions.ts:34')

const unlinkQuietly = async (path: string): Promise<void> => notBuilt('src/utils/concurrentSessions.ts:36')

const writeOwnRecord = (record: SessionRecord): Promise<void> =>
  writeFile(recordPathOf(process.pid), JSON.stringify(record), { mode: PRIVATE_FILE })

async function patchOwnRecord(patch: Partial<SessionRecord>): Promise<void> {
  try {
    const current = JSON.parse(await readFile(recordPathOf(process.pid), 'utf8')) as SessionRecord
    await writeOwnRecord({ ...current, ...patch })
  } catch (err) {
    note('patch failed', err)
  }
}

export async function registerSession(): Promise<boolean> {
  return notBuilt('src/utils/concurrentSessions.ts:63')
}

export async function updateSessionName(name: string | undefined): Promise<void> {
  return notBuilt('src/utils/concurrentSessions.ts:77')
}

export async function updateSessionBridgeId(bridgeSessionId: string | null): Promise<void> {
  return notBuilt('src/utils/concurrentSessions.ts:81')
}

async function recordedPids(): Promise<number[]> {
  try {
    return (await readdir(sessionsDir())).flatMap(entry => {
      const digits = RECORD_NAME.exec(entry)?.[1]
      return digits === undefined ? [] : [Number(digits)]
    })
  } catch (err) {
    if (!isFsInaccessible(err)) note('could not list sessions dir', err)
    return []
  }
}

const isLive = (pid: number): boolean => pid === process.pid || isProcessRunning(pid)

export async function countConcurrentSessions(): Promise<number> {
  const pids = await recordedPids()
  const live = pids.filter(isLive)
  if (getPlatform() !== 'wsl') {
    for (const pid of pids) if (!isLive(pid)) await unlinkQuietly(recordPathOf(pid))
  }
  return live.length
}
