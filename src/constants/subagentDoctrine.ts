// src/constants/subagentDoctrine.ts
//
// Mercury-specific SUBAGENT identity + operating-doctrine layer. ONE source of truth,
// injected at exactly TWO mutually-exclusive chokepoints so it can NEVER double-append:
//   • AgentTool.tsx:534 — the DEFAULT interactive Task/Agent spawn (bare-stamp, non-worktree,
//     non-cwd), which passes the result as override.systemPrompt (AgentTool.tsx:624-626) and
//     thus BYPASSES runAgent's getAgentSystemPrompt.
//   • runAgent.ts:916 (getAgentSystemPrompt) — reached only when override.systemPrompt is
//     UNDEFINED: AgentTool's worktree/cwd-isolated path, the workflow subagents
//     (defaultSpawnSubagentStream passes override with only agentId+abortController), and
//     bare-stamp resume.
// The two are mutually exclusive by AgentTool's `!worktreeInfo && !cwd` condition, so EVERY
// bare-stamp subagent — all built-in agents, custom agentTypes, the workflow subagent, and
// bare-stamp resumed agents — carries the Mercury identity floor + a PROPORTIONATE
// operating doctrine at model-wake exactly once. Fork/fork-resume children bypass both via
// override.systemPrompt = forkParentSystemPrompt (the parent's rendered prompt already
// carries the full floor+wrapper(+fable)).
//
// This is a THIN layer: the subagent already has its own task prompt; this adds the
// identity/honesty FLOOR (reused verbatim from mercuryContract) + a condensed operating
// register, NOT a second full system prompt.
//
// ONE register, ONE floor:
//   • FLOOR (always): MERCURY_IDENTITY_FLOOR — the always-on Mercury identity +
//     operator-first + honesty/safety floor (forbids deceiving end-users,
//     misrepresenting, claiming to be human, bypassing any safety/permission/approval/
//     capability gate — src/prompt/mercuryContract.ts). Reused unchanged so
//     honesty/permission/refusal can never be weakened. LEADS at index 0.
//   • NORMAL: the condensed Mercury operating block.
//
// EXCLUDES the workflow return-value contract by design — that stays owned by agentHooks'
// SUBAGENT_TEXT/SCHEMA prompts and the APPEND suffixes, and by verificationAgent's VERDICT
// line. The stop-rule here is phrased "end on your assigned terminal contract, then stop"
// so it COMPOSES with each agent's own contract rather than overriding it.
//
// FIXED-OUTPUT agents omit the card-write doctrine (out-of-scope for a fixed-output /
// read-only worker). Membership is DERIVED from each agent def's `fixedOutputContract`
// flag — see FIXED_OUTPUT_AGENT_TYPES below for the single source of truth + per-agent
// rationale (verification / Explore / Plan / workflow-subagent).
//
// GATING: the floor+normal doctrine is unconditional ; experienceCardDoctrineLines()
// self-gates on experienceCardsEnabled() AND is only spread for non-exempt agents.

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
// VALUE imports (not type) of the three loadable built-in defs, so the fable-exempt Set is
// DERIVED from their `fixedOutputContract` flag rather than a drifting string literal. These
// three only TYPE-import from loadAgentsDir, so they stay loadable under plain `bun run` (the
// proof imports this module) — unlike WORKFLOW_SUBAGENT_DEF (agentHooks.ts, bun:bundle + cycle).
import { VERIFICATION_AGENT } from '../tools/AgentTool/built-in/verificationAgent.js'
import { MERCURY_SCOUT_AGENT } from '../tools/AgentTool/built-in/mercuryScoutAgent.js'
import { MERCURY_ARCHITECT_AGENT } from '../tools/AgentTool/built-in/mercuryArchitectAgent.js'

