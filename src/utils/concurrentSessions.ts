import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getOriginalCwd, getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getPlatform } from './platform.js'
import { getMercuryHome } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'

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

const note = (what: string, err: unknown): void => logForDebugging(`concurrentSessions: ${what}: ${String(err)}`)

const unlinkQuietly = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch {}
}

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

const ownRecord = (): SessionRecord => ({
  pid: process.pid,
  sessionId: getSessionId(),
  cwd: getOriginalCwd(),
  startedAt: Date.now(),
  kind: 'interactive',
  entrypoint: process.env.MERCURY_ENTRYPOINT,
})

export async function registerSession(): Promise<boolean> {
  registerCleanup(() => unlinkQuietly(recordPathOf(process.pid)))
  try {
    await mkdir(sessionsDir(), { recursive: true, mode: PRIVATE_DIR })
    await chmod(sessionsDir(), PRIVATE_DIR)
    await writeOwnRecord(ownRecord())
    onSessionSwitch(sessionId => void patchOwnRecord({ sessionId }))
    return true
  } catch (err) {
    note('registration failed', err)
    return false
  }
}

export async function updateSessionName(name: string | undefined): Promise<void> {
  if (name) await patchOwnRecord({ name })
}

export async function updateSessionBridgeId(bridgeSessionId: string | null): Promise<void> {
  await patchOwnRecord({ bridgeSessionId })
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
