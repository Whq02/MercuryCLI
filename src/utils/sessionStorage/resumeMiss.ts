import { dirname } from 'node:path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { enrichSessionListings, listSessionsAcrossProjectsProgressive } from './logs.js'
import { getProjectDir } from './paths.js'

export async function resumeMissMessage(sessionId: string): Promise<string> {
  try {
    const current = getProjectDir(getOriginalCwd())
    const { allStatLogs } = await listSessionsAcrossProjectsProgressive(undefined, 0)
    const found = allStatLogs.find(log => log.sessionId === sessionId && log.fullPath !== undefined && dirname(log.fullPath) !== current)
    if (found) {
      const { logs } = await enrichSessionListings([found], 0, 1)
      const folder = logs[0]?.projectPath
      if (folder) return `Session ${sessionId} belongs to ${folder}. Resume it from that folder.`
    }
  } catch {}
  return `No conversation found for session id ${sessionId}`
}
