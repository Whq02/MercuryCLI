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
import { CREW_LEAD_NAME } from '../../utils/swarm/constants.js'
import { startInProcessCrewmate, type FirstDispatchOutcome, type InProcessRunnerConfig } from '../../utils/swarm/inProcessRunner.js'
import { resolveCrewmateRole, type ResolvedCrewmateRole } from '../../utils/swarm/roleResolver.js'
import { spawnInProcessCrewmate, unwindCrewmateSpawn } from '../../utils/swarm/spawnInProcess.js'
import { parseCrewCharter } from '../../utils/swarm/crewCharter.js'
import { appendCrewMember, readCrewFileAsync, removeCrewmateFromCrewFile, type CrewFile } from '../../utils/swarm/crewHelpers.js'
import { assignCrewmateColor } from '../../utils/crew/crewmateColors.js'
import { getHardcodedCrewmateModelFallback } from '../../utils/swarm/crewmateModel.js'
import { crewContextFor, resolveSpawnCrew } from '../../utils/crew/crewBirth.js'
import { crewWorktreeSlug, resolveCrewStart } from '../../utils/crew/crewStart.js'


const DESCRIPTION_PROMPT_CHARS = 50

export type SpawnCrewmateConfig = {
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


function defaultCrewmateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().crewmateDefaultModel
  const word = typeof configured === 'string' ? configured.trim().toLowerCase() : configured
  if (word === null || word === 'leader') return leaderModel ?? getHardcodedCrewmateModelFallback()
  if (typeof word === 'string' && word !== '' && word !== 'default') return parseUserSpecifiedModel(configured as string)
  return getHardcodedCrewmateModelFallback()
}

export function resolveCrewmateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? defaultCrewmateModel(leaderModel)
  }
  if (inputModel === undefined) return defaultCrewmateModel(leaderModel)
  return inputModel
}


export async function generateUniqueCrewmateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) return baseName
  let crew: CrewFile | null = null
  try {
    crew = await readCrewFileAsync(teamName)
  } catch {
    return baseName
  }
  if (!crew) return baseName
  const taken = new Set(crew.members.map(member => member.name.toLowerCase()))
  if (!taken.has(baseName.toLowerCase())) return baseName
  let suffix = 2
  while (taken.has(`${baseName}-${suffix}`.toLowerCase())) suffix += 1
  return `${baseName}-${suffix}`
}


type PreparedSpawn = {
  crewmateName: string
  crewmateId: string
  teamName: string
  color: string
  model: string
  effort?: string
  runtimeRef: AgentRuntimeRef
  planModeRequired: boolean
  prompt: string
  description: string
  roster: CrewFile | null
}

async function prepareSpawn(
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
): Promise<PreparedSpawn> {
  if (!config.name || !config.prompt) {
    throw new Error('Teammate spawns require both a name and a prompt.')
  }
  const crewContext = context.getAppState().crewContext as { teamName: string } | undefined
  const teamName = resolveSpawnCrew(crewContext)
  const uniqueName = await generateUniqueCrewmateName(config.name, teamName)
  const crewmateName = uniqueName.replaceAll('@', '-')
  const crewmateId = formatAgentId(crewmateName, teamName)
  const color = assignCrewmateColor(crewmateId)
  const model = resolveCrewmateModel(config.model, context.options.mainLoopModel ?? null)
  const promptPreview =
    config.prompt.length > DESCRIPTION_PROMPT_CHARS
      ? `${config.prompt.slice(0, DESCRIPTION_PROMPT_CHARS)}…`
      : config.prompt
  const roster = await readCrewFileAsync(teamName).catch(() => null)
  return {
    crewmateName,
    crewmateId,
    teamName,
    color,
    model,
    ...(config.effort !== undefined && config.effort !== '' ? { effort: config.effort } : {}),
    runtimeRef: describeAgentRuntimeRef(model),
    planModeRequired: config.plan_mode_required ?? false,
    prompt: config.prompt,
    description: `${crewmateName}: ${promptPreview}`,
    roster,
  }
}

function roleInputs(
  prepared: PreparedSpawn,
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
): Parameters<typeof resolveCrewmateRole>[0] {
  return {
    crewmateName: prepared.crewmateName,
    requestedAgentType: config.agent_type,
    agents: context.options.agentDefinitions?.activeAgents ?? [],
    prompt: prepared.prompt,
    description: config.description,
    charter: parseCrewCharter((prepared.roster as { charter?: unknown } | null)?.charter ?? null),
  }
}

