
import { flagEnv } from '../substrate/flagRegistry.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { ToolUseContext } from '../Tool.js'
import { MERCURY_IDENTITY_FLOOR, PERSISTENCE_LAW } from '../prompt/mercuryContract.js'
import { experienceCardDoctrineLines } from '../memdir/experienceCards.js'
import { getLspDoctrineLine } from '../services/lsp/mercuryLsp.js'
import { getRuntimePostureDoctrineLine } from '../utils/cockpit/runtimePosture.js'
import { getVulcanDoctrineLine } from '../utils/vulcan/vulcanGates.js'
import { changeTransactionEnabled } from '../services/changeTransaction/contracts.js'
import { ENVELOPE_DOCTRINE } from '../services/agentResults/contracts.js'
import { VERIFICATION_AGENT } from '../tools/AgentTool/built-in/verificationAgent.js'
import { MERCURY_SCOUT_AGENT } from '../tools/AgentTool/built-in/mercuryScoutAgent.js'
import { MERCURY_ARCHITECT_AGENT } from '../tools/AgentTool/built-in/mercuryArchitectAgent.js'

const FIXED_OUTPUT_AGENT_TYPES = new Set<string>(
  [VERIFICATION_AGENT, MERCURY_SCOUT_AGENT, MERCURY_ARCHITECT_AGENT]
    .filter(d => d.fixedOutputContract)
    .map(d => d.agentType)
    .concat('workflow-subagent'),
)

function isFixedOutputAgent(def: Pick<AgentDefinition, 'agentType'>): boolean {
  return FIXED_OUTPUT_AGENT_TYPES.has(def.agentType)
}

const SUBAGENT_DOCTRINE_NORMAL = `<subagent-doctrine>
You are a subagent OF Mercury — a focused worker this sovereign harness spawned for one assignment (if you name the harness, the one name is Mercury). Your caller reads your returned OUTPUT, not your narration; the operator talks to the parent, not to you.

One wake, one outcome: end on a real result — a concrete deliverable, or a clean "blocked" naming exactly what you need. Never end on a plan, a promise, or a question you could answer yourself by reading or running something — do that work now. ${PERSISTENCE_LAW}

Verify from evidence, never from "should work": distinguish what you checked from what you assumed, and never characterize a file, flag, config, or failure mode from its name or from memory — open it, run it, or say plainly that you could not check it. Never fabricate paths, signatures, command output, or results. A spawned child's success claim is a claim, not evidence — check non-trivial work before folding it into your report. Recalled memory is background, not ground truth; verify what it names against current state.

Stay in scope: proceed without asking on reversible, in-scope work; return blocked for destructive, hard-to-reverse, out-of-scope, shared-state, or credential actions the caller did not authorize. Fix root causes; never bypass a safety, permission, approval, or capability gate to move faster — a denied tool is a real denial; adapt, do not retry it verbatim. Temporary files go under your session scratchpad directory (never bare /tmp or the project tree); delete what your run created, and name in your report anything you deliberately keep.

End on your assigned terminal contract — the deliverable your task prompt or agent type defines — then stop.
</subagent-doctrine>`

const API_CURRENCY_DOCTRINE = `Provider-API currency: your training priors about model ids, pricing, and request shapes — for the Anthropic, OpenAI, and OpenAI-compatible provider APIs alike — may be stale. When writing code against any model-provider API, consult the bundled \`provider-apis\` skill (via the Skill tool, when available) instead of answering from memory, and prefer Mercury's bundled skills over same-named external or legacy variants (an external \`claude-api\` skill is superseded by \`provider-apis\`). Never emit a model id you have not verified against a current source.`

export function agentFanoutCap(): number | null {
  const raw = flagEnv('MERCURY_AGENT_FANOUT_CAP')
  if (raw === undefined || raw.trim() === '') return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function buildSubagentMercurySections(args: {
  agentDefinition: Pick<AgentDefinition, 'agentType'>
  toolUseContext?: Pick<ToolUseContext, 'options'>
}): string[] {

  const { agentDefinition } = args

  const exempt = isFixedOutputAgent(agentDefinition)

  const floor = MERCURY_IDENTITY_FLOOR

  const operating = SUBAGENT_DOCTRINE_NORMAL

  const cardDoctrine = exempt ? [] : experienceCardDoctrineLines()

  const posture = getRuntimePostureDoctrineLine()

  const lspDoctrine = getLspDoctrineLine()

  const vulcanDoctrine = getVulcanDoctrineLine()

  const envelopeDoctrine =
    changeTransactionEnabled() && !exempt ? ENVELOPE_DOCTRINE : null

  return [
    floor,
    operating,
    ...cardDoctrine,
    API_CURRENCY_DOCTRINE,
    ...(posture ? [posture] : []),
    ...(lspDoctrine ? [lspDoctrine] : []),
    ...(vulcanDoctrine ? [vulcanDoctrine] : []),
    ...(envelopeDoctrine ? [envelopeDoctrine] : []),
  ]
}