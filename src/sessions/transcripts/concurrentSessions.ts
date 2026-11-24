import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getOriginalCwd, getSessionId, onSessionSwitch } from '../../boot/process-state/processState.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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

const sessionsDir = (): string => join(getMercuryHome(), 'sessions')
const recordPathOf = (pid: number): string => join(sessionsDir(), `${pid}.json`)

const note = (what: string, err: unknown): void => logForDebugging(`concurrentSessions: ${what}: ${String(err)}`)

const unlinkQuietly = async (path: string): Promise<void> => unlink(path).catch(passedOver)

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
  registerCleanup(() => unlinkQuietly(recordPathOf(process.pid)))
  try {
    const dir = sessionsDir()
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR })
    await chmod(dir, PRIVATE_DIR)
    await writeOwnRecord({ pid: process.pid, sessionId: getSessionId(), cwd: getOriginalCwd(), startedAt: Date.now(), kind: 'interactive', entrypoint: flagEnv('MERCURY_ENTRYPOINT') })
    onSessionSwitch(sessionId => { void patchOwnRecord({ sessionId }) })
    return true
  } catch (error) {
    note('registration failed', error)
    return false
  }
}

export async function updateSessionName(name: string | undefined): Promise<void> {
  if (name) await patchOwnRecord({ name })
}

export async function updateSessionBridgeId(bridgeSessionId: string | null): Promise<void> {
  await patchOwnRecord({ bridgeSessionId })
}