function canonicalAgentTypeOf(
  resolvedRole: ResolvedCrewmateRole,
  config: SpawnCrewmateConfig,
): string | undefined {
  return resolvedRole.definition ? resolvedRole.agentType : config.agent_type
}


async function spawnInProcessStrategy(
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
  prepared: PreparedSpawn,
): Promise<SpawnOutput> {
  const { crewmateId, crewmateName, teamName } = prepared

  const resolvedRole = resolveCrewmateRole({ ...roleInputs(prepared, config, context) })
  const canonicalAgentType = canonicalAgentTypeOf(resolvedRole, config)

  const bundle = await getInstructionBundle()
  const instructionAtSpawn = { profile: bundle.resolution.resolved, digest: bundle.bundleDigest }

  const transcriptAgentId = config.resume?.transcriptAgentId ?? generateTaskId('local_agent')
  const start = await resolveCrewStart(
    {
      name: crewmateName,
      cwd: config.cwd ?? getCwd(),
      ...(config.worktree !== undefined ? { worktree: config.worktree } : {}),
      model: prepared.model,
    },
    { slug: crewWorktreeSlug(transcriptAgentId) },
  )

  const spawnResult = await spawnInProcessCrewmate(
    {
      name: crewmateName,
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
    await appendCrewMember(teamName, {
      agentId: crewmateId,
      name: crewmateName,
      agentType: canonicalAgentType ?? crewmateName,
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
    if (spawnResult.taskId !== undefined) unwindCrewmateSpawn(spawnResult.taskId, context.setAppStateForTasks ?? context.setAppState, errorMessage(error))
    throw error
  }

  if (spawnResult.taskId && spawnResult.crewmateContext && spawnResult.abortController) {
    let settleFirstDispatch: (outcome: FirstDispatchOutcome) => void = () => {}
    const firstDispatch = new Promise<FirstDispatchOutcome>(resolve => {
      settleFirstDispatch = resolve
    })
    try {
    startInProcessCrewmate({
      identity: {
        agentId: crewmateId,
        agentName: crewmateName,
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
      crewmateContext: spawnResult.crewmateContext,
      abortController: spawnResult.abortController,
      ...(config.invokingRequestId ? { invokingRequestId: config.invokingRequestId } : {}),
      toolUseContext: { ...context, messages: [] },
      onFirstDispatch: outcome => settleFirstDispatch(outcome),
    })
    } catch (error) {
      removeCrewmateFromCrewFile(teamName, { agentId: crewmateId })
      throw error
    }
    const outcome = await firstDispatch
    if (!outcome.ok) {
      removeCrewmateFromCrewFile(teamName, { agentId: crewmateId })
      throw new Error(
        `Teammate "${crewmateName}" failed at its first dispatch and is not running: ${outcome.cause}`,
      )
    }
  }

  context.setAppState(prevState => {
    const existing = prevState.crewContext as
      | {
          teamName: string
          crewFilePath: string
          leadAgentId: string
          crewmates: Record<string, unknown>
        }
      | undefined
    const crewContext = existing ?? crewContextFor(teamName)
    const crewmates: Record<string, unknown> = { ...crewContext.crewmates }
    let leadAgentId = crewContext.leadAgentId
    if (!leadAgentId) {
      leadAgentId = formatAgentId(CREW_LEAD_NAME, teamName)
      crewmates[CREW_LEAD_NAME] = {
        name: CREW_LEAD_NAME,
        agentType: CREW_LEAD_NAME,
        color: assignCrewmateColor(leadAgentId),
        tmuxSessionName: 'in-process',
        tmuxPaneId: 'leader',
        cwd: getCwd(),
        spawnedAt: Date.now(),
      }
    }
    crewmates[crewmateName] = {
      name: crewmateName,
      agentType: canonicalAgentType ?? crewmateName,
      color: prepared.color,
      tmuxSessionName: 'in-process',
      tmuxPaneId: 'in-process',
      cwd: start.runDir,
      spawnedAt: Date.now(),
    }
    return {
      ...prevState,
      crewContext: { ...crewContext, leadAgentId, crewmates },
    } as typeof prevState
  })


  return {
    teammate_id: crewmateId,
    agent_id: crewmateId,
    agent_type: config.agent_type,
    model: prepared.model,
    name: crewmateName,
    color: prepared.color,
    tmux_session_name: 'in-process',
    tmux_window_name: 'in-process',
    tmux_pane_id: 'in-process',
    team_name: teamName,
    is_splitpane: false,
    plan_mode_required: prepared.planModeRequired,
  }
}

export async function spawnCrewmate(
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const prepared = await prepareSpawn(config, context)
  return { data: await spawnInProcessStrategy(config, context, prepared) }
}
