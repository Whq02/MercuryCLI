
import { flagEnv } from '../substrate/flagRegistry.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { ToolUseContext } from '../Tool.js'
import { MERCURY_IDENTITY_FLOOR, mercurySubagentContract, type MercuryAgentSeat } from '../prompt/mercuryContract.js'
import { getRuntimePostureDoctrineLine } from '../utils/cockpit/runtimePosture.js'
import { getVulcanDoctrineLine } from '../utils/vulcan/vulcanGates.js'
import { loadMemoryPrompt } from '../mneme/mnemeFrontPage.js'
import { RETAIN_TOOL_NAME } from '../tools/MemoryTools/prompt.js'
import { changeTransactionEnabled } from '../services/changeTransaction/contracts.js'
import { ENVELOPE_DOCTRINE } from '../services/agentResults/contracts.js'
import { MERCURY_SCOUT_AGENT } from '../tools/AgentTool/built-in/mercuryScoutAgent.js'

const FIXED_OUTPUT_AGENT_TYPES = new Set<string>(
  [MERCURY_SCOUT_AGENT]
    .filter(d => d.fixedOutputContract)
    .map(d => d.agentType)
    .concat('workflow-subagent'),
)

export function isFixedOutputAgent(def: Pick<AgentDefinition, 'agentType'>): boolean {
  return FIXED_OUTPUT_AGENT_TYPES.has(def.agentType)
}

const subagentDoctrineFor = (seat: MercuryAgentSeat): string => `<subagent-doctrine>\n${mercurySubagentContract(seat)}\n</subagent-doctrine>`

export function agentFanoutCap(): number | null {
  const raw = flagEnv('MERCURY_AGENT_FANOUT_CAP')
  if (raw === undefined || raw.trim() === '') return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function safeMemoryPrompt(verbs: 'all' | 'read'): string | null {
  try {
    return loadMemoryPrompt({ verbs })
  } catch {
    return null
  }
}

export function memoryVerbsFor(agentDefinition: Pick<AgentDefinition, 'agentType'>, toolNames?: ReadonlySet<string>): 'all' | 'read' {
  if (agentDefinition.agentType === MERCURY_SCOUT_AGENT.agentType) return 'read'
  if (toolNames !== undefined && !toolNames.has(RETAIN_TOOL_NAME)) return 'read'
  return 'all'
}

export function buildSubagentMercurySections(args: {
  agentDefinition: Pick<AgentDefinition, 'agentType'>
  toolUseContext?: Pick<ToolUseContext, 'options'>
  toolNames?: ReadonlySet<string>
  seat?: MercuryAgentSeat
}): string[] {

  const { agentDefinition, seat = 'a crewmate' } = args

  const exempt = isFixedOutputAgent(agentDefinition)

  const floor = MERCURY_IDENTITY_FLOOR

  const operating = subagentDoctrineFor(seat)

  const posture = getRuntimePostureDoctrineLine()

  const vulcanDoctrine = getVulcanDoctrineLine()

  const envelopeDoctrine =
    changeTransactionEnabled() && !exempt ? ENVELOPE_DOCTRINE : null

  const memory = safeMemoryPrompt(memoryVerbsFor(agentDefinition, args.toolNames))

  return [
    floor,
    operating,
    ...(posture ? [posture] : []),
    ...(vulcanDoctrine ? [vulcanDoctrine] : []),
    ...(envelopeDoctrine ? [envelopeDoctrine] : []),
    ...(memory ? [memory] : []),
  ]
}