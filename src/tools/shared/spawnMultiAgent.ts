import { statSync } from 'node:fs'
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
import { appendCrewMember, crewmateStopped, readCrewFileAsync, removeCrewmateFromCrewFile, type CrewFile } from '../../utils/swarm/crewHelpers.js'
import { assignCrewmateColor } from '../../utils/crew/crewmateColors.js'
import { getHardcodedCrewmateModelFallback } from '../../utils/swarm/crewmateModel.js'
import { crewContextFor, resolveSpawnCrew } from '../../utils/crew/crewBirth.js'
import { crewWorktreeSlug, resolveCrewStart } from '../../utils/crew/crewStart.js'
import { setLeaderCrewName } from '../../utils/tasks.js'


const DESCRIPTION_PROMPT_CHARS = 50

export type SpawnCrewmateConfig = {
  name: string
  prompt: string
  crew_name?: string
  cwd?: string
  worktree?: { at?: string }
  model?: string
  effort?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
  resume?: InProcessRunnerConfig['resume'] & { worktree?: string }
}

export type SpawnOutput = {
  crewmate_id: string
  agent_id: string
  agent_type?: string
  model: string
  name: string
  color: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  crew_name?: string
  is_splitpane: boolean
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
  crewName: string | undefined,
): Promise<string> {
  if (!crewName) return baseName
  let crew: CrewFile | null = null
  try {
    crew = await readCrewFileAsync(crewName)
  } catch {
    return baseName
  }
  if (!crew) return baseName
  const taken = new Set(crew.members.filter(member => !crewmateStopped(member)).map(member => member.name.toLowerCase()))
  if (!taken.has(baseName.toLowerCase())) return baseName
  let suffix = 2
  while (taken.has(`${baseName}-${suffix}`.toLowerCase())) suffix += 1
  return `${baseName}-${suffix}`
}


type PreparedSpawn = {
  crewmateName: string
  crewmateId: string
  crewName: string
  color: string
  model: string
  effort?: string
  runtimeRef: AgentRuntimeRef
  prompt: string
  description: string
  roster: CrewFile | null
}

async function prepareSpawn(
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
): Promise<PreparedSpawn> {
  if (!config.name || !config.prompt) {
    throw new Error('Crewmate spawns require both a name and a prompt.')
  }
  const crewContext = context.getAppState().crewContext as { crewName: string } | undefined
  const crewName = resolveSpawnCrew(crewContext)
  const uniqueName = await generateUniqueCrewmateName(config.name, crewName)
  const crewmateName = uniqueName.replaceAll('@', '-')
  const crewmateId = formatAgentId(crewmateName, crewName)
  const color = assignCrewmateColor(crewmateId)
  const model = resolveCrewmateModel(config.model, context.options.mainLoopModel ?? null)
  const promptPreview =
    config.prompt.length > DESCRIPTION_PROMPT_CHARS
      ? `${config.prompt.slice(0, DESCRIPTION_PROMPT_CHARS)}…`
      : config.prompt
  const roster = await readCrewFileAsync(crewName).catch(() => null)
  return {
    crewmateName,
    crewmateId,
    crewName,
    color,
    model,
    ...(config.effort !== undefined && config.effort !== '' ? { effort: config.effort } : {}),
    runtimeRef: describeAgentRuntimeRef(model),
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

function standingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}


async function spawnInProcessStrategy(
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
  prepared: PreparedSpawn,
): Promise<SpawnOutput> {
  const { crewmateId, crewmateName, crewName } = prepared

  const resolvedRole = resolveCrewmateRole({ ...roleInputs(prepared, config, context) })
  const canonicalAgentType = canonicalAgentTypeOf(resolvedRole, config)

  const bundle = await getInstructionBundle()
  const instructionAtSpawn = { profile: bundle.resolution.resolved, digest: bundle.bundleDigest }

  const transcriptAgentId = config.resume?.transcriptAgentId ?? generateTaskId('local_agent')
  const cwd = config.cwd ?? getCwd()
  const kept = config.resume?.worktree
  const start =
    kept !== undefined && standingDirectory(kept)
      ? { name: crewmateName, cwd, worktree: { path: kept }, runDir: kept, model: prepared.model }
      : await resolveCrewStart(
          {
            name: crewmateName,
            cwd,
            ...(config.worktree !== undefined ? { worktree: config.worktree } : {}),
            model: prepared.model,
          },
          { slug: crewWorktreeSlug(transcriptAgentId) },
        )

  const spawnResult = await spawnInProcessCrewmate(
    {
      name: crewmateName,
      crewName,
      prompt: prepared.prompt,
      color: prepared.color,
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
    throw new Error(spawnResult.error ?? 'In-process crewmate spawn failed')
  }

  try {
    await appendCrewMember(crewName, {
      agentId: crewmateId,
      name: crewmateName,
      agentType: canonicalAgentType ?? crewmateName,
      model: prepared.model,
      prompt: prepared.prompt,
      color: prepared.color,
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
  setLeaderCrewName(crewName)

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
        crewName,
        color: prepared.color,
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
      removeCrewmateFromCrewFile(crewName, { agentId: crewmateId })
      throw error
    }
    const outcome = await firstDispatch
    if (!outcome.ok) {
      removeCrewmateFromCrewFile(crewName, { agentId: crewmateId })
      throw new Error(
        `Crewmate "${crewmateName}" failed at its first dispatch and is not running: ${outcome.cause}`,
      )
    }
  }

  context.setAppState(prevState => {
    const existing = prevState.crewContext as
      | {
          crewName: string
          crewFilePath: string
          leadAgentId: string
          crewmates: Record<string, unknown>
        }
      | undefined
    const crewContext = existing ?? crewContextFor(crewName)
    const crewmates: Record<string, unknown> = { ...crewContext.crewmates }
    let leadAgentId = crewContext.leadAgentId
    if (!leadAgentId) {
      leadAgentId = formatAgentId(CREW_LEAD_NAME, crewName)
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
    crewmate_id: crewmateId,
    agent_id: crewmateId,
    agent_type: config.agent_type,
    model: prepared.model,
    name: crewmateName,
    color: prepared.color,
    tmux_session_name: 'in-process',
    tmux_window_name: 'in-process',
    tmux_pane_id: 'in-process',
    crew_name: crewName,
    is_splitpane: false,
  }
}

export async function spawnCrewmate(
  config: SpawnCrewmateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const prepared = await prepareSpawn(config, context)
  return { data: await spawnInProcessStrategy(config, context, prepared) }
}
