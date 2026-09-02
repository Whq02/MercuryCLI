
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

async function compensateTeamCreate(teamName: string, creatorSessionId: string): Promise<void> {
  const tf = await readTeamFileAsync(teamName)
  if (tf && tf.leadSessionId !== creatorSessionId) {
    logForDebugging(
      `[team-create] compensate: "${teamName}" belongs to another session — leaving it untouched`,
    )
    return
  }
  if (!tf) return
  await cleanupTeamDirectories(teamName)
}

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

export function teamJournalRecoveryHandlers(): Record<string, JournalRecoveryHandler> {
  return {
    'team-create': {
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
      rollForward: async op => {
        const name = op.idempotencyKey.replace(/^team-delete:/, '').replace(/:\d+$/, '')
        await cleanupTeamDirectories(name)
      },
    },
  }
}

export async function recoverTeamJournal(): Promise<
  Awaited<ReturnType<typeof recoverJournalDir>>
> {
  return recoverJournalDir(teamJournalDir(), teamJournalRecoveryHandlers())
}

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
    }
  }
  return null
}
