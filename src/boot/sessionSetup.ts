import chalk from 'chalk'
import { getIsInteractive, getIsNonInteractiveSession, getProjectRoot, getSessionId, switchSession } from './process-state/processState.js'
import { getCommands } from '../commands/catalogue/commands.js'
import { MERCURY_VERSION } from '../platform/product/product.js'
import type { ToolPermissionContext } from '../tools/kit/tool.js'
import type { SessionId } from '../sessions/transcripts/ids.js'
import { asSessionId } from '../sessions/transcripts/ids.js'
import { checkAndRestoreTerminalBackup } from '../commands/keysetup/appleTerminalBackup.js'
import { checkHasTrustDialogAccepted, getGlobalConfig } from '../platform/settings/config.js'
import { logForDiagnosticsNoPII } from '../platform/logs/diagnosticsLog.js'
import { isBareMode } from '../platform/environment/envUtils.js'
import { findCanonicalGitRoot, getIsGit } from '../platform/git/git.js'
import { captureHooksSnapshot } from '../integrations/event-hooks/hooksConfigSnapshot.js'
import { initializeFileChangedWatcher } from '../integrations/event-hooks/fileChangedWatcher.js'
import { logError } from '../platform/logs/errorLog.js'
import { getRecentActivity } from './first-run/logoDisplayData.js'
import type { PermissionMode } from '../permissions/rules/permissionMode.js'
import { getPlanSlug } from './plans.js'
import { getRecentReleaseNotes } from './releaseNotes.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from '../models/sign-in/credentials/auth.js'
import { signInsCheckedAtOpen } from '../models/sign-in/accounts/signInFreshness.js'
import { consumeSessionHomePin } from '../sessions/transcripts/sessionHomePin.js'
import { saveWorktreeState } from '../sessions/transcripts/sessionStorage.js'
import { setCwd } from '../platform/shell/shellExec.js'
import { getCwd } from '../platform/files/cwd.js'
import { initSinks } from './sinks.js'
import { profileCheckpoint } from './startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
  type WorktreeSession,
} from '../platform/git/worktree/worktree.js'
import { noteRootSovereign } from '../permissions/rules/rootNotice.js'

const TERMINAL_APP = 'Terminal.app'
const TERMINAL_DEFAULTS_DOMAIN = 'com.apple.Terminal'

async function recoverTerminalBackup(): Promise<void> {
  try {
    const outcome = await checkAndRestoreTerminalBackup()
    if (outcome.status === 'restored') {
      console.log(
        chalk.yellow(
          `Detected an interrupted ${TERMINAL_APP} setup from a previous run; your original terminal settings were restored. A terminal restart may be needed for them to take effect.`,
        ),
      )
    } else if (outcome.status === 'failed') {
      console.error(
        chalk.red(
          `An interrupted ${TERMINAL_APP} setup was detected but the settings could not be restored automatically. Restore them manually with: defaults import ${TERMINAL_DEFAULTS_DOMAIN} ${outcome.backupPath}`,
        ),
      )
    }
  } catch (error) {
    logError(error)
  }
}

function leaveWithRefusal(line: string): never {
  console.error(chalk.red(line))
  process.exit(1)
}

function snapshotHooksForCwd(cwd: string): void {
  const startedAt = Date.now()
  captureHooksSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', { duration_ms: Date.now() - startedAt })
  initializeFileChangedWatcher(cwd)
}

type WorktreeAsk = { name: string | undefined; prNumber: number | undefined; tmux: boolean; rules?: ToolPermissionContext }

async function groundAtRepositoryRoot(cwd: string): Promise<string> {
  if (!(await getIsGit())) leaveWithRefusal(`Cannot create a worktree: ${cwd} is not a git repository.`)
  const root = findCanonicalGitRoot(cwd)
  if (!root) leaveWithRefusal('Cannot create a worktree: the repository root could not be resolved.')
  if (root !== cwd) {
    logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
    setCwd(root)
  }
  return root
}

async function carveWorktree(slug: string, tmuxSessionName: string | undefined, prNumber: number | undefined, rules?: ToolPermissionContext): Promise<WorktreeSession> {
  try {
    const options =
      prNumber !== undefined || rules !== undefined
        ? {
            ...(prNumber !== undefined ? { prNumber } : {}),
            ...(rules !== undefined ? { permission: rules } : {}),
          }
        : undefined
    return await createWorktreeForSession(getSessionId(), slug, tmuxSessionName, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${chalk.red(`The worktree could not be created: ${message}`)}\n`)
    process.exit(1)
  }
}

async function attachTmux(tmuxSessionName: string, worktreePath: string): Promise<void> {
  const { created, error } = await createTmuxSessionForWorktree(tmuxSessionName, worktreePath)
  console.log(
    created
      ? chalk.green(`tmux session ${tmuxSessionName} is ready — attach with: tmux attach -t ${tmuxSessionName}`)
      : chalk.yellow(`The tmux session could not be created: ${error ?? 'unknown error'}`),
  )
}

async function enterSessionWorktree(cwd: string, ask: WorktreeAsk): Promise<string> {
  const root = await groundAtRepositoryRoot(cwd)
  const slug = ask.prNumber !== undefined ? `pr-${ask.prNumber}` : ask.name || getPlanSlug(getSessionId())
  const tmuxSessionName = ask.tmux ? generateTmuxSessionName(root, worktreeBranchName(slug)) : undefined
  const worktreeSession = await carveWorktree(slug, tmuxSessionName, ask.prNumber, ask.rules)
  if (tmuxSessionName) await attachTmux(tmuxSessionName, worktreeSession.worktreePath)
  const activeCwd = worktreeSession.worktreePath
  setCwd(activeCwd)
  const { applyHarnessGround } = await import('../daemon/switchboard/harnessGround.js')
  await applyHarnessGround(getCwd())
  saveWorktreeState(worktreeSession)
  captureHooksSnapshot()
  return activeCwd
}

function warmExtensionsAndCommands(): void {
  void import('../integrations/extensions/boot.js')
    .then(async boot => {
      await boot.ensureExtensionsLoaded()
      boot.installExtensionsChangeSubscription()
      await getCommands(getProjectRoot())
    })
    .catch((error: unknown) => logError(error))
}

async function readActivityWhenNotesAreUnseen(): Promise<void> {
  const notes = getRecentReleaseNotes(MERCURY_VERSION, getGlobalConfig().lastReleaseNotesSeen)
  if (notes.length > 0) await getRecentActivity()
}

export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  _allowDangerousSkip: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  _messagingSocketPath?: string,
  worktreeRules?: ToolPermissionContext,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')
  if (customSessionId) {
    switchSession(asSessionId(customSessionId), consumeSessionHomePin())
  }
  if (getIsInteractive()) {
    await recoverTerminalBackup()
  }
  setCwd(cwd)
  snapshotHooksForCwd(cwd)
  if (worktreeEnabled) {
    await enterSessionWorktree(cwd, {
      name: worktreeName,
      prNumber: worktreePRNumber,
      tmux: tmuxEnabled,
      rules: worktreeRules,
    })
  }
  profileCheckpoint('setup_before_prefetch')
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  if (!isBareMode()) {
    warmExtensionsAndCommands()
  }
  profileCheckpoint('setup_after_prefetch')
  initSinks()
  if (checkHasTrustDialogAccepted()) {
    prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession())
  }
  if (getIsInteractive() && !getIsNonInteractiveSession()) {
    void signInsCheckedAtOpen()
  }
  if (!isBareMode()) {
    await readActivityWhenNotesAreUnseen()
  }
  noteRootSovereign(permissionMode)
}
