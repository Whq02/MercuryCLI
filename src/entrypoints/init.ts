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
import { unbuilt } from '../pi/holes.js'

function runArgumentsLeaveBashOut(args: readonly string[]): boolean {
  const toolset = readSessionOptionValues(args, '--toolset')
  if (toolset !== null && !parseToolListFromCLI(toolset).includes(BASH_TOOL_NAME)) return true
  return parseToolListFromCLI(readSessionOptionValues(args, '--block-tools') ?? []).some(rule => {
    const denied = permissionRuleValueFromString(rule)
    return denied.toolName === BASH_TOOL_NAME && denied.ruleContent === undefined
  })
}

export const init: () => Promise<void> = unbuilt('src/entrypoints/init.ts:40')
