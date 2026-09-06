import chalk from 'chalk'
import {
  getIsInteractive,
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { MERCURY_VERSION } from './constants/product.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import type { SessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  getCurrentProjectConfig,
} from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode } from './utils/envUtils.js'
import { findCanonicalGitRoot, getIsGit } from './utils/git.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { captureHooksConfigSnapshot } from './utils/hooks/hooksConfigSnapshot.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { modeBypassesPermissions } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import {
  getRecentReleaseNotes,
} from './utils/releaseNotes.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { registerSessionFileAccessHooks } from './utils/sessionFileAccessHooks.js'
import { consumeSessionHomePin } from './utils/sessionStorage/sessionHomePin.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { setCwd } from './utils/Shell.js'
import { getCwd } from './utils/cwd.js'
import { initSinks } from './utils/sinks.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import { captureTeammateModeSnapshot } from './utils/swarm/backends/teammateModeSnapshot.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
  type WorktreeSession,
} from './utils/worktree.js'

function reportBackupRestore(
  result: { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string },
  appName: string,
  defaultsDomain: string,
): void {
  if (result.status === 'restored') {
    console.log(
      chalk.yellow(
        `Detected an interrupted ${appName} setup from a previous run; your original terminal settings were restored. A terminal restart may be needed for them to take effect.`,
      ),
    )
  } else if (result.status === 'failed') {
    console.error(
      chalk.red(
        `An interrupted ${appName} setup was detected but the settings could not be restored automatically. Restore them manually with: defaults import ${defaultsDomain} ${result.backupPath}`,
      ),
    )
  }
}

export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerousSkip: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  if (customSessionId) {
    switchSession(customSessionId as SessionId, consumeSessionHomePin())
  }

  if (!isBareMode() || messagingSocketPath) {
  }
  if (isAgentSwarmsEnabled() && !isBareMode()) {
    captureTeammateModeSnapshot()
  }

  if (getIsInteractive()) {
    if (isAgentSwarmsEnabled()) {
      reportBackupRestore(
        await checkAndRestoreITerm2Backup(),
        'iTerm2',
        'com.googlecode.iterm2',
      )
    }
    try {
      reportBackupRestore(
        await checkAndRestoreTerminalBackup(),
        'Terminal.app',
        'com.apple.Terminal',
      )
    } catch (error) {
      logError(error)
    }
  }

  setCwd(cwd)
  let activeCwd = cwd

  const hooksStartedAt = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStartedAt,
  })
  initializeFileChangedWatcher(activeCwd)

  if (worktreeEnabled) {
    const hookConfigured = hasWorktreeCreateHook()
    const inGitRepo = await getIsGit()
    if (!hookConfigured && !inGitRepo) {
      console.error(
        chalk.red(
          `Cannot create a worktree: ${activeCwd} is not a git repository and no WorktreeCreate hook is configured in settings.json.`,
        ),
      )
      process.exit(1)
    }

    const slug =
      worktreePRNumber !== undefined
        ? `pr-${worktreePRNumber}`
        : worktreeName || getPlanSlug(getSessionId())

    let tmuxSessionName: string | undefined
    if (inGitRepo) {
      const mainRoot = findCanonicalGitRoot(activeCwd)
      if (!mainRoot) {
        console.error(
          chalk.red('Cannot create a worktree: the repository root could not be resolved.'),
        )
        process.exit(1)
      }
      if (mainRoot !== activeCwd) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        setCwd(mainRoot)
        activeCwd = mainRoot
      }
      if (tmuxEnabled) {
        tmuxSessionName = generateTmuxSessionName(mainRoot, worktreeBranchName(slug))
      }
    } else if (tmuxEnabled) {
      tmuxSessionName = generateTmuxSessionName(activeCwd, worktreeBranchName(slug))
    }

    let worktreeSession: WorktreeSession
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber !== undefined ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(
          `The worktree could not be created: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      )
      process.exit(1)
    }

    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        console.log(
          chalk.green(
            `tmux session ${tmuxSessionName} is ready — attach with: tmux attach -t ${tmuxSessionName}`,
          ),
        )
      } else {
        console.log(
          chalk.yellow(`The tmux session could not be created: ${tmuxResult.error ?? 'unknown error'}`),
        )
      }
    }

    activeCwd = worktreeSession.worktreePath
    setCwd(activeCwd)
    const { applyHarnessGround } = await import('./services/switchboard/harnessGround.js')
    await applyHarnessGround(getCwd())
    saveWorktreeState(worktreeSession)
    captureHooksConfigSnapshot()
  }

  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  if (!isBareMode()) {
    initSessionMemory()
  }
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  if (!isBareMode()) {
    void import('./extensions/boot.js')
      .then(async boot => {
        await boot.ensureExtensionsLoaded()
        boot.installExtensionsChangeSubscription()
        await getCommands(getProjectRoot())
      })
      .catch((error: unknown) => logError(error))
  }
  profileCheckpoint('setup_after_prefetch')

  if (!isBareMode()) {
    registerSessionFileAccessHooks()
  }

  initSinks()

  if (checkHasTrustDialogAccepted()) {
    prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession())
  }

  if (!isBareMode()) {
    const lastSeen = getGlobalConfig().lastReleaseNotesSeen
    const notes = getRecentReleaseNotes(MERCURY_VERSION, lastSeen)
    if (notes.length > 0) {
      await getRecentActivity()
    }
  }

  if (modeBypassesPermissions(permissionMode) || allowDangerousSkip) {
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0
    ) {
      console.error(
        'Refusing --dangerously-bypass-permissions under root/sudo — running permission-free with superuser rights is a security hazard.',
      )
      process.exit(1)
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  const projectConfig = getCurrentProjectConfig()
  void projectConfig.lastCost
  void projectConfig.lastDuration
}
