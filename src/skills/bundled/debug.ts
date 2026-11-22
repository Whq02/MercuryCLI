import { promises as fsPromises } from 'node:fs'
import { registerBundledSkill } from '../bundledSkills.js'
import { enableDebugLogging, getDebugLogPath } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'
import { MERCURY_DOCS_SKILL_NAME } from './mercuryDocs.js'
import { notBuilt } from '../../pi/holes.js'

const TAIL_BYTES = 64 * 1024
const TAIL_LINES = 20

async function readLogTail(logPath: string): Promise<
  | { kind: 'tail'; text: string; totalSize: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
> {
  try {
    const stat = await fsPromises.stat(logPath)
    const handle = await fsPromises.open(logPath, 'r')
    try {
      const offset = Math.max(0, stat.size - TAIL_BYTES)
      const length = Math.min(TAIL_BYTES, stat.size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      const lines = buffer.toString('utf8').split('\n')
      return {
        kind: 'tail',
        text: lines.slice(-TAIL_LINES).join('\n'),
        totalSize: stat.size,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', message: errorMessage(error) }
  }
}

export function registerDebugSkill(): void {
  return notBuilt('src/skills/bundled/debug.ts:40')
}
