
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import type { ToolUseContext } from '../kit/tool.js'
import { MERCURY_CONSTITUTION, mercuryCrewmateContract, type MercuryCrewmateSeat } from '../../engine/system-prompt/mercuryContract.js'
import { getRuntimePostureDoctrineLine } from '../../screen/cockpit/runtimePosture.js'
import { getVulcanDoctrineLine } from '../../integrations/vulcan/vulcanGates.js'
import { loadMemoryPrompt } from '../../sessions/mneme/mnemeFrontPage.js'
import { RETAIN_TOOL_NAME } from '../kit/names/memory.js'
import { changeTransactionEnabled } from '../engines/change-transaction/contracts.js'
import { ENVELOPE_DOCTRINE } from '../../crew/agent-results/contracts.js'
import { MERCURY_SCOUT_AGENT } from './built-in/mercuryScoutAgent.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const FIXED_OUTPUT_AGENT_TYPES = new Set<string>(
  [MERCURY_SCOUT_AGENT]
    .filter(d => d.fixedOutputContract)
    .map(d => d.agentType),
)

export function isFixedOutputAgent(def: Pick<AgentDefinition, 'agentType'>): boolean {
  return FIXED_OUTPUT_AGENT_TYPES.has(def.agentType)
}

const crewmateDoctrineFor = (seat: MercuryCrewmateSeat): string => `<subagent-doctrine>\n${mercuryCrewmateContract(seat)}\n</subagent-doctrine>`

export function crewmateFanoutCap(): number | null {
  const raw = flagEnv('MERCURY_AGENT_FANOUT_CAP')
  if (raw === undefined || raw.trim() === '') return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function crewmateMemoryLoadNote(error: string): string {
  return `this crewmate runs without your pinned rules: memory could not be loaded (${error})`
}

function safeMemoryPrompt(verbs: 'all' | 'read'): { text: string | null; error?: string } {
  try {
    return { text: loadMemoryPrompt({ verbs, role: 'child' }) }
  } catch (error) {
    passedOver(error)
    return { text: null, error: errorMessage(error) }
  }
}

function memoryVerbsFor(agentDefinition: Pick<AgentDefinition, 'agentType'>, toolNames?: ReadonlySet<string>): 'all' | 'read' {
  if (agentDefinition.agentType === MERCURY_SCOUT_AGENT.agentType) return 'read'
  if (toolNames !== undefined && !toolNames.has(RETAIN_TOOL_NAME)) return 'read'
  return 'all'
}

export function buildCrewmateMercurySectionsWithOutcome(args: {
  agentDefinition: Pick<AgentDefinition, 'agentType'>
  toolUseContext?: Pick<ToolUseContext, 'options'>
  toolNames?: ReadonlySet<string>
  seat?: MercuryCrewmateSeat
}): { sections: string[]; memoryLoadError?: string } {

  const { agentDefinition, seat = 'a crewmate' } = args

  const exempt = isFixedOutputAgent(agentDefinition)

  const floor = MERCURY_CONSTITUTION

  const operating = crewmateDoctrineFor(seat)

  const posture = getRuntimePostureDoctrineLine()

  const vulcanDoctrine = getVulcanDoctrineLine()

  const envelopeDoctrine =
    changeTransactionEnabled() && !exempt ? ENVELOPE_DOCTRINE : null

  const memory = safeMemoryPrompt(memoryVerbsFor(agentDefinition, args.toolNames))

  const sections = [
    floor,
    operating,
    ...(posture ? [posture] : []),
    ...(vulcanDoctrine ? [vulcanDoctrine] : []),
    ...(envelopeDoctrine ? [envelopeDoctrine] : []),
    ...(memory.text ? [memory.text] : []),
  ]
  return memory.error !== undefined ? { sections, memoryLoadError: memory.error } : { sections }
}

export function buildCrewmateMercurySections(args: {
  agentDefinition: Pick<AgentDefinition, 'agentType'>
  toolUseContext?: Pick<ToolUseContext, 'options'>
  toolNames?: ReadonlySet<string>
  seat?: MercuryCrewmateSeat
}): string[] {
  return buildCrewmateMercurySectionsWithOutcome(args).sections
}