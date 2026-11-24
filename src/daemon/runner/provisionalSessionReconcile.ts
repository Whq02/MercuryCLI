
import { existsSync } from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { getSessionId, onSessionSwitch } from '../../boot/process-state/processState.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { getTranscriptPathForSession } from '../../sessions/transcripts/sessionStorage.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { UUID_REGEX } from '../../platform/primitives/uuid.js'

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
    if (!UUID_REGEX.test(previousId)) return
    let transcriptPath: string
    try {
      transcriptPath = getTranscriptPathForSession(previousId)
    } catch (error) {
      passedOver(error)
      return
    }
    if (existsSync(transcriptPath)) return

    const sessionEnvDir = join(getMercuryHome(), 'session-env', previousId)
    if (containedInConfigHome(sessionEnvDir) && existsSync(sessionEnvDir)) {
      await rm(sessionEnvDir, { recursive: true, force: true }).catch(passedOver)
      logForDebugging(
        `[session] removed provisional session-env for abandoned boot id ${previousId}`,
      )
    }

    const sessionDir = join(dirname(transcriptPath), previousId)
    if (containedInConfigHome(sessionDir) && existsSync(sessionDir)) {
      await rmdir(sessionDir).catch(passedOver)
    }
  } catch (error) {
    passedOver(error)
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
