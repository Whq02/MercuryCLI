import { getSessionId } from '../../bootstrap/state.js'
import { getInstructionBundle } from '../../services/instructions/engine.js'
import { generateTaskId } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import { formatAgentId } from '../../utils/agentId.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { errorMessage } from '../../utils/errors.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { describeAgentRuntimeRef, type AgentRuntimeRef } from '../../services/providers/primaryBackend.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { startInProcessTeammate, type FirstDispatchOutcome, type InProcessRunnerConfig } from '../../utils/swarm/inProcessRunner.js'
import { resolveTeammateRole, type ResolvedTeammateRole } from '../../utils/swarm/roleResolver.js'
import { spawnInProcessTeammate, unwindTeammateSpawn } from '../../utils/swarm/spawnInProcess.js'
import { parseTeamCharter } from '../../utils/swarm/teamCharter.js'
import { appendTeamMember, readTeamFileAsync, removeTeammateFromTeamFile, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../../utils/crew/crewmateColors.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { crewContextFor, resolveSpawnCrew } from '../../utils/crew/crewBirth.js'
import { crewWorktreeSlug, resolveCrewStart } from '../../utils/crew/crewStart.js'


const DESCRIPTION_PROMPT_CHARS = 50

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  worktree?: { at?: string }
  plan_mode_required?: boolean
  model?: string
  effort?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
  resume?: InProcessRunnerConfig['resume']
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
  const word = typeof configured === 'string' ? configured.trim().toLowerCase() : configured
  if (word === null || word === 'leader') return leaderModel ?? getHardcodedTeammateModelFallback()
  if (typeof word === 'string' && word !== '' && word !== 'default') return parseUserSpecifiedModel(configured as string)
  return getHardcodedTeammateModelFallback()
}

export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? defaultTeammateModel(leaderModel)
  }
  if (inputModel === undefined) return defaultTeammateModel(leaderModel)
  return inputModel
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
  effort?: string
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
  const teamName = resolveSpawnCrew(teamContext)
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
    ...(config.effort !== undefined && config.effort !== '' ? { effort: config.effort } : {}),
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

  const transcriptAgentId = config.resume?.transcriptAgentId ?? generateTaskId('local_agent')
  const start = await resolveCrewStart(
    {
      name: teammateName,
      cwd: config.cwd ?? getCwd(),
      ...(config.worktree !== undefined ? { worktree: config.worktree } : {}),
      model: prepared.model,
    },
    { slug: crewWorktreeSlug(transcriptAgentId) },
  )

  const spawnResult = await spawnInProcessTeammate(
    {
      name: teammateName,
      teamName,
      prompt: prepared.prompt,
      color: prepared.color,
      planModeRequired: prepared.planModeRequired,
      model: start.model,
      cwd: start.cwd,
      ...(start.worktree !== null ? { worktree: start.worktree.path } : {}),
      ...(prepared.effort !== undefined ? { effort: prepared.effort } : {}),
      transcriptAgentId,
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

  try {
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
      cwd: start.runDir,
      ...(start.worktree !== null ? { worktreePath: start.worktree.path } : {}),
      subscriptions: [],
      backendType: 'in-process',
    } as never)
  } catch (error) {
    if (spawnResult.taskId !== undefined) unwindTeammateSpawn(spawnResult.taskId, context.setAppStateForTasks ?? context.setAppState, errorMessage(error))
    throw error
  }

  if (spawnResult.taskId && spawnResult.teammateContext && spawnResult.abortController) {
    let settleFirstDispatch: (outcome: FirstDispatchOutcome) => void = () => {}
    const firstDispatch = new Promise<FirstDispatchOutcome>(resolve => {
      settleFirstDispatch = resolve
    })
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
      model: start.model,
      cwd: start.runDir,
      ...(prepared.effort !== undefined ? { effortOverride: prepared.effort } : {}),
      ...(spawnResult.transcriptAgentId !== undefined ? { transcriptAgentId: spawnResult.transcriptAgentId } : {}),
      ...(config.resume !== undefined ? { resume: config.resume } : {}),
      ...(resolvedRole.definition ? { agentDefinition: resolvedRole.definition } : {}),
      role: resolvedRole,
      teammateContext: spawnResult.teammateContext,
      abortController: spawnResult.abortController,
      ...(config.invokingRequestId ? { invokingRequestId: config.invokingRequestId } : {}),
      toolUseContext: { ...context, messages: [] },
      onFirstDispatch: outcome => settleFirstDispatch(outcome),
    })
    } catch (error) {
      removeTeammateFromTeamFile(teamName, { agentId: teammateId })
      throw error
    }
    const outcome = await firstDispatch
    if (!outcome.ok) {
      removeTeammateFromTeamFile(teamName, { agentId: teammateId })
      throw new Error(
        `Teammate "${teammateName}" failed at its first dispatch and is not running: ${outcome.cause}`,
      )
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
    const teamContext = existing ?? crewContextFor(teamName)
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
      cwd: start.runDir,
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

export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const prepared = await prepareSpawn(config, context)
  return { data: await spawnInProcessStrategy(config, context, prepared) }
}