// Agents whose own prompt defines a fixed output contract or a read-only scope. The
// card-write doctrine is omitted for them (the floor + outcome discipline still apply).
// Each is flagged
// `fixedOutputContract: true` ON ITS OWN DEFINITION, so this Set is DERIVED — a rename or a
// new fixed-output agent updates membership automatically rather than drifting from a literal:
//   • 'verification' — fixed `VERDICT: PASS|FAIL|PARTIAL` literal contract (VERIFICATION_AGENT)
//   • 'mercury-scout'     — read-only investigation agent (MERCURY_SCOUT_AGENT)
//   • 'mercury-architect' — read-only; disallows FILE_EDIT/FILE_WRITE/NOTEBOOK_EDIT + fixed
//                      "Required Output" contract (MERCURY_ARCHITECT_AGENT)
//   • 'workflow-subagent' — fixed verbatim-text (SUBAGENT_TEXT_PROMPT) OR StructuredOutput-once
//                      return; the schema twin (WORKFLOW_SUBAGENT_SCHEMA_DEF) inherits this
//                      agentType via the spread, so this one entry covers both. Keeps the
//                      card-write doctrine away from the verbatim-text return.
//
// DERIVED from the three value-importable built-in defs + one literal for 'workflow-subagent':
// WORKFLOW_SUBAGENT_DEF lives in agentHooks.ts, which is bun:bundle-unloadable AND
// would form an import cycle via runAgent → so it cannot be value-imported here. Its agentType
// is appended as a literal, guarded by the proof's membership assertion. The derived Set is
// byte-identical to the prior hard-coded {verification, Explore, Plan, workflow-subagent}.
const FIXED_OUTPUT_AGENT_TYPES = new Set<string>(
  [VERIFICATION_AGENT, MERCURY_SCOUT_AGENT, MERCURY_ARCHITECT_AGENT]
    .filter(d => d.fixedOutputContract)
    .map(d => d.agentType)
    .concat('workflow-subagent'),
)

function isFixedOutputAgent(def: Pick<AgentDefinition, 'agentType'>): boolean {
  return FIXED_OUTPUT_AGENT_TYPES.has(def.agentType)
}

// condensed from five enumerated paragraphs (~2.6KB)
// to the compact form below (~1.4KB) per the researched judgment-over-rules
// law — the FABLE_NATIVE
// variant below already proved the short shape carries the same contract.
// Every floor clause survives verbatim where a prover pins it (the opening
// identity phrase, the never-bypass-a-gate clause).
const SUBAGENT_DOCTRINE_NORMAL = `<subagent-doctrine>
You are a subagent OF Mercury — a focused worker this sovereign harness spawned for one assignment (if you name the harness, the one name is Mercury). Your caller reads your returned OUTPUT, not your narration; the operator talks to the parent, not to you.

One wake, one outcome: end on a real result — a concrete deliverable, or a clean "blocked" naming exactly what you need. Never end on a plan, a promise, or a question you could answer yourself by reading or running something — do that work now. ${PERSISTENCE_LAW}

Verify from evidence, never from "should work": distinguish what you checked from what you assumed, and never characterize a file, flag, config, or failure mode from its name or from memory — open it, run it, or say plainly that you could not check it. Never fabricate paths, signatures, command output, or results. A spawned child's success claim is a claim, not evidence — check non-trivial work before folding it into your report. Recalled memory is background, not ground truth; verify what it names against current state.

Stay in scope: proceed without asking on reversible, in-scope work; return blocked for destructive, hard-to-reverse, out-of-scope, shared-state, or credential actions the caller did not authorize. Fix root causes; never bypass a safety, permission, approval, or capability gate to move faster — a denied tool is a real denial; adapt, do not retry it verbatim. Temporary files go under your session scratchpad directory (never bare /tmp or the project tree); delete what your run created, and name in your report anything you deliberately keep.

End on your assigned terminal contract — the deliverable your task prompt or agent type defines — then stop.
</subagent-doctrine>`

