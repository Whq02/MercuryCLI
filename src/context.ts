import { resolve } from 'node:path'
import { getProjectRoot } from './bootstrap/state.js'
import { onInstructionCacheInvalidated } from './services/instructions/engine.js'
import { logForDebugging } from './utils/debug.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode } from './utils/envUtils.js'
import { execFileNoThrow } from './utils/execFileNoThrow.js'
import { getCwd } from './utils/cwd.js'
import { memoizeByCwd } from './utils/cwdMemo.js'
import { getOwnerContext } from './utils/run/ownerContext.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { projectScopePathspec } from './utils/projectBoundary.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { gitRulesText } from './utils/gitRules.js'
import { logError } from './utils/log.js'
import { INSTRUCTIONS_CONTEXT_KEY } from './utils/userContextReminder.js'
import { unbuilt, type Unbuilt } from './pi/holes.js'

const GIT_STATUS_MAX_LENGTH = 2000
const CONTEXT_MEMO_CAP = 64

function contextRootDir(): string {
  return getOwnerContext()?.directory?.cwd ?? getProjectRoot()
}
export function isInstructionDiscoveryDisabled(): boolean {
  return isBareMode()
}


async function rawGit(args: string[]): Promise<string> {
  return (await gitOutcome(args)).stdout
}

async function gitOutcome(args: string[]): Promise<{ stdout: string; code: number; error?: string }> {
  const outcome = await execFileNoThrow(gitExe(), args, { useCwd: true })
  return outcome.code === 0 ? { stdout: outcome.stdout.trim(), code: 0 } : { stdout: '', code: outcome.code, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }
}

export const getGitStatus: Unbuilt = unbuilt('src/context.ts:46')

let instructionInvalidationArmed = false
function armInstructionInvalidation(): void {
  if (instructionInvalidationArmed) return
  instructionInvalidationArmed = true
  onInstructionCacheInvalidated(() => {
    getSystemContext.cache.clear?.()
    getUserContext.cache.clear?.()
  })
}


export const getSystemContext: Unbuilt = unbuilt('src/context.ts:123')

function localIsoDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export const getUserContext: Unbuilt = unbuilt('src/context.ts:153')
