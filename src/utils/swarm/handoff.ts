/**
 * ITEM 16 — Honesty-gated room-to-room handoff.
 *
 * A `handoff` StructuredMessage carries a from→to summary, a CLAIMED status
 * (done / blocked / needs-review), and evidenceRefs[] — files / commands /
 * commits backing a success claim. This module is the validator + ledger:
 *
 *   - validateHandoff() runs the honesty gate. A handoff that CLAIMS success
 *     (done) with NO evidenceRefs is flagged `unverified` (its claim is
 *     quarantined-but-delivered): provenance.verified is true ONLY when a
 *     success-shaped claim is backed by evidence. Delivery is NEVER blocked —
 *     the recipient still receives the handoff, but its success claim is marked
 *     not-to-be-trusted in their view / the TeamBrief.
 *
 *   - The ledger (one file per team, lock-guarded — same shape as the Q&A
 *     ledger in sendMessageGovernance.ts) records every handoff so the
 *     recipient's TeamBrief can surface incoming handoffs and flag the
 *     unverified ones.
 *
 * DEFAULT-NO-OP: no handoffs ⇒ no ledger, no effect. A handoff WITH evidence
 * for its success claim is clean (verified:true). Everything fails open: an
 * unreadable/junk ledger resets to empty rather than blocking a send.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getTeamsDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import * as lockfile from '../lockfile.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { sanitizePathComponent } from '../tasks.js'
import { getTeamName } from '../teammate.js'

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

/** The status a handoff CLAIMS for the work being handed off. */
export const HANDOFF_STATUSES = ['done', 'blocked', 'needs-review'] as const
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]

/**
 * A single evidence reference backing a handoff's claim. Free-form by design
 * (a file path, a command that was run, a commit sha) — the validator only
 * checks PRESENCE for a success claim, not contents (it can't run them).
 */
export type EvidenceRef = {
  /** What kind of evidence: a file, a command, a commit, or other. */
  kind?: 'file' | 'command' | 'commit' | string
  /** The reference itself: a path, a command line, a sha, a URL. */
  ref: string
  /** Optional human note. */
  note?: string
}

/**
 * The honesty verdict for a handoff. `verified` is provenance-grade:
 * a success claim with no evidence is NOT verified.
 */
export type HandoffVerdict = {
  /**
   * True when the handoff's claim is backed: either the claimed status is not
   * a success claim (blocked / needs-review need no evidence), or it IS a
   * success claim (done) AND at least one evidenceRef is present.
   */
  verified: boolean
  /** Set when verified=false: why the claim is quarantined as unverified. */
  reason?: string
  /** True iff the claimed status is a success claim (currently: 'done'). */
  isSuccessClaim: boolean
}

/** A handoff persisted to the recipient's ledger. */
export type Handoff = {
  id: string
  from: string
  /** The recipient agent name this handoff was addressed to. */
  to: string
  status: HandoffStatus
  summary: string
  evidenceRefs: EvidenceRef[]
  /** Honesty verdict computed at delivery (the quarantine of unbacked claims). */
  verified: boolean
  /** Present when verified=false: the quarantine reason. */
  unverifiedReason?: string
  sentAt: string
  /** Set when the recipient marks it acknowledged (close-out). */
  acknowledgedAt?: string
}

/**
 * Is the claimed status a SUCCESS claim that REQUIRES evidence? Only 'done'
 * asserts the work succeeded; 'blocked' / 'needs-review' are honest non-claims
 * (they ask for help / review) and need no backing — the gate
 * quarantines only success-shaped lines.
 */
export function isSuccessClaim(status: HandoffStatus): boolean {
  return status === 'done'
}

/**
 * The honesty gate. A success claim (done) with no evidenceRefs is flagged
 * `verified:false` — delivered, but quarantined as unverified in the
 * recipient's view. Anything that isn't a success claim, or a success claim
 * WITH at least one evidence ref, is verified.
 *
 * Pure + total: never throws. Mirrors room-handoff.mjs's provenance.verified.
 */
export function validateHandoff(input: {
  status: HandoffStatus
  evidenceRefs?: EvidenceRef[]
}): HandoffVerdict {
  const successClaim = isSuccessClaim(input.status)
  const evidence = Array.isArray(input.evidenceRefs)
    ? input.evidenceRefs.filter(
        e => !!e && typeof e.ref === 'string' && e.ref.trim().length > 0,
      )
    : []

  if (successClaim && evidence.length === 0) {
    return {
      verified: false,
      isSuccessClaim: true,
      reason:
        'success claim ("done") with NO evidenceRefs — unverified. The recipient sees this handoff flagged as an unbacked claim; attach files/commands/commits that back the success, or downgrade the status to "needs-review".',
    }
  }

  return { verified: true, isSuccessClaim: successClaim }
}

