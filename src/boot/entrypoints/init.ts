import { memoize } from 'lodash-es'
import { isSessionRunArgv, readSessionOptionValues } from '../sessionArgs.js'
import { BASH_TOOL_NAME } from '../../tools/kit/names/bash.js'
import { enableConfigs } from '../../platform/settings/config.js'
import { findMostRecentBackup } from '../../platform/config/globalConfig.js'
import { applyExtraCACertsFromConfig } from '../../platform/network/caCertsConfig.js'
import { setupGracefulShutdown, gracefulShutdownSync } from '../../platform/processes/gracefulShutdown.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { recordFirstStartTime } from '../../platform/config/derived.js'
import { configureGlobalMTLS } from '../../platform/network/mtls.js'
import { configureGlobalAgents } from '../../platform/network/proxy.js'
import { beginLoginFiles } from '../../platform/shell/shellRecord.js'
import { armWindowsShellRoad } from '../../platform/shell/windowsShellRoad.js'
import { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables, configEnvironmentIsApplied } from '../../platform/environment/settingsEnv.js'
import { permissionRuleValueFromString } from '../../permissions/rules/permissionRuleParser.js'
import { parseToolListFromCLI } from '../../permissions/rules/permissionSetup.js'
import { ensureLocalSettingsSchema } from '../../platform/settings/localSchema.js'
import { getGithubRepo } from '../../platform/git/git.js'
import { restoreGatewayAuth } from './gatewayTrust.js'
import { populateOAuthAccountInfoIfNeeded } from '../../models/sign-in/oauth/client.js'
import { shutdownLspServerManager } from '../../integrations/lsp/serverManagerLifecycle.js'
import { ConfigParseError, ConfigReadError } from '../../platform/errors/errors.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { sendPassedOverToDebugLog } from '../../platform/errors/passedOverSink.js'
import { isSessionMarkedNonInteractive } from '../../screen/cockpit/runtimePosture.js'
import { profileCheckpoint } from '../startupProfiler.js'
import { armScratchpadSweep } from '../../platform/files/scratchpad.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startImmediate } from '../../platform/async/timers.js'

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
      const { checkHasTrustDialogAccepted } = await import('../../platform/config/trust.js')
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
      const { showInvalidConfigDialog } = await import('../first-run/InvalidConfigDialog.js')
      return showInvalidConfigDialog({ error })
    }
    throw error
  }
})