// API-currency routing: a spawned agent writing code against a model-provider
// API reaches for training priors that predate the current model families and
// the Mercury-native skill set. One factual line routes it to the bundled
// provider-apis reference instead. Unconditional — the skill is compiled into
// every Mercury build (no gate to mirror), and the fable-exempt agents get it
// too: it is a fact line, not an operating register, and a workflow agent
// writing AI-app code is exactly the regression class this closes. The
// neutral model-currency rule rides the env block (MODEL_CURRENCY_NOTE in
// prompts.ts — computeEnvInfo), not this line.
const API_CURRENCY_DOCTRINE = `Provider-API currency: your training priors about model ids, pricing, and request shapes — for the Anthropic, OpenAI, and OpenAI-compatible provider APIs alike — may be stale. When writing code against any model-provider API, consult the bundled \`provider-apis\` skill (via the Skill tool, when available) instead of answering from memory, and prefer Mercury's bundled skills over same-named external or legacy variants (an external \`claude-api\` skill is superseded by \`provider-apis\`). Never emit a model id you have not verified against a current source.`

/**
 * Mercury-specific subagent identity + operating-doctrine sections, in assembly order
 * (floor LEADS, doctrine follows, gated experience-card doctrine last). Spliced BEFORE the
 * agent's own prompt at AgentTool.tsx:534 (default interactive path) and at
 * getAgentSystemPrompt (runAgent.ts:916, isolated/workflow/resume path). Returns [] when
 *
 *
 * @param agentDefinition the resolved agent (for the fixed-output exemption on agentType).
 * @param toolUseContext reserved for future per-session shaping; unused today (kept so the
 *                        seam signature matches both call sites and can grow without churn).
 */
/**
 * The operator's mechanical fan-out cap (sweep #2, B5.1 — RULED
 * conditional: config-gated, small). Unset means what it always meant: no
 * mechanical cap, the doctrine's judgment guidance governs. Set to a
 * positive integer, the ONE dispatch seam (AgentTool) refuses a spawn that
 * would put more than this many local agents in flight, with a typed
 * refusal naming the live count and this knob. The doctrine seam owns the
 * limit so guidance and enforcement cannot drift (law 6).
 */
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

  // FLOOR — reused verbatim (identity + operator-first + honesty/safety). LEADS so the
  // identity/honesty contract is read before any operating register. Provider-neutral.
  const floor = MERCURY_IDENTITY_FLOOR

  // OPERATING BLOCK — the one condensed Mercury operating register.
  const operating = SUBAGENT_DOCTRINE_NORMAL

  // Autoadaptive doctrine — self-gates on experienceCardsEnabled() ([] when off) AND is
  // omitted for fixed-output agents (the card-WRITE doctrine is out-of-scope for a fixed-
  // output / read-only worker and pushes its terminal contract further from the task). The
  // general-purpose and custom agents still get it. experienceCardDoctrineLines() returns
  // ['', ...lines] when on, so it carries its own leading blank line.
  const cardDoctrine = exempt ? [] : experienceCardDoctrineLines()

  // Init-path self-knowledge (#62): the one-line posture every spawned child
  // needs (deny-vs-failure semantics, lease semantics, the model floor). The
  // child runs INSIDE this same process, so the parent's interactivity mark is
  // its truth. Self-gates (MERCURY_RUNTIME_POSTURE; null ⇒ absent).
  const posture = getRuntimePostureDoctrineLine()

  // IDE-hands doctrine (MERCURY_LSP): one line telling every spawned agent to
  // ground edits in LSP evidence when the tool is available. Self-gates
  // (null when the bridge is off ⇒ byte-identical).
  const lspDoctrine = getLspDoctrineLine()

  // VULCAN Godot-control doctrine (MERCURY_GODOT_TOOLS): one line so a spawned
  // agent prefers the Godot tool over text-editing scene/resource files.
  // Self-gates on flag + project root (null ⇒ byte-identical).
  const vulcanDoctrine = getVulcanDoctrineLine()

  // Structured-completion doctrine: the optional
  // <mercury-envelope> tail every completion boundary parses. Gated with the
  // change-transaction layer (the observer cross-check it advertises);
  // fable-exempt agents keep their fixed output contracts untouched.
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