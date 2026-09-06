import * as React from 'react'

import { getSessionId, getFlagSettingsPath, getSessionExtensions, getMainLoopModelOverride, getSessionBypassPermissionsMode } from '../../bootstrap/state.js'
import { getInstructionBundle } from '../../services/instructions/engine.js'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { createTaskStateBase, generateTaskId, type SetAppState } from '../../Task.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolUseContext } from '../../Tool.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { describeAgentRuntimeRef, type AgentRuntimeRef } from '../../services/providers/primaryBackend.js'
import { enforceSubagentModelFloor } from '../../utils/model/modelFloor.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import { assertSpawnCwd, recordSpawn, SPAWNED_BY_ENV, spawnedByStamp } from '../../utils/spawnLedger.js'
import {
  isInITerm2,
  isInsideTmuxSync,
  isIt2CliAvailable,
  isTmuxAvailable,
  resetDetectionCache,
} from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  SWARM_VIEW_WINDOW_NAME,
  TEAM_LEAD_NAME,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { It2SetupPrompt } from '../../utils/swarm/It2SetupPrompt.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import { resolveTeammateRole, type ResolvedTeammateRole } from '../../utils/swarm/roleResolver.js'
import { spawnInProcessTeammate } from '../../utils/swarm/spawnInProcess.js'
import { buildInheritedEnvVars, getTeammateCommand } from '../../utils/swarm/spawnUtils.js'
import { parseTeamCharter } from '../../utils/swarm/teamCharter.js'
import { appendTeamMember, readTeamFileAsync, removeTeammateFromTeamFile, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { getTeamName } from '../../utils/teammate.js'
import { registerTask } from '../../utils/task/framework.js'
import { sanitizeName } from '../../utils/swarm/teamHelpers.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'


const DESCRIPTION_PROMPT_CHARS = 50

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
}

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model: string
  name: string
  color: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane: boolean
  plan_mode_required: boolean
}


function defaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (typeof configured === 'string') return parseUserSpecifiedModel(configured)
  if (configured === null) return leaderModel ?? getHardcodedTeammateModelFallback()
  return getHardcodedTeammateModelFallback()
}

export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  let resolved: string
  if (inputModel === 'inherit') {
    resolved = leaderModel ?? defaultTeammateModel(leaderModel)
  } else if (inputModel === undefined) {
    resolved = defaultTeammateModel(leaderModel)
  } else {
    resolved = inputModel
  }
  return enforceSubagentModelFloor(resolved, 'spawnTeammate')
}


export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) return baseName
  let team: TeamFile | null = null
  try {
    team = await readTeamFileAsync(teamName)
  } catch {
    return baseName
  }
  if (!team) return baseName
  const taken = new Set(team.members.map(member => member.name.toLowerCase()))
  if (!taken.has(baseName.toLowerCase())) return baseName
  let suffix = 2
  while (taken.has(`${baseName}-${suffix}`.toLowerCase())) suffix += 1
  return `${baseName}-${suffix}`
}


type PreparedSpawn = {
  teammateName: string
  teammateId: string
  teamName: string
  color: string
  model: string
  runtimeRef: AgentRuntimeRef
  planModeRequired: boolean
  prompt: string
  description: string
  roster: TeamFile | null
}

