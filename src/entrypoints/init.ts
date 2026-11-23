import { memoize } from 'lodash-es'
import { isSessionRunArgv, readSessionOptionValues } from '../utils/sessionArgs.js'
import { BASH_TOOL_NAME } from '../constants/tools/bash.js'
import { enableConfigs } from '../utils/config.js'
import { findMostRecentBackup } from '../utils/config/globalConfig.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { setupGracefulShutdown, gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { recordFirstStartTime } from '../utils/config/derived.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import { configureGlobalAgents } from '../utils/proxy.js'
import { beginLoginFiles } from '../utils/shell/shellRecord.js'
import { armWindowsShellRoad } from '../utils/shell/windowsShellRoad.js'
import { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables, configEnvironmentIsApplied } from '../utils/managedEnv.js'
import { permissionRuleValueFromString } from '../utils/permissions/permissionRuleParser.js'
import { parseToolListFromCLI } from '../utils/permissions/permissionSetup.js'
import { ensureLocalSettingsSchema } from '../utils/settings/localSchema.js'
import { getGithubRepo } from '../utils/git.js'
import { restoreGatewayAuth } from '../utils/gatewayTrust.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { ConfigParseError, ConfigReadError } from '../utils/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { sendPassedOverToDebugLog } from '../utils/passedOverSink.js'
import { isSessionMarkedNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { armScratchpadSweep } from '../utils/scratchpad.js'
import { passedOver } from '../utils/passedOver.js'
import { startImmediate } from '../utils/timers.js'

function runArgumentsLeaveBashOut(args: readonly string[]): boolean {
  const toolset = readSessionOptionValues(args, '--toolset')
  if (toolset !== null && !parseToolListFromCLI(toolset).includes(BASH_TOOL_NAME)) return true
  return parseToolListFromCLI(readSessionOptionValues(args, '--block-tools') ?? []).some(rule => {
    const denied = permissionRuleValueFromString(rule)
    return denied.toolName === BASH_TOOL_NAME && denied.ruleContent === undefined
  })
}

export const init: () => Promise<void> = memoize(async (): Promise<void> => {
  try {
    profileCheckpoint('init_function_start')
    enableConfigs()
    profileCheckpoint('init_configs_enabled')

    applySafeConfigEnvironmentVariables()
    try {
      const { checkHasTrustDialogAccepted } = await import('../utils/config/trust.js')
      if (checkHasTrustDialogAccepted()) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logForDebugging(`init: trusted env application skipped: ${String(error)}`)
    }
    profileCheckpoint('init_safe_env_applied')

    sendPassedOverToDebugLog()
    applyExtraCACertsFromConfig()
    profileCheckpoint('init_ca_certs_applied')

    setupGracefulShutdown()
    armScratchpadSweep()
    profileCheckpoint('init_shutdown_installed')

    if (
      isSessionRunArgv() &&
      !runArgumentsLeaveBashOut(process.argv.slice(2)) &&
      configEnvironmentIsApplied()
    ) {
      beginLoginFiles()
    }

    void populateOAuthAccountInfoIfNeeded().catch(error => {
      logForDebugging(`init: oauth account populate failed: ${String(error)}`)
    })
    void restoreGatewayAuth().catch(passedOver)
    void getGithubRepo().catch(passedOver)
    startImmediate(() => {
      try {
        ensureLocalSettingsSchema()
      } catch (error) {
        passedOver(error)
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
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigReadError) {
      process.stderr.write(
        `Mercury cannot read its configuration file at ${error.filePath} (${error.code}).\n` +
          `The file exists, so Mercury will not start on defaults and overwrite your saved account,\n` +
          `projects and trust grants on the next save. Make the file readable (fix its permissions or close\n` +
          `the program holding it open), then start Mercury again.\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    if (error instanceof ConfigParseError) {
      if (isSessionMarkedNonInteractive()) {
        const fileLabel = error.filePath || 'settings'
        const lines = [`Configuration error in ${fileLabel}: ${error.message}`]
        if (error.filePath) {
          let backup: string | null = null
          try {
            backup = findMostRecentBackup(error.filePath)
          } catch (backupError) {
            passedOver(backupError)
          }
          if (backup) {
            lines.push(
              `A backup file exists at: ${backup}`,
              `You can restore it by running: cp "${backup}" "${error.filePath}"`,
            )
          }
        }
        process.stderr.write(lines.join('\n') + '\n')
        gracefulShutdownSync(1)
        return
      }
      const { showInvalidConfigDialog } = await import('../components/InvalidConfigDialog.js')
      return showInvalidConfigDialog({ error })
    }
    throw error
  }
})
