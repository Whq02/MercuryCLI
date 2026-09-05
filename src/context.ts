import { memoize } from 'lodash-es'
import {
  getAddedDirectories,
  setCachedInstructionPrompt,
} from './bootstrap/state.js'
import {
  composeInstructionPrompt,
  filterInjectedInstructionFiles,
  getInstructionFiles,
  onInstructionCacheInvalidated,
} from './services/instructions/engine.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode } from './utils/envUtils.js'
import { execFileNoThrow } from './utils/execFileNoThrow.js'
import { getCwd } from './utils/cwd.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { projectScopePathspec } from './utils/projectBoundary.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'

const GIT_STATUS_MAX_LENGTH = 2000

export function isInstructionDiscoveryDisabled(): boolean {
  return isBareMode() && getAddedDirectories().length === 0
}


let systemPromptInjection: string | null = null

export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  getSystemContext.cache.clear?.()
  getUserContext.cache.clear?.()
}


async function rawGit(args: string[]): Promise<string> {
  const outcome = await execFileNoThrow(gitExe(), args, {
    preserveOutputOnError: false,
    useCwd: true,
  })
  return outcome.stdout.trim()
}

export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    return null
  }
  logForDiagnosticsNoPII('info', 'git_status_started')
  const startedAt = Date.now()
  try {
    const isGitStartedAt = Date.now()
    const isGit = await getIsGit()
    logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
      is_git: isGit,
      duration_ms: Date.now() - isGitStartedAt,
    })
    if (!isGit) {
      logForDiagnosticsNoPII('info', 'git_status_skipped_not_git')
      return null
    }

    const commandsStartedAt = Date.now()
    const [branch, mainBranch, status, log, userName] = await Promise.all([
      getBranch(),
      getDefaultBranch(),
      rawGit(['--no-optional-locks', 'status', '--short', ...projectScopePathspec(getCwd())]),
      rawGit(['--no-optional-locks', 'log', '--oneline', '-5']),
      rawGit(['config', 'user.name']),
    ])
    logForDiagnosticsNoPII('info', 'git_commands_completed', {
      duration_ms: Date.now() - commandsStartedAt,
      status_length: status.length,
    })

    const truncated = status.length > GIT_STATUS_MAX_LENGTH
    const statusBody = truncated
      ? `${status.slice(0, GIT_STATUS_MAX_LENGTH)}\n[Status truncated: the output exceeds 2k characters. Run \`git status\` through the shell tool for the complete listing.]`
      : status

    const block = [
      "This is the repository's git status as of the start of the conversation. It is a point-in-time snapshot and is not refreshed while the conversation runs.",
      `Current branch: ${branch}`,
      `Main branch (pull requests normally target this): ${mainBranch}`,
      ...(userName ? [`Git user: ${userName}`] : []),
      `Status:\n${statusBody || '(clean)'}`,
      `Recent commits:\n${log}`,
    ].join('\n\n')

    logForDiagnosticsNoPII('info', 'git_status_completed', {
      duration_ms: Date.now() - startedAt,
      truncated,
    })
    return block
  } catch (error) {
    logForDiagnosticsNoPII('info', 'git_status_failed', {
      duration_ms: Date.now() - startedAt,
    })
    logError(error)
    return null
  }
})

let instructionInvalidationArmed = false
function armInstructionInvalidation(): void {
  if (instructionInvalidationArmed) return
  instructionInvalidationArmed = true
  onInstructionCacheInvalidated(() => {
    getSystemContext.cache.clear?.()
    getUserContext.cache.clear?.()
  })
}


export const getSystemContext = memoize(
  async (): Promise<Record<string, string>> => {
    armInstructionInvalidation()
    logForDiagnosticsNoPII('info', 'system_context_started')
    const startedAt = Date.now()
    const gitStatus = shouldIncludeGitInstructions()
      ? await getGitStatus()
      : null
    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startedAt,
      has_git_status: gitStatus !== null,
      has_injection: false,
    })
    return {
      ...(gitStatus ? { gitStatus } : {}),
    }
  },
)

function localIsoDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export const getUserContext = memoize(
  async (): Promise<Record<string, string>> => {
    armInstructionInvalidation()
    logForDiagnosticsNoPII('info', 'user_context_started')
    const startedAt = Date.now()
    const disabled = isInstructionDiscoveryDisabled()
    let instructionPrompt: string | null = null
    if (!disabled) {
      const files = await getInstructionFiles()
      const composed = composeInstructionPrompt(
        filterInjectedInstructionFiles(files),
      )
      instructionPrompt = composed || null
      setCachedInstructionPrompt(instructionPrompt)
    }
    const isGit = await getIsGit()
    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startedAt,
      content_length: instructionPrompt?.length ?? 0,
      disabled,
    })
    return {
      ...(instructionPrompt ? { claudeMd: instructionPrompt } : {}),
      environment: `Is a git repository: ${isGit ? 'Yes' : 'No'}`,
      currentDate: `Today's date is ${localIsoDate()}.`,
    }
  },
)
