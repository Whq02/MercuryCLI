import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getOriginalCwd, getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getPlatform } from './platform.js'
import { getMercuryHome } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getAgentId } from './teammate.js'


export type SessionKind = 'interactive' | 'bg' | 'daemon'

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

function sessionsDir(): string {
  return join(getMercuryHome(), 'sessions')
}

function ownSessionFile(): string {
  return join(sessionsDir(), `${process.pid}.json`)
}

export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false
  const filePath = ownSessionFile()
  registerCleanup(async () => {
    try {
      await unlink(filePath)
    } catch {
    }
  })
  try {
    const dir = sessionsDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const record: SessionRecord = {
      pid: process.pid,
      sessionId: getSessionId(),
      cwd: getOriginalCwd(),
      startedAt: Date.now(),
      kind: 'interactive',
      entrypoint: process.env.MERCURY_ENTRYPOINT,
    }
    await writeFile(filePath, JSON.stringify(record), { mode: 0o600 })
    onSessionSwitch(id => {
      void patchSessionRecord({ sessionId: id })
    })
    return true
  } catch (err) {
    logForDebugging(`concurrentSessions: registration failed: ${String(err)}`)
    return false
  }
}

async function patchSessionRecord(patch: Partial<SessionRecord>): Promise<void> {
  try {
    const filePath = ownSessionFile()
    const current = JSON.parse(await readFile(filePath, 'utf8')) as SessionRecord
    await writeFile(filePath, JSON.stringify({ ...current, ...patch }), { mode: 0o600 })
  } catch (err) {
    logForDebugging(`concurrentSessions: patch failed: ${String(err)}`)
  }
}

export async function updateSessionName(name: string | undefined): Promise<void> {
  if (!name) return
  await patchSessionRecord({ name })
}

export async function updateSessionId(sessionId: string): Promise<void> {
  if (!sessionId) return
  await patchSessionRecord({ sessionId })
}

export async function updateSessionBridgeId(bridgeSessionId: string | null): Promise<void> {
  await patchSessionRecord({ bridgeSessionId })
}

export async function countConcurrentSessions(): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(sessionsDir())
  } catch (err) {
    if (!isFsInaccessible(err)) {
      logForDebugging(`concurrentSessions: could not list sessions dir: ${String(err)}`)
    }
    return 0
  }
  let count = 0
  for (const entry of entries) {
    const match = /^(\d+)\.json$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
      continue
    }
    if (getPlatform() === 'wsl') continue
    try {
      await unlink(join(sessionsDir(), entry))
    } catch {
    }
  }
  return count
}
