import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe, getRemoteUrl, redactGitRemoteCredentials } from './git.js'
import { logError } from './log.js'
import { notBuilt } from '../pi/holes.js'

type ParsedRepository = {
  host: string
  owner: string
  name: string
}

const PUBLIC_GIT_HOST = 'github.com'

const repositoryCache = new Map<string, ParsedRepository>()

export function parseGitRemote(input: string): ParsedRepository | null {
  return notBuilt('src/utils/detectRepository.ts:23')
}

export async function detectCurrentRepository(): Promise<string | null> {
  return notBuilt('src/utils/detectRepository.ts:83')
}