async function prepareSpawn(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<PreparedSpawn> {
  if (!config.name || !config.prompt) {
    throw new Error('Teammate spawns require both a name and a prompt.')
  }
  const teamContext = context.getAppState().teamContext as { teamName: string } | undefined
  const teamName = config.team_name ?? getTeamName(teamContext)
  if (!teamName) {
    throw new Error(
      'No team to spawn into: pass a team name, or create the team first with the team-create tool.',
    )
  }
  const uniqueName = await generateUniqueTeammateName(config.name, teamName)
  const teammateName = uniqueName.replaceAll('@', '-')
  const teammateId = formatAgentId(teammateName, teamName)
  const color = assignTeammateColor(teammateId)
  const model = resolveTeammateModel(config.model, context.options.mainLoopModel ?? null)
  const promptPreview =
    config.prompt.length > DESCRIPTION_PROMPT_CHARS
      ? `${config.prompt.slice(0, DESCRIPTION_PROMPT_CHARS)}…`
      : config.prompt
  const roster = await readTeamFileAsync(teamName).catch(() => null)
  return {
    teammateName,
    teammateId,
    teamName,
    color,
    model,
    runtimeRef: describeAgentRuntimeRef(model),
    planModeRequired: config.plan_mode_required ?? false,
    prompt: config.prompt,
    description: `${teammateName}: ${promptPreview}`,
    roster,
  }
}

function roleInputs(
  prepared: PreparedSpawn,
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Parameters<typeof resolveTeammateRole>[0] {
  return {
    teammateName: prepared.teammateName,
    requestedAgentType: config.agent_type,
    agents: context.options.agentDefinitions?.activeAgents ?? [],
    prompt: prepared.prompt,
    description: config.description,
    charter: parseTeamCharter((prepared.roster as { charter?: unknown } | null)?.charter ?? null),
  }
}

function canonicalAgentTypeOf(
  resolvedRole: ResolvedTeammateRole,
  config: SpawnTeammateConfig,
): string | undefined {
  return resolvedRole.definition ? resolvedRole.agentType : config.agent_type
}


function identityFlags(
  prepared: PreparedSpawn,
  canonicalAgentType: string | undefined,
): string[] {
  return [
    `--agent-id ${quote([prepared.teammateId])}`,
    `--agent-name ${quote([prepared.teammateName])}`,
    `--team-name ${quote([prepared.teamName])}`,
    `--agent-color ${quote([prepared.color])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    prepared.planModeRequired ? '--strategy-mode-required' : '',
    canonicalAgentType ? `--agent-type ${quote([canonicalAgentType])}` : '',
  ].filter(flag => flag.length > 0)
}

function inheritedFlags(prepared: PreparedSpawn, context: ToolUseContext): string[] {
  const flags: string[] = []
  const permissionMode = context.getAppState().toolPermissionContext.mode
  if (!prepared.planModeRequired) {
    if (
      modeBypassesPermissions(permissionMode) ||
      getSessionBypassPermissionsMode()
    ) {
      flags.push('--dangerously-bypass-permissions')
    } else if (permissionMode === 'implement') {
      flags.push('--permission-mode implement')
    } else if (permissionMode === 'flow') {
      flags.push('--permission-mode flow')
    }
  }
  const modelOverride = getMainLoopModelOverride()
  if (typeof modelOverride === 'string' && modelOverride.length > 0) {
    flags.push(`--model ${quote([modelOverride])}`)
  }
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) flags.push(`--settings ${quote([settingsPath])}`)
  for (const extensionPath of getSessionExtensions()) {
    flags.push(`--extension ${quote([extensionPath])}`)
  }
  return flags
}

function childCommand(
  prepared: PreparedSpawn,
  context: ToolUseContext,
  canonicalAgentType: string | undefined,
  envPrefix: string,
  workingDir: string,
): string {
  let flags = [...identityFlags(prepared, canonicalAgentType), ...inheritedFlags(prepared, context)]
  if (prepared.model) {
    flags = flags.filter(flag => !flag.startsWith('--model '))
    flags.push(`--model ${quote([prepared.model])}`)
  }
  const binary = getTeammateCommand()
  return `cd ${quote([workingDir])} && ${envPrefix} ${quote([binary])} ${flags.join(' ')}`
}


function registerTeammateInState(
  prepared: PreparedSpawn,
  context: ToolUseContext,
  canonicalAgentType: string | undefined,
  markers: { sessionName: string; paneId: string },
  workingDir: string,
): void {
  context.setAppState(prevState => {
    const existing = prevState.teamContext as
      | { teamName: string; teamFilePath: string; leadAgentId: string; teammates: Record<string, unknown> }
      | undefined
    const teamContext = existing ?? {
      teamName: prepared.teamName,
      teamFilePath: '',
      leadAgentId: '',
      teammates: {},
    }
    return {
      ...prevState,
      teamContext: {
        ...teamContext,
        teammates: {
          ...teamContext.teammates,
          [prepared.teammateName]: {
            name: prepared.teammateName,
            agentType: canonicalAgentType ?? prepared.teammateName,
            color: prepared.color,
            tmuxSessionName: markers.sessionName,
            tmuxPaneId: markers.paneId,
            cwd: workingDir,
            spawnedAt: Date.now(),
          },
        },
      },
    } as typeof prevState
  })
}

function registerPaneTask(
  prepared: PreparedSpawn,
  context: ToolUseContext,
  backend: ReturnType<typeof getBackendByType>,
  paneId: string,
  insideTmux: boolean,
): void {
  const taskId = generateTaskId('in_process_teammate')
  const base = createTaskStateBase(taskId, 'in_process_teammate', prepared.description, context.toolUseId)
  const abortController = new AbortController()
  const task: InProcessTeammateTaskState = {
    ...base,
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: prepared.teammateId,
      agentName: prepared.teammateName,
      teamName: prepared.teamName,
      color: prepared.color,
      planModeRequired: prepared.planModeRequired,
      parentSessionId: String(getSessionId()),
    },
    prompt: prepared.prompt,
    abortController,
    awaitingPlanApproval: false,
    permissionMode: prepared.planModeRequired ? 'strategy' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }
  const setter: SetAppState = context.setAppStateForTasks ?? context.setAppState
  registerTask(task, setter)
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backend.type)) {
        void backend.killPane(paneId, !insideTmux).catch(() => {})
      }
    },
    { once: true },
  )
}


async function spawnSplitPane(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
  prepared: PreparedSpawn,
): Promise<SpawnOutput> {
  const { teammateId, teammateName, teamName } = prepared
  const workingDir = config.cwd ?? getCwd()

  if (isInITerm2() && !(await isIt2CliAvailable()) && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()
    const choice = await new Promise<'cancelled' | 'installed' | 'use-tmux'>(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, { tmuxAvailable, onDone: resolve }),
        shouldHidePromptInput: true,
      })
    })
    context.setToolJSX!(null)
    if (choice === 'cancelled') {
      throw new Error('Teammate spawn cancelled — terminal setup is required first.')
    }
    resetDetectionCache()
    resetBackendDetection()
  }

  const cwdCheck = assertSpawnCwd(workingDir)
  if (!cwdCheck.ok) {
    recordSpawn({ kind: 'teammate-refused', id: teammateId, cwd: workingDir, reason: cwdCheck.reason })
    throw new Error(
      `Teammate spawn refused: ${cwdCheck.reason}. Fix the working directory or archive the roster.`,
    )
  }
  recordSpawn({ kind: 'teammate', id: teammateId, cwd: workingDir })

  const resolvedRole = resolveTeammateRole({ ...roleInputs(prepared, config, context) })
  const canonicalAgentType = canonicalAgentTypeOf(resolvedRole, config)

  const detection = await detectAndGetBackend()
  const backend = detection.backend
  const insideTmux = isInsideTmuxSync()

  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    teammateName,
    prepared.color as never,
  )
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  const instructionProfile = resolvedRole.definition?.instructionProfile
  const envPrefix = [
    buildInheritedEnvVars(),
    ...flagSpellings(SPAWNED_BY_ENV).map(sp => `${sp}=${quote([spawnedByStamp('teammate', teammateId)])}`),
    ...(instructionProfile
      ? flagSpellings('MERCURY_INSTRUCTION_PROFILE').map(sp => `${sp}=${quote([instructionProfile])}`)
      : []),
  ]
    .filter(part => part.length > 0)
    .join(' ')

  const command = childCommand(prepared, context, canonicalAgentType, envPrefix, workingDir)
  await sendCommandToPane(paneId, command, !insideTmux)

  registerTeammateInState(
    prepared,
    context,
    canonicalAgentType,
    { sessionName: insideTmux ? 'current' : SWARM_SESSION_NAME, paneId },
    workingDir,
  )
  registerPaneTask(prepared, context, backend, paneId, insideTmux)
  await appendTeamMember(teamName, {
    agentId: teammateId,
    name: teammateName,
    agentType: canonicalAgentType ?? teammateName,
    model: prepared.model,
    prompt: prepared.prompt,
    color: prepared.color,
    planModeRequired: prepared.planModeRequired,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: backend.type,
  } as never)

  void (await writeToMailbox(
    teammateName,
    { from: TEAM_LEAD_NAME, text: prepared.prompt, timestamp: new Date().toISOString() },
    teamName,
  ))

  return {
    teammate_id: teammateId,
    agent_id: teammateId,
    agent_type: config.agent_type,
    model: prepared.model,
    name: teammateName,
    color: prepared.color,
    tmux_session_name: insideTmux ? 'current' : SWARM_SESSION_NAME,
    tmux_window_name: insideTmux ? 'current' : SWARM_VIEW_WINDOW_NAME,
    tmux_pane_id: paneId,
    team_name: teamName,
    is_splitpane: true,
    plan_mode_required: prepared.planModeRequired,
  }
}


async function spawnSeparateWindow(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
  prepared: PreparedSpawn,
): Promise<SpawnOutput> {
  const { teammateId, teammateName, teamName } = prepared
  const workingDir = config.cwd ?? getCwd()

  const cwdCheck = assertSpawnCwd(workingDir)
  if (!cwdCheck.ok) {
    recordSpawn({ kind: 'teammate-refused', id: teammateId, cwd: workingDir, reason: cwdCheck.reason })
    throw new Error(
      `Teammate spawn refused: ${cwdCheck.reason}. Fix the working directory or archive the roster.`,
    )
  }
  recordSpawn({ kind: 'teammate', id: teammateId, cwd: workingDir })

  const resolvedRole = resolveTeammateRole({ ...roleInputs(prepared, config, context) })
  const canonicalAgentType = canonicalAgentTypeOf(resolvedRole, config)

  const hasSession = await execFileNoThrow(TMUX_COMMAND, ['has-session', '-t', SWARM_SESSION_NAME])
  if (hasSession.code !== 0) {
    const created = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      SWARM_SESSION_NAME,
    ])
    if (created.code !== 0) {
      throw new Error(`Could not create the shared teammate session: ${created.stderr}`)
    }
  }

  const windowName = `teammate-${sanitizeName(teammateName)}`
  const createdWindow = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])
  if (createdWindow.code !== 0) {
    throw new Error(`Could not create the teammate window: ${createdWindow.stderr}`)
  }
  const paneId = createdWindow.stdout.trim()

  const instructionProfile = resolvedRole.definition?.instructionProfile
  const envPrefix = [
    buildInheritedEnvVars(),
    ...flagSpellings(SPAWNED_BY_ENV).map(sp => `${sp}=${quote([spawnedByStamp('teammate', teammateId)])}`),
    ...(instructionProfile
      ? flagSpellings('MERCURY_INSTRUCTION_PROFILE').map(sp => `${sp}=${quote([instructionProfile])}`)
      : []),
  ]
    .filter(part => part.length > 0)
    .join(' ')
  const command = childCommand(prepared, context, canonicalAgentType, envPrefix, workingDir)

  const sent = await execFileNoThrow(TMUX_COMMAND, [
    'send-keys',
    '-t',
    `${SWARM_SESSION_NAME}:${windowName}`,
    command,
    'Enter',
  ])
  if (sent.code !== 0) {
    throw new Error(`Could not start the teammate in its window: ${sent.stderr}`)
  }

  registerTeammateInState(
    prepared,
    context,
    canonicalAgentType,
    { sessionName: SWARM_SESSION_NAME, paneId },
    workingDir,
  )
  registerPaneTask(prepared, context, getBackendByType('tmux'), paneId, false)
  await appendTeamMember(teamName, {
    agentId: teammateId,
    name: teammateName,
    agentType: canonicalAgentType ?? teammateName,
    model: prepared.model,
    prompt: prepared.prompt,
    color: prepared.color,
    planModeRequired: prepared.planModeRequired,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: 'tmux',
  } as never)

  void (await writeToMailbox(
    teammateName,
    { from: TEAM_LEAD_NAME, text: prepared.prompt, timestamp: new Date().toISOString() },
    teamName,
  ))

  return {
    teammate_id: teammateId,
    agent_id: teammateId,
    agent_type: config.agent_type,
    model: prepared.model,
    name: teammateName,
    color: prepared.color,
    tmux_session_name: SWARM_SESSION_NAME,
    tmux_window_name: windowName,
    tmux_pane_id: paneId,
    team_name: teamName,
    is_splitpane: false,
    plan_mode_required: prepared.planModeRequired,
  }
}


async function spawnInProcessStrategy(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
  prepared: PreparedSpawn,
): Promise<SpawnOutput> {
  const { teammateId, teammateName, teamName } = prepared

  const resolvedRole = resolveTeammateRole({ ...roleInputs(prepared, config, context) })
  const canonicalAgentType = canonicalAgentTypeOf(resolvedRole, config)

  const bundle = await getInstructionBundle()
  const instructionAtSpawn = { profile: bundle.resolution.resolved, digest: bundle.bundleDigest }

  const spawnResult = await spawnInProcessTeammate(
    {
      name: teammateName,
      teamName,
      prompt: prepared.prompt,
      color: prepared.color,
      planModeRequired: prepared.planModeRequired,
      model: prepared.model,
      ...(resolvedRole.definition ? { agentType: resolvedRole.agentType } : {}),
      instructionAtSpawn,
    },
    {
      setAppState: context.setAppStateForTasks ?? context.setAppState,
      ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}),
    },
  )
  if (!spawnResult.success) {
    throw new Error(spawnResult.error ?? 'In-process teammate spawn failed')
  }

  await appendTeamMember(teamName, {
    agentId: teammateId,
    name: teammateName,
    agentType: canonicalAgentType ?? teammateName,
    model: prepared.model,
    prompt: prepared.prompt,
    color: prepared.color,
    planModeRequired: prepared.planModeRequired,
    joinedAt: Date.now(),
    tmuxPaneId: 'in-process',
    cwd: getCwd(),
    subscriptions: [],
    backendType: 'in-process',
  } as never)

  if (spawnResult.taskId && spawnResult.teammateContext && spawnResult.abortController) {
    try {
    startInProcessTeammate({
      identity: {
        agentId: teammateId,
        agentName: teammateName,
        teamName,
        color: prepared.color,
        planModeRequired: prepared.planModeRequired,
        parentSessionId: String(getSessionId()),
      },
      taskId: spawnResult.taskId,
      prompt: prepared.prompt,
      description: config.description,
      model: prepared.model,
      ...(resolvedRole.definition ? { agentDefinition: resolvedRole.definition } : {}),
      role: resolvedRole,
      teammateContext: spawnResult.teammateContext,
      abortController: spawnResult.abortController,
      ...(config.invokingRequestId ? { invokingRequestId: config.invokingRequestId } : {}),
      toolUseContext: { ...context, messages: [] },
    })
    } catch (error) {
      removeTeammateFromTeamFile(teamName, { agentId: teammateId })
      throw error
    }
  }

  context.setAppState(prevState => {
    const existing = prevState.teamContext as
      | {
          teamName: string
          teamFilePath: string
          leadAgentId: string
          teammates: Record<string, unknown>
        }
      | undefined
    const teamContext = existing ?? {
      teamName,
      teamFilePath: '',
      leadAgentId: '',
      teammates: {},
    }
    const teammates: Record<string, unknown> = { ...teamContext.teammates }
    let leadAgentId = teamContext.leadAgentId
    if (!leadAgentId) {
      leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
      teammates[TEAM_LEAD_NAME] = {
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        color: assignTeammateColor(leadAgentId),
        tmuxSessionName: 'in-process',
        tmuxPaneId: 'leader',
        cwd: getCwd(),
        spawnedAt: Date.now(),
      }
    }
    teammates[teammateName] = {
      name: teammateName,
      agentType: canonicalAgentType ?? teammateName,
      color: prepared.color,
      tmuxSessionName: 'in-process',
      tmuxPaneId: 'in-process',
      cwd: getCwd(),
      spawnedAt: Date.now(),
    }
    return {
      ...prevState,
      teamContext: { ...teamContext, leadAgentId, teammates },
    } as typeof prevState
  })


  return {
    teammate_id: teammateId,
    agent_id: teammateId,
    agent_type: config.agent_type,
    model: prepared.model,
    name: teammateName,
    color: prepared.color,
    tmux_session_name: 'in-process',
    tmux_window_name: 'in-process',
    tmux_pane_id: 'in-process',
    team_name: teamName,
    is_splitpane: false,
    plan_mode_required: prepared.planModeRequired,
  }
}


let inProcessLatched = false

export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const prepared = await prepareSpawn(config, context)

  if (isInProcessEnabled() || inProcessLatched) {
    return { data: await spawnInProcessStrategy(config, context, prepared) }
  }

  try {
    await detectAndGetBackend()
  } catch (error) {
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    const paneBackendInstalled =
      (await isTmuxAvailable()) || (isInITerm2() && (await isIt2CliAvailable()))
    if (!paneBackendInstalled) {
      inProcessLatched = true
    }
    logForDebugging(
      `spawnTeammate: pane backend detection failed (${errorMessage(error)}); falling back to in-process` +
        (inProcessLatched ? ' (latched for this session)' : ''),
    )
    return { data: await spawnInProcessStrategy(config, context, prepared) }
  }

  if (config.use_splitpane === false) {
    return { data: await spawnSeparateWindow(config, context, prepared) }
  }
  return { data: await spawnSplitPane(config, context, prepared) }
}
