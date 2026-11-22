import { memoize, sample } from 'lodash-es'

import { getCurrentProjectConfig, saveCurrentProjectConfig } from './config.js'
import { env } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getIsGit, gitExe } from './git.js'
import { logError } from './log.js'
import { getGitEmail } from './user.js'
import { unbuilt, type Unbuilt } from '../pi/holes.js'

function splitPath(path: string): { dir: string; base: string } {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastSlash === -1) return { dir: '.', base: path }
  return { dir: path.slice(0, lastSlash), base: path.slice(lastSlash + 1) }
}

async function tallyGitHistory(args: string[], useResolvedGit: boolean, counts: Map<string, number>): Promise<void> {
  const result = await execFileNoThrow(useResolvedGit ? gitExe() : 'git', args)
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
}

export const getExampleCommandFromCache: Unbuilt = unbuilt('src/utils/exampleCommands.ts:93')

export const refreshExampleCommands: Unbuilt = unbuilt('src/utils/exampleCommands.ts:114')
