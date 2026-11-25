import { resolve } from 'node:path'
import { getCwdState, getProjectRoot } from '../boot/process-state/processState.js'
import {
  composeInstructionPrompt,
  filterInjectedInstructionFiles,
  getInstructionFiles,
  onInstructionCacheInvalidated,
} from '../sessions/instructions/instructionFiles.js'
import { logForDebugging } from '../platform/logs/debugLog.js'
import { isBareMode } from '../platform/environment/envUtils.js'
import { execFileNoThrow } from '../platform/processes/execFileNoThrow.js'
import { getCwd } from '../platform/files/cwd.js'
import { memoizeByCwd } from './cwdMemo.js'
import { getOwnerContext } from './run-owner/ownerContext.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from '../platform/git/git.js'
import { projectScopePathspec } from '../platform/files/projectBoundary.js'
import { shouldIncludeGitInstructions } from './gitSettings.js'
import { gitRulesText } from './gitRules.js'
import { logError } from '../platform/logs/errorLog.js'
import { INSTRUCTIONS_CONTEXT_KEY } from './attachments/userContextReminder.js'

const GIT_STATUS_MAX_LENGTH = 2000
const CONTEXT_MEMO_CAP = 64
const GIT_STATUS_SNAPSHOT_INTRO =
  "This is the repository's git status as of the start of the conversation or its most recent compaction. It is a point-in-time snapshot and is not refreshed between those points."
const GIT_STATUS_TRUNCATED_NOTE =
  '[Status truncated: the output exceeds 2k characters. Run `git status` through the shell tool for the complete listing.]'

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

export const getGitStatus: ReturnType<typeof memoizeByCwd<Promise<string | null>>> = memoizeByCwd(
  async (): Promise<string | null> => {
    if (process.env.NODE_ENV === 'test') return null
    try {
      const isGit = await getIsGit()
      if (!isGit) {
        return null
      }

      const liveCwd = getCwd()
      const branchCwd = resolve(liveCwd) !== resolve(getCwdState()) ? liveCwd : undefined
      const [currentBranch, mainBranch, statusOutcome, log, gitUser] = await Promise.all([
        getBranch(branchCwd),
        getDefaultBranch(branchCwd),
        gitOutcome(['--no-optional-locks', 'status', '--short', ...projectScopePathspec(liveCwd)]),
        rawGit(['--no-optional-locks', 'log', '--oneline', '-n', '5']),
        rawGit(['config', 'user.name']),
      ])

      let statusBody: string
      if (statusOutcome.code !== 0) {
        const errorSuffix = statusOutcome.error ? `: ${statusOutcome.error}` : ''
        logForDebugging(
          `git status did not run (exit ${statusOutcome.code}${errorSuffix}); the system prompt carries no working-tree status`,
        )
        statusBody = '(not read: the git status command did not run)'
      } else if (statusOutcome.stdout.length > GIT_STATUS_MAX_LENGTH) {
        statusBody = `${statusOutcome.stdout.slice(0, GIT_STATUS_MAX_LENGTH)}\n${GIT_STATUS_TRUNCATED_NOTE}`
      } else {
        statusBody = statusOutcome.stdout || '(clean)'
      }

      const blocks: string[] = [
        GIT_STATUS_SNAPSHOT_INTRO,
        `Current branch: ${currentBranch}`,
        `Main branch (pull requests normally target this): ${mainBranch}`,
        ...(gitUser ? [`Git user: ${gitUser}`] : []),
        `Status:\n${statusBody}`,
        `Recent commits:\n${log}`,
      ]

      return blocks.join('\n\n')
    } catch (error) {
      logError(error)
      return null
    }
  },
  CONTEXT_MEMO_CAP,
  contextRootDir,
)

let instructionInvalidationArmed = false
function armInstructionInvalidation(): void {
  if (instructionInvalidationArmed) return
  instructionInvalidationArmed = true
  onInstructionCacheInvalidated(() => {
    getSystemContext.cache.clear?.()
    getUserContext.cache.clear?.()
  })
}


export const getSystemContext: ReturnType<typeof memoizeByCwd<Promise<Record<string, string>>>> = memoizeByCwd(
  async (): Promise<Record<string, string>> => {
    armInstructionInvalidation()
    const gitStatus = shouldIncludeGitInstructions() ? await getGitStatus() : null
    const rules = gitStatus ? gitRulesText() : ''
    const result: Record<string, string> = {
      ...(gitStatus ? { gitStatus } : {}),
      ...(gitStatus && rules ? { gitRules: rules } : {}),
    }
    return result
  },
  CONTEXT_MEMO_CAP,
  contextRootDir,
)

function localIsoDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export const getUserContext: ReturnType<typeof memoizeByCwd<Promise<Record<string, string>>>> = memoizeByCwd(
  async (): Promise<Record<string, string>> => {
    armInstructionInvalidation()
    const disabled = isInstructionDiscoveryDisabled()
    const [instructions, isGit] = await Promise.all([
      disabled
        ? Promise.resolve('')
        : getInstructionFiles().then(files => composeInstructionPrompt(filterInjectedInstructionFiles(files))),
      getIsGit(),
    ])
    const result: Record<string, string> = {
      ...(instructions ? { [INSTRUCTIONS_CONTEXT_KEY]: instructions } : {}),
      environment: `Is a git repository: ${isGit ? 'Yes' : 'No'}`,
      currentDate: `Today's date is ${localIsoDate()}.`,
    }
    return result
  },
  CONTEXT_MEMO_CAP,
)
