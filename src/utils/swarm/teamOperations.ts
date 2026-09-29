
import { join } from 'node:path'
import {
  recoverJournalDir,
  type JournalRecoveryHandler,
} from '../../substrate/operationJournal.js'
import { getTeamsDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'
import { getTeamDir, getTeamFilePath, readTeamFileAsync } from './teamHelpers.js'

export function teamJournalDir(): string {
  return join(getTeamsDir(), '.journal')
}

function teamNameOf(idempotencyKey: string, kind: 'team-create' | 'team-delete'): string {
  return idempotencyKey.replace(new RegExp(`^${kind}:`), '').replace(/:\d+$/, '')
}

function leaveTeamInPlace(name: string, why: string): void {
  logForDebugging(`[teams-journal] ${why}: "${name}" is left in place at ${getTeamDir(name)} — nothing is removed by itself`)
}

export function teamJournalRecoveryHandlers(): Record<string, JournalRecoveryHandler> {
  return {
    'team-create': {
      rollForward: async op => {
        const name = teamNameOf(op.idempotencyKey, 'team-create')
        const tf = await readTeamFileAsync(name)
        if (!tf) throw new Error(`team-create roll-forward: "${name}" has no team file`)
      },
      compensate: async op => {
        leaveTeamInPlace(teamNameOf(op.idempotencyKey, 'team-create'), 'an older build\'s create was interrupted')
      },
    },
    'team-delete': {
      rollForward: async op => {
        leaveTeamInPlace(teamNameOf(op.idempotencyKey, 'team-delete'), 'an older build\'s delete was interrupted')
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
