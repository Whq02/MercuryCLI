// ============================================================================
//  provisionalSessionReconcile — the resume path deletes the
//  provisional session's boot artifacts when it switches to an existing
//  session. The field home carried a session descriptor (id-keyed boot
//  artifacts) with NO transcript — boot mints a fresh session id, creates
//  id-keyed state (session-env hook scripts, an empty session dir), and a
//  resume switch abandons that id forever; nothing referenced it, nothing
//  collected it until the 30-day sweep.
//
//  Law: on every session switch, if the PREVIOUS id produced no transcript
//  (provisional by definition — nothing durable references it), its id-keyed
//  boot artifacts are removed. Ambiguity retains: a transcript on disk, an
//  unparseable id, or any path escaping the config home leaves everything
//  in place (the bun-homedir containment law).
// ============================================================================

import { existsSync } from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { getTranscriptPathForSession } from './sessionStorage.js'

/** Session ids are uuid-shaped — anything else never joins a removal path. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function containedInConfigHome(p: string): boolean {
  const root = resolve(getMercuryHome())
  const t = resolve(p)
  return t.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Remove the provisional artifacts of `previousId` after a switch to
 * `nextId`. Exported for the prover; production calls it from the switch
 * subscriber only. Never throws.
 */
export async function reconcileProvisionalSession(
  previousId: string,
  nextId: string,
): Promise<void> {
  try {
    if (previousId === nextId) return
    if (!SESSION_ID_RE.test(previousId)) return
    // A transcript makes the id REAL — nothing here is provisional.
    let transcriptPath: string
    try {
      transcriptPath = getTranscriptPathForSession(previousId)
    } catch {
      return
    }
    if (existsSync(transcriptPath)) return

    // session-env/<id>/ — hook env scripts baked at boot for the abandoned id.
    const sessionEnvDir = join(getMercuryHome(), 'session-env', previousId)
    if (containedInConfigHome(sessionEnvDir) && existsSync(sessionEnvDir)) {
      await rm(sessionEnvDir, { recursive: true, force: true }).catch(() => {})
      logForDebugging(
        `[session] removed provisional session-env for abandoned boot id ${previousId}`,
      )
    }

    // <project>/<id>/ — an empty session dir beside the never-written
    // transcript (rmdir refuses non-empty: tool results make the id real).
    const sessionDir = join(dirname(transcriptPath), previousId)
    if (containedInConfigHome(sessionDir) && existsSync(sessionDir)) {
      await rmdir(sessionDir).catch(() => {})
    }
  } catch {
    /* reconcile is best-effort — a switch must never fail on it */
  }
}

let armed = false

/**
 * Arm the switch-time reconcile (idempotent). Subscribes AFTER boot so the
 * boot id is the first "previous" — exactly the provisional candidate the
 * resume path abandons.
 */
export function armProvisionalSessionReconcile(): void {
  if (armed) return
  armed = true
  let previousId: string
  try {
    previousId = String(getSessionId())
  } catch {
    armed = false
    return // pre-boot contexts re-arm later
  }
  onSessionSwitch(nextId => {
    const prior = previousId
    previousId = String(nextId)
    void reconcileProvisionalSession(prior, String(nextId))
  })
}
