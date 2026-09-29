
import { join } from 'node:path'
import {
  recoverJournalDir,
  type JournalRecoveryHandler,
} from '../../substrate/operationJournal.js'
import { getCrewsDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'
import { getCrewDir, getCrewFilePath, readCrewFileAsync } from './crewHelpers.js'
import { readRetiredJournalKey } from '../../migrations/retiredCrewSpellings.js'

export function crewJournalDir(): string {
  return join(getCrewsDir(), '.journal')
}

function crewNameOf(idempotencyKey: string, kind: 'crew-create' | 'crew-delete'): string {
  return readRetiredJournalKey(idempotencyKey).replace(new RegExp(`^${kind}:`), '').replace(/:\d+$/, '')
}

function leaveCrewInPlace(name: string, why: string): void {
  logForDebugging(`[crews-journal] ${why}: "${name}" is left in place at ${getCrewDir(name)} — nothing is removed by itself`)
}

export function crewJournalRecoveryHandlers(): Record<string, JournalRecoveryHandler> {
  return {
    'crew-create': {
      rollForward: async op => {
        const name = crewNameOf(op.idempotencyKey, 'crew-create')
        const tf = await readCrewFileAsync(name)
        if (!tf) throw new Error(`crew-create roll-forward: "${name}" has no crew file`)
      },
      compensate: async op => {
        leaveCrewInPlace(crewNameOf(op.idempotencyKey, 'crew-create'), 'an older build\'s create was interrupted')
      },
    },
    'crew-delete': {
      rollForward: async op => {
        leaveCrewInPlace(crewNameOf(op.idempotencyKey, 'crew-delete'), 'an older build\'s delete was interrupted')
      },
    },
  }
}

export async function recoverCrewJournal(): Promise<
  Awaited<ReturnType<typeof recoverJournalDir>>
> {
  return recoverJournalDir(crewJournalDir(), crewJournalRecoveryHandlers())
}

export async function rebuildCrewProjection(sessionId: string): Promise<{
  crewName: string
  crewFilePath: string
  leadAgentId: string
} | null> {
  const { readdir } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(getCrewsDir())
  } catch {
    return null
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      const tf = await readCrewFileAsync(name)
      if (tf && tf.leadSessionId === sessionId) {
        return {
          crewName: tf.name,
          crewFilePath: getCrewFilePath(tf.name),
          leadAgentId: tf.leadAgentId,
        }
      }
    } catch {
    }
  }
  return null
}