// ---------------------------------------------------------------------------
// Ledger (one file per team — same lock-guarded shape as the Q&A ledger)
// ---------------------------------------------------------------------------

function getHandoffsPath(teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  return join(getTeamsDir(), safeTeam, 'handoffs.json')
}

async function readHandoffs(teamName?: string): Promise<Handoff[]> {
  const path = getHandoffsPath(teamName)
  try {
    const content = await readFile(path, 'utf-8')
    const parsed = jsonParse(content)
    return Array.isArray(parsed) ? (parsed as Handoff[]) : []
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return []
    logForDebugging(`[Handoff] readHandoffs failed: ${error}`)
    return []
  }
}

/**
 * Mutate the handoffs ledger under a lock. STATE fails open: a junk/missing
 * file resets to an empty ledger rather than blocking the send.
 */
async function mutateHandoffs(
  teamName: string | undefined,
  mutate: (handoffs: Handoff[]) => Handoff[],
): Promise<void> {
  const path = getHandoffsPath(teamName)
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const dir = join(getTeamsDir(), safeTeam)
  await mkdir(dir, { recursive: true })

  // proper-lockfile requires the file to exist before locking.
  try {
    await writeFile(path, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logForDebugging(`[Handoff] could not create handoffs file: ${error}`)
      return
    }
  }

  const lockFilePath = `${path}.lock`
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    const current = await readHandoffs(teamName)
    const next = mutate(current)
    await writeFile(path, jsonStringify(next, null, 2), 'utf-8')
  } catch (error) {
    logForDebugging(`[Handoff] mutateHandoffs failed: ${error}`)
    logError(error)
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // already released
      }
    }
  }
}

/**
 * Record a handoff for the recipient. Runs the honesty gate and stamps the
 * verdict so the recipient's TeamBrief can surface it (and flag the unverified
 * ones). Idempotent on id — a re-recorded handoff with the same id refreshes
 * rather than duplicates. Returns the computed verdict.
 */
export async function recordHandoff(
  h: {
    id: string
    from: string
    to: string
    status: HandoffStatus
    summary: string
    evidenceRefs?: EvidenceRef[]
  },
  teamName?: string,
): Promise<HandoffVerdict> {
  const verdict = validateHandoff({
    status: h.status,
    evidenceRefs: h.evidenceRefs,
  })
  const evidenceRefs = Array.isArray(h.evidenceRefs)
    ? h.evidenceRefs.filter(
        e => !!e && typeof e.ref === 'string' && e.ref.trim().length > 0,
      )
    : []

  await mutateHandoffs(teamName, handoffs => {
    const filtered = handoffs.filter(x => x.id !== h.id)
    filtered.push({
      id: h.id,
      from: h.from,
      to: h.to,
      status: h.status,
      summary: h.summary,
      evidenceRefs,
      verified: verdict.verified,
      unverifiedReason: verdict.verified ? undefined : verdict.reason,
      sentAt: new Date().toISOString(),
    })
    // Bound the persisted ledger (RESOURCE: writer-with-no-reaper): handoffs.json
    // grew one row per handoff for the team's whole life. Keep the newest 200 —
    // rows are already sorted oldest→newest by the append above.
    return filtered.length > 200 ? filtered.slice(filtered.length - 200) : filtered
  })

  return verdict
}

/**
 * List handoffs addressed to `agentName` that haven't been acknowledged.
 * Surfaced in the recipient's TeamBrief Handoffs section. No team / no ledger
 * ⇒ empty (default-no-op).
 */
export async function listIncomingHandoffs(
  agentName: string,
  teamName?: string,
): Promise<Handoff[]> {
  const handoffs = await readHandoffs(teamName)
  // Match the addressee case-insensitively, like the rest of the swarm compares
  // agent/member names (the rule listOpenQuestions already follows —
  // sendMessageGovernance.ts:230). A case-sensitive `===` dropped a handoff from
  // the recipient's TeamBrief whenever the sender cased the name differently.
  const me = (agentName ?? '').trim().toLowerCase()
  return handoffs.filter(
    h => (h.to ?? '').trim().toLowerCase() === me && !h.acknowledgedAt,
  )
}

/** List ALL non-acknowledged handoffs on the team (lead-facing overview). */
export async function listAllOpenHandoffs(
  teamName?: string,
): Promise<Handoff[]> {
  const handoffs = await readHandoffs(teamName)
  return handoffs.filter(h => !h.acknowledgedAt)
}
