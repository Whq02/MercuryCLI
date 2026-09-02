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

/**
 * Per-process session registry files under `<home>/sessions`, used for
 * peer enumeration. The former role as the live-session count's source of
 * truth was retired (a supervisor-backed count owns that now); what remains
 * is peer enumeration only, and must not be wired back into a live-count
 * display.
 */

// Only the interactive value is ever written in this build; the union
// stays three-membered for an older build sharing the home.
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

/**
 * Register this process. Skipped for teammate/subagent processes (a swarm
 * is one operator's single unit of work). The cleanup hook is registered
 * BEFORE the write so a failed registration still cleans up a partial file.
 * Also re-points the recorded session id on session switches.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false
  const filePath = ownSessionFile()
  registerCleanup(async () => {
    try {
      await unlink(filePath)
    } catch {
      // A missing file at cleanup time is fine.
    }
  })
  try {
    const dir = sessionsDir()
    // Creation mode is subject to umask, so the explicit chmod is required.
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

/** Best-effort read-modify-write of the own record; failures swallowed. */
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

/**
 * Set (or clear with null) the remote-control bridge session id, so a
 * session reachable over both a local socket and a remote bridge appears
 * once, with the local entry winning.
 */
export async function updateSessionBridgeId(bridgeSessionId: string | null): Promise<void> {
  await patchSessionRecord({ bridgeSessionId })
}

/**
 * Count live sessions. A strict `<digits>.json` filename guard is
 * load-bearing: the lenient integer parser would read any filename that
 * merely starts with digits as a pid and DELETE it. Non-running pids are
 * swept — except on WSL, where a shared directory may hold Windows-native
 * pids that cannot be probed, so the count is allowed to be conservative.
 */
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
    // The platform accessor's value, not the interop-file probe: under
    // 'wsl' another pid's file is never unlinked.
    if (getPlatform() === 'wsl') continue
    try {
      await unlink(join(sessionsDir(), entry))
    } catch {
      // Sweep failures are ignored.
    }
  }
  return count
}
