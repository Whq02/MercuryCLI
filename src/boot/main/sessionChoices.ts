import { setMainThreadAgentType } from '../process-state/processState.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getAgentDefinitionsWithOverrides, computeActiveAgents, parseAgentsFromJson } from '../../tools/crewmate/loadAgentsDir.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { logError } from '../../platform/logs/errorLog.js'
import { initializeToolPermissionContext, stripDangerousPermissionsForFlow } from '../../permissions/rules/permissionSetup.js'
import { modeBypassesPermissions, type PermissionMode } from '../../permissions/rules/permissionMode.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { isSessionRunArgv as isRunArgv } from '../sessionArgs.js'
import { failCli, typedString, type RootOptions } from './cli.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export async function resolvePermissions(opts: RootOptions) {
  const bypassFromRegistry = isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS')) && !isRunArgv()
  const dangerouslySkipPermissions = Boolean(opts.sovereign) || opts.mode === 'sovereign' || bypassFromRegistry
  const allowDangerousSkip = Boolean(opts.allowSovereign)
  const sovereignAvailable = allowDangerousSkip || !isRunArgv()
  const { initialPermissionModeFromCLI, isSovereignDisabled } = await import('../../permissions/rules/permissionSetup.js')
  const explicitMode = typedString(opts.mode) as PermissionMode | undefined
  if (opts.sovereign && explicitMode && !modeBypassesPermissions(explicitMode)) {
    failCli(`mercury run: --sovereign conflicts with --mode ${explicitMode}; choose one permission posture`)
  }
  if ((opts.sovereign || opts.mode === 'sovereign' || allowDangerousSkip) && isSovereignDisabled()) {
    const word = opts.sovereign ? '--sovereign' : opts.mode === 'sovereign' ? '--mode sovereign' : '--allow-sovereign'
    failCli(`mercury run: ${word} is disabled by permissions policy`)
  }
  const resolved = initialPermissionModeFromCLI({
    permissionModeCli: typedString(opts.mode),
    dangerouslySkipPermissions,
  })
  const permissionMode: PermissionMode = resolved.mode
  const { setSessionSovereign } = await import('../process-state/processState.js')
  setSessionSovereign(modeBypassesPermissions(permissionMode))

  const permissionInit = await initializeToolPermissionContext({
    allowedToolsCli: (opts.allowedTools as string[] | undefined) ?? [],
    disallowedToolsCli: (opts.blockTools as string[] | undefined) ?? [],
    baseToolsCli: opts.toolset as string[] | undefined,
    permissionMode,
    allowDangerouslySkipPermissions: sovereignAvailable,
  })
  let toolPermissionContext = permissionInit.toolPermissionContext
  for (const warning of permissionInit.warnings) console.error(warning)
  if (permissionInit.dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForFlow(toolPermissionContext)
  }
  return { allowDangerousSkip, permissionMode, toolPermissionContext }
}

export function thinkingConfigOf(thinkingOpt: string | undefined, shouldEnableThinkingByDefault: typeof import('../../models/effort/thinking.js').shouldEnableThinkingByDefault): import('../../models/effort/thinking.js').ThinkingConfig {
  let thinkingConfig: import('../../models/effort/thinking.js').ThinkingConfig
  if (thinkingOpt === 'enabled' || thinkingOpt === 'adaptive') thinkingConfig = { type: 'adaptive' }
  else if (thinkingOpt === 'disabled') thinkingConfig = { type: 'disabled' }
  else {
    const envTokens = flagEnv('MERCURY_THINKING_BUDGET')
    const budget = envTokens !== undefined ? Number.parseInt(envTokens, 10) : undefined
    if (budget !== undefined && Number.isFinite(budget) && budget > 0) {
      thinkingConfig = { type: 'enabled', budgetTokens: budget }
    } else if (budget === 0) {
      thinkingConfig = { type: 'disabled' }
    } else {
      thinkingConfig = shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' }
    }
  }
  return thinkingConfig
}

export function agentsWithCliDefs(opts: RootOptions, agentInfo: Awaited<ReturnType<typeof getAgentDefinitionsWithOverrides>>) {
  let activeAgents = agentInfo.activeAgents
  let allAgents = agentInfo.allAgents
  if (typedString(opts.agentDefs)) {
    try {
      const cliAgents = parseAgentsFromJson(JSON.parse(typedString(opts.agentDefs)!) as unknown)
      allAgents = [...allAgents, ...cliAgents]
      activeAgents = computeActiveAgents(allAgents)
    } catch (error) {
      logError(error)
      failCli(`Invalid agent definitions (${error instanceof Error ? error.message : String(error)}).`)
    }
  }
  return { activeAgents, allAgents }
}

export function mainThreadAgentOf(opts: RootOptions, activeAgents: AgentDefinition[], lspAgentNote: typeof import('../../integrations/lsp-family/toolFamily.js').lspAgentNote): AgentDefinition | undefined {
  for (const agent of activeAgents) {
    if (agent.tools?.includes('LSP')) console.error(lspAgentNote(agent.agentType))
    if (agent.disallowedTools?.includes('LSP')) console.error(lspAgentNote(agent.agentType, true))
  }
  const requestedAgent = typedString(opts.agent) ?? getInitialSettings().engine?.agent
  let mainThreadAgentDefinition: AgentDefinition | undefined
  if (requestedAgent) {
    mainThreadAgentDefinition = activeAgents.find(agent => agent.agentType === requestedAgent)
    if (!mainThreadAgentDefinition) {
      const refusal = `unknown agent '${requestedAgent}' — available: ${activeAgents.map(agent => agent.agentType).join(', ')}`
      if (typedString(opts.agent) !== undefined) {
        failCli(refusal)
      }
      process.stderr.write(`${refusal} (from settings.engine.agent — running without it)\n`)
      logForDebugging(refusal)
    } else {
      setMainThreadAgentType(requestedAgent)
      void import('../../sessions/transcripts/sessionStorage.js')
        .then(storage => storage.saveAgentSetting(requestedAgent))
        .catch(passedOver)
    }
  }
  return mainThreadAgentDefinition
}
