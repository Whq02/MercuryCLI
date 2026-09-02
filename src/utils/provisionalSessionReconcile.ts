
import { existsSync } from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { getTranscriptPathForSession } from './sessionStorage.js'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function containedInConfigHome(p: string): boolean {
  const root = resolve(getMercuryHome())
  const t = resolve(p)
  return t.startsWith(root.endsWith(sep) ? root : root + sep)
}

export async function reconcileProvisionalSession(
  previousId: string,
  nextId: string,
): Promise<void> {
  try {
    if (previousId === nextId) return
    if (!SESSION_ID_RE.test(previousId)) return
    let transcriptPath: string
    try {
      transcriptPath = getTranscriptPathForSession(previousId)
    } catch {
      return
    }
    if (existsSync(transcriptPath)) return

    const sessionEnvDir = join(getMercuryHome(), 'session-env', previousId)
    if (containedInConfigHome(sessionEnvDir) && existsSync(sessionEnvDir)) {
      await rm(sessionEnvDir, { recursive: true, force: true }).catch(() => {})
      logForDebugging(
        `[session] removed provisional session-env for abandoned boot id ${previousId}`,
      )
    }

    const sessionDir = join(dirname(transcriptPath), previousId)
    if (containedInConfigHome(sessionDir) && existsSync(sessionDir)) {
      await rmdir(sessionDir).catch(() => {})
    }
  } catch {
  }
}

let armed = false

export function armProvisionalSessionReconcile(): void {
  if (armed) return
  armed = true
  let previousId: string
  try {
    previousId = String(getSessionId())
  } catch {
    armed = false
    return
  }
  onSessionSwitch(nextId => {
    const prior = previousId
    previousId = String(nextId)
    void reconcileProvisionalSession(prior, String(nextId))
  })
}
