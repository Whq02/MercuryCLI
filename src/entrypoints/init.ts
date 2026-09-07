import { memoize } from 'lodash-es'
import '../bootstrap/state.js'
import '../utils/config.js'
import { enableConfigs } from '../utils/config.js'
import { findMostRecentBackup } from '../utils/config/globalConfig.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { setupGracefulShutdown, gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { recordFirstStartTime } from '../utils/config/derived.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import { configureGlobalAgents } from '../utils/proxy.js'
import { armWindowsShellRoad } from '../utils/shell/windowsShellRoad.js'
import { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { ensureLocalSettingsSchema } from '../utils/settings/localSchema.js'
import { getGithubRepo } from '../utils/git.js'
import { restoreGatewayAuth } from '../utils/gatewayTrust.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { ConfigParseError, ConfigReadError } from '../utils/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { isSessionMarkedNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'

export const init: () => Promise<void> = memoize(async (): Promise<void> => {
  profileCheckpoint('init_function_start')
  try {
    enableConfigs()
    profileCheckpoint('init_configs_enabled')

    applySafeConfigEnvironmentVariables()
    try {
      const { checkHasTrustDialogAccepted } = await import('../utils/config/trust.js')
      if (checkHasTrustDialogAccepted()) applyConfigEnvironmentVariables()
    } catch (error) {
      logForDebugging(`init: trusted env application skipped: ${String(error)}`)
    }
    profileCheckpoint('init_safe_env_applied')

    applyExtraCACertsFromConfig()
    profileCheckpoint('init_ca_certs_applied')

    setupGracefulShutdown()
    profileCheckpoint('init_shutdown_installed')

    void populateOAuthAccountInfoIfNeeded().catch((error: unknown) =>
      logForDebugging(`init: oauth account populate failed: ${String(error)}`),
    )

    void restoreGatewayAuth().catch(() => {})

    void initJetBrainsDetection().catch(() => {})
    void getGithubRepo().catch(() => {})

    setImmediate(() => {
      try {
        ensureLocalSettingsSchema()
      } catch {
      }
    })


    recordFirstStartTime()
    profileCheckpoint('init_background_dispatch_done')

    configureGlobalMTLS()
    profileCheckpoint('init_mtls_configured')
    configureGlobalAgents()
    profileCheckpoint('init_agents_configured')


    armWindowsShellRoad()

    registerCleanup(() => shutdownLspServerManager())

    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import('../utils/swarm/teamHelpers.js')
      await cleanupSessionTeams()
    })

    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigReadError) {
      process.stderr.write(
        `Mercury cannot read its configuration file at ${error.filePath} (${error.code}).\n` +
          `The file exists, so Mercury will not start on defaults: that would overwrite your saved account,\n` +
          `projects and trust grants on the next save. Make the file readable — fix its permissions, or close\n` +
          `the program holding it open — then start Mercury again.\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    if (error instanceof ConfigParseError) {
      if (isSessionMarkedNonInteractive()) {
        let backupPath: string | null = null
        try {
          backupPath = findMostRecentBackup(error.filePath)
        } catch {
          backupPath = null
        }
        process.stderr.write(
          `Configuration error in ${(error as { filePath?: string }).filePath ?? 'settings'}: ${error.message}\n` +
            (backupPath !== null
              ? `A backup file exists at: ${backupPath}\nYou can restore it by running: cp "${backupPath}" "${error.filePath}"\n`
              : ''),
        )
        gracefulShutdownSync(1)
        return
      }
      const { showInvalidConfigDialog } = await import('../components/InvalidConfigDialog.js')
      return showInvalidConfigDialog({ error })
    }
    throw error
  }
})
