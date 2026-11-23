import type { UUID } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { sessionFilePath } from './loading.js'
import { enrichSessionListings, listSessionsAcrossProjectsProgressive } from './sessionListings.js'
import { getProjectDir } from './paths.js'

function transcriptReadFailure(filePath: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    readSync(fd, Buffer.alloc(1), 0, 1, 0)
    return null
  } catch (error) {
    if (isENOENT(error)) return null
    return errorMessage(error)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) { passedOver(error) }
    }
  }
}

export function unreadableTranscriptMessage(sessionId: string, sourceFile?: string): string | null {
  const target = sourceFile ?? sessionFilePath(sessionId as UUID)
  const readError = transcriptReadFailure(target)
  if (readError === null) return null
  return `Session ${sessionId} transcript could not be read: ${target} (${readError}).`
}

export async function resumeMissMessage(sessionId: string, sourceFile?: string): Promise<string> {
  const unreadable = unreadableTranscriptMessage(sessionId, sourceFile)
  if (unreadable !== null) return unreadable
  try {
    const current = getProjectDir(getOriginalCwd())
    const { allStatLogs } = await listSessionsAcrossProjectsProgressive(undefined, 0)
    const found = allStatLogs.find(log => log.sessionId === sessionId && log.fullPath !== undefined && dirname(log.fullPath) !== current)
    if (found) {
      const { logs } = await enrichSessionListings([found], 0, 1)
      const folder = logs[0]?.projectPath
      if (folder) return `Session ${sessionId} belongs to ${folder}. Resume it from that folder.`
    }
  } catch (error) { passedOver(error) }
  return `No conversation found for session id ${sessionId}`
}
