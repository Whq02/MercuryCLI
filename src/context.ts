// ============================================================================
//  src/context.ts — assembles the two cached prompt-context blocks: the
//  system context (git status) and the user context (project instructions
//  plus today's date).
//
//  All three async accessors are memoized; callers clear the caches on
//  transcript clear, directory changes and injection changes. The
//  prompt-injection setter clears both context caches immediately but
//  deliberately leaves the git-status cache alone.
// ============================================================================
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
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'

const GIT_STATUS_MAX_LENGTH = 2000

/**
 * The single law every composition path must consult, never re-derive:
 * bare mode declines to search on the user's behalf but never refuses a
 * directory the user explicitly named with `--add-dir`. (There is no
 * hard-off env.)
 */
export function isInstructionDiscoveryDisabled(): boolean {
  return isBareMode() && getAddedDirectories().length === 0
}

// ── prompt injection (debugging cache-break channel) ───────────────────────

let systemPromptInjection: string | null = null

export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

/** Setting the injection immediately clears both context caches so the next
 *  read recomposes; the git-status cache deliberately survives. */
export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  getSystemContext.cache.clear?.()
  getUserContext.cache.clear?.()
}

// ── git status ─────────────────────────────────────────────────────────────

async function rawGit(args: string[]): Promise<string> {
  const outcome = await execFileNoThrow(gitExe(), args, {
    preserveOutputOnError: false,
    useCwd: true,
  })
  return outcome.stdout.trim()
}

export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // Avoid cycles in the test environment.
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
      rawGit(['--no-optional-locks', 'status', '--short']),
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

// ── the instruction-invalidation observer (FN-017 R2) ──────────────────────
//
// clearInstructionFileCaches() is the ONE exported invalidation for the
// instruction estate — EnterWorktree / ExitWorktree, the project writer
// behind RecordConvention, the /memory dialog and settings sync all call it.
// It cleared the memoized discovery walk only; the two composed blocks
// below are memoized on their own, so a session that entered a worktree
// kept sending the ORIGINAL tree's instruction block on every later turn
// (and a recorded convention never entered the composed block for that
// session). The composition observes the engine's invalidation — the shape
// effectiveSize.ts already uses — so the one call reaches the whole chain;
// armed on the first composition, so the module graph carries no
// import-time coupling. The git-status memo keeps its own lifetime.
let instructionInvalidationArmed = false
function armInstructionInvalidation(): void {
  if (instructionInvalidationArmed) return
  instructionInvalidationArmed = true
  onInstructionCacheInvalidated(() => {
    getSystemContext.cache.clear?.()
    getUserContext.cache.clear?.()
  })
}

// ── the two context blocks ─────────────────────────────────────────────────

export const getSystemContext = memoize(
  async (): Promise<Record<string, string>> => {
    armInstructionInvalidation()
    logForDiagnosticsNoPII('info', 'system_context_started')
    const startedAt = Date.now()
    const gitStatus = shouldIncludeGitInstructions()
      ? await getGitStatus()
      : null
    // The prompt-injection channel is inert in this build: nothing is read
    // into the composed record, so the completion event always reports it
    // absent.
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
      // Awaited deliberately so the event loop yields at the first file read.
      const files = await getInstructionFiles()
      const composed = composeInstructionPrompt(
        filterInjectedInstructionFiles(files),
      )
      instructionPrompt = composed || null
      // Cached into runtime state for the auto-mode classifier, which reads
      // it there instead of importing the instruction engine directly (that
      // import would create a dependency cycle through the permission
      // layer).
      setCachedInstructionPrompt(instructionPrompt)
    }
    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startedAt,
      content_length: instructionPrompt?.length ?? 0,
      disabled,
    })
    return {
      // `claudeMd` is the user-context key the model receives — rendered as
      // `# claudeMd` by prependUserContext (utils/api.ts) — so the key is
      // wire data and keeps its spelling; the slim-agent filter in
      // runAgent.ts keys on it too.
      ...(instructionPrompt ? { claudeMd: instructionPrompt } : {}),
      currentDate: `Today's date is ${localIsoDate()}.`,
    }
  },
)
