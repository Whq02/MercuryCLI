/**
 * teamOperations — team create/delete as JOURNALED operations (the
 * crash-consistency program).
 *
 * TeamCreate would otherwise be a best-effort sequence (team file → task reset →
 * leader registrations → AppState) whose unwind only caught THROWN steps —
 * an abrupt exit between the team file and the task setup left a half-team
 * that readTeamFile served as real (FC1). Both flows now run through the
 * Mercury operation journal (`<teamsDir>/.journal`):
 *
 *   team-create  s1 team-file (EXCLUSIVE — a foreign team refuses before any
 *                mutation; idempotent re-run tolerates OUR OWN partial file)
 *                s2 task-epoch (reset + ensure the task root)
 *                compensate: guarded cleanup — removes ONLY a team this
 *                operation created (leadSessionId must match the op owner)
 *   team-delete  one roll-forward step (idempotent rm) — a half-deleted
 *                team COMPLETES its deletion on recovery, never resurrects
 *
 * In-memory registrations (leaderTeamName · leadTeamFallback · AppState)
 * happen strictly AFTER the journal commit — they are PROJECTIONS of
 * committed durable state, never transaction steps, and boot/resume can
 * rebuild them from disk (rebuildTeamProjection).
 */

import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import {
  recoverJournalDir,
  runJournaledOperation,
  type JournalRecoveryHandler,
  type JournaledOperationOutcome,
} from '../../substrate/operationJournal.js'
import { getTeamsDir } from '../envUtils.js'
import { getErrnoCode, getErrnoPath } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { ensureTasksDir, resetTaskList } from '../tasks.js'
import {
  cleanupTeamDirectories,
  getTeamFilePath,
  readTeamFileAsync,
  sanitizeName,
  writeTeamFileAsync,
  type TeamFile,
} from './teamHelpers.js'

/** The teams-domain journal home (rides the MERCURY_TEAMS_DIR seam). */
export function teamJournalDir(): string {
  return join(getTeamsDir(), '.journal')
}

export class TeamCreateConflictError extends Error {
  constructor(
    message: string,
    public readonly conflict: 'exists' | 'in-flight',
  ) {
    super(message)
    this.name = 'TeamCreateConflictError'
  }
}

/**
 * The durable half of TeamCreate, as ONE journaled operation. Returns after
 * the COMMIT marker is durable — the caller then projects (registrations +
 * AppState). Throws TeamCreateConflictError on a foreign existing team or a
 * live concurrent create of the same name.
 */
export async function performTeamCreateOperation(args: {
  teamName: string
  teamFile: TeamFile
}): Promise<JournaledOperationOutcome<{ teamFilePath: string }>> {
  const { teamName, teamFile } = args
  const sessionId = getSessionId()
  const teamFilePath = getTeamFilePath(teamName)
  const outcome = await runJournaledOperation<{ teamFilePath: string }>({
    journalDir: teamJournalDir(),
    ownerKey: sessionId,
    kind: 'team-create',
    idempotencyKey: `team-create:${sanitizeName(teamName)}`,
    steps: [
      {
        id: 'team-file',
        target: teamFilePath,
        run: async () => {
          try {
            await writeTeamFileAsync(teamName, teamFile, { exclusive: true })
          } catch (e) {
            if (getErrnoCode(e) === 'EEXIST' && getErrnoPath(e) === teamFilePath) {
              // Idempotent re-run: OUR OWN partial file is fine; a foreign
              // team is a conflict BEFORE any other mutation.
              const existing = await readTeamFileAsync(teamName)
              if (existing?.leadSessionId === sessionId) return
              throw new TeamCreateConflictError(
                `Team "${teamName}" already exists at ${teamFilePath}.`,
                'exists',
              )
            }
            throw e
          }
        },
      },
      {
        id: 'task-epoch',
        target: sanitizeName(teamName),
        run: async () => {
          // Reset = a durable epoch bump (stale bodies filter dead even if
          // their unlink never ran) + a fresh task root. Idempotent.
          const taskListId = sanitizeName(teamName)
          await resetTaskList(taskListId)
          await ensureTasksDir(taskListId)
        },
      },
    ],
    compensate: () => compensateTeamCreate(teamName, sessionId),
    result: () => ({ teamFilePath }),
  })
  if (outcome.outcome === 'in-flight') {
    throw new TeamCreateConflictError(
      `Team "${teamName}" is being created by another live Mercury process right now.`,
      'in-flight',
    )
  }
  return outcome
}

