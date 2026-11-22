import { execa, type Options as ExecaOptions } from 'execa'

import { getCwd } from './cwd.js'
import { logError } from './log.js'
import { subprocessEnv } from './subprocessEnv.js'
import { gitArgsAsync, isGitExecutable } from './git/spawnArgs.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const ONE_MEGABYTE = 1024 * 1024

type ExecOutcome = {
  stdout: string
  stderr: string
  code: number
  error?: string
}

type StdinOption = 'pipe' | 'ignore' | 'inherit'

type OuterOptions = Unbuilt

type InnerOptions = Unbuilt

export async function execFileNoThrow(
  file: string,
  args: string[],
  options?: OuterOptions,
): Promise<ExecOutcome> {
  return notBuilt('src/utils/execFileNoThrow.ts:43')
}

export async function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  options?: InnerOptions,
): Promise<ExecOutcome> {
  return notBuilt('src/utils/execFileNoThrow.ts:60')
}