/** Guarded unwind: remove ONLY a team this operation created. A foreign
 *  team (different leadSessionId) is never touched — the exclusive
 *  team-file step guarantees our later steps never ran against it. */
async function compensateTeamCreate(teamName: string, creatorSessionId: string): Promise<void> {
  const tf = await readTeamFileAsync(teamName)
  if (tf && tf.leadSessionId !== creatorSessionId) {
    logForDebugging(
      `[team-create] compensate: "${teamName}" belongs to another session — leaving it untouched`,
    )
    return
  }
  if (!tf) return // our write never became visible — nothing to unwind
  await cleanupTeamDirectories(teamName)
}

/**
 * The durable half of TeamDelete: one journaled roll-forward operation —
 * recovery COMPLETES a half-deleted team (it never resurrects).
 */
export async function performTeamDeleteOperation(teamName: string): Promise<void> {
  await runJournaledOperation({
    journalDir: teamJournalDir(),
    ownerKey: getSessionId(),
    kind: 'team-delete',
    idempotencyKey: `team-delete:${sanitizeName(teamName)}:${Date.now()}`,
    steps: [
      {
        id: 'remove',
        target: getTeamFilePath(teamName),
        run: async () => {
          await cleanupTeamDirectories(teamName)
        },
      },
    ],
  })
}

/**
 * The teams-domain journal recovery handlers (invoked by the recovery
 * orchestrator before any team state is projected).
 */
export function teamJournalRecoveryHandlers(): Record<string, JournalRecoveryHandler> {
  return {
    'team-create': {
      // All steps applied ⇒ the materialization exists; verify and commit.
      rollForward: async op => {
        const name = op.idempotencyKey.replace(/^team-create:/, '')
        const tf = await readTeamFileAsync(name)
        if (!tf) throw new Error(`team-create roll-forward: "${name}" has no team file`)
      },
      compensate: async op => {
        const name = op.idempotencyKey.replace(/^team-create:/, '')
        await compensateTeamCreate(name, op.ownerKey)
      },
    },
    'team-delete': {
      // Deletion always rolls FORWARD — idempotent rm completes the intent.
      rollForward: async op => {
        const name = op.idempotencyKey.replace(/^team-delete:/, '').replace(/:\d+$/, '')
        await cleanupTeamDirectories(name)
      },
    },
  }
}

/** Run teams-domain journal recovery. Returns the summary for the boot
 *  receipt / doctor. */
export async function recoverTeamJournal(): Promise<
  Awaited<ReturnType<typeof recoverJournalDir>>
> {
  return recoverJournalDir(teamJournalDir(), teamJournalRecoveryHandlers())
}

/**
 * Rebuild the leader's team PROJECTION from committed durable state: the
 * team file whose leadSessionId is this session (boot/resume — AppState is
 * a view, never a transaction step). Returns null when this session leads
 * no team on disk.
 */
export async function rebuildTeamProjection(sessionId: string): Promise<{
  teamName: string
  teamFilePath: string
  leadAgentId: string
} | null> {
  const { readdir } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(getTeamsDir())
  } catch {
    return null
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      const tf = await readTeamFileAsync(name)
      if (tf && tf.leadSessionId === sessionId) {
        return {
          teamName: tf.name,
          teamFilePath: getTeamFilePath(tf.name),
          leadAgentId: tf.leadAgentId,
        }
      }
    } catch {
      /* unreadable team dir — recovery/doctor report it */
    }
  }
  return null
}
