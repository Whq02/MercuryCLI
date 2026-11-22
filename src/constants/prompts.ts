import { platform } from 'node:os'
import { platformKernelLine } from '../utils/platform/words.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { canAnswerAsks, getOriginalCwd, getProjectRoot, getSessionId, getSessionKind } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
import { composeSystemPrompt } from '../prompt/composer.js'
import { recordedComposition, recordCurrentStaticComposition } from '../prompt/recordedComposition.js'
import type { NamedSection } from '../prompt/mercuryContract.js'
import {
  MERCURY_CONSTITUTION,
  MERCURY_HEADLESS_CONSTITUTION,
  getMercuryContractSections,
  promptLayerSet,
  promptReplacementText,
} from '../prompt/mercuryContract.js'
import { getAntiSycophancyAlwaysOnSection } from '../utils/antiSycophancy.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isMcpInstructionsDeltaEnabled } from '../utils/mcpInstructionsDelta.js'
import { getVulcanSection } from '../services/vulcan/vulcanGates.js'
import { getModelKnowledgeCutoff } from '../utils/model/capabilities.js'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getCurrentWorktreeSession } from '../services/worktree.js'
import { ensureScratchpadDir, scratchpadPromptLine } from '../utils/scratchpad.js'
import { loadMemoryPrompt } from '../mneme/mnemeFrontPage.js'
import { composeEntryPage, ENTRY_PAGE_HEADING } from '../mneme/entryPage.js'
import { composeMemoryAtStart, MEMORY_AT_START_HEADING } from '../mneme/entryKnapsack.js'
import { journalOnEntryPage, lastJournalEntry } from '../mneme/journal.js'
import { noteSessionEngine } from '../mneme/lineageSession.js'
import { mnemeEnabled } from '../mneme/mnemeGates.js'
import { mnemeProjectKey } from '../mneme/paths.js'
import {
  DANGEROUS_uncachedSystemPromptSection,
  keyedSystemPromptSection,
  onSystemPromptSectionsCleared,
  resolveSystemPromptSections,
  systemPromptSection,
} from './systemPromptSections.js'
import { BASH_TOOL_NAME } from './tools/bash.js'
import { beginLoginFiles, shellLineWords } from '../utils/shell/shellRecord.js'
import { RECORD_CONVENTION_TOOL_NAME } from '../tools/RecordConventionTool/prompt.js'
import { RETAIN_TOOL_NAME } from './tools/memory.js'
import { getRuntimePostureSection, isUnattendedRun } from '../utils/cockpit/runtimePosture.js'
import { listCapabilityKills } from '../utils/permissions/capabilityGate.js'
import { isMcpPolicyActive } from '../utils/mcp/toolPolicy.js'
import { isAutoCompactEnabled } from '../services/compact/autoCompact.js'
import {
  LOCAL_CREWMATE_NOTES,
  LOCAL_POSTURE_WORDS,
  LOCAL_SUBAGENT_DOCTRINE,
  localEstateSection,
  localLaw,
  localPromptProfileApplies,
  localServerKind,
} from './localPromptProfile.js'
import { getHarnessMapSection } from '../services/cockpit/harnessMap.js'
import { missionSection, missionSectionKey, type ServedMission } from '../services/mission/served.js'
import type { Tools } from '../Tool.js'
import type { MCPServerConnection } from '../utils/mcp/types.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt } from '../pi/holes.js'

const MODEL_CURRENCY_NOTE = `Model currency: your training-era knowledge of model ids, capabilities, and prices — any vendor's — may be stale. When building AI applications, verify current model ids against live provider documentation or the operator's stated choice instead of defaulting to remembered ones.`
const PROVIDER_SKILL_PRECEDENCE = `For provider-API work, invoke provider-apis: it outranks any external provider-API skill, and a bundled Mercury skill outranks an external skill of the same name.`

function getModelCurrencySection(): string {
  return `${MODEL_CURRENCY_NOTE} ${PROVIDER_SKILL_PRECEDENCE}`
}

type StartTask = import('../mneme/entryKnapsack.js').StartTask

const memoryAtStartBySession = new Map<string, Promise<string | null>>()
onSystemPromptSectionsCleared(() => memoryAtStartBySession.clear())

function memoryAtStartKey(task: StartTask | undefined): string {
  return `${String(getSessionId())}:${task ? 'request' : 'preview'}`
}

function memoryAtStartForSession(task: StartTask | undefined): Promise<string | null> {
  const key = memoryAtStartKey(task)
  let composed = memoryAtStartBySession.get(key)
  if (composed === undefined) {
    composed = composeMemoryAtStart({ task, projectKey: mnemeProjectKey(), sessionId: String(getSessionId()), root: getProjectRoot() })
    memoryAtStartBySession.set(key, composed)
  }
  return composed
}

export function resetMemoryAtStartForTest(): void {
  memoryAtStartBySession.clear()
}

function prependBullets(items: Array<string | string[]>): string[] {
  return notBuilt('src/constants/prompts.ts:92')
}

function scratchpadLineFor(agentId?: string): string {
  return notBuilt('src/constants/prompts.ts:115')
}

export async function computeEnvInfo(
  modelId: string,
  agentId?: string,
): Promise<string> {
  return notBuilt('src/constants/prompts.ts:132')
}

export async function computeSimpleEnvInfo(
  modelId: string,
  withScratchpad?: boolean,
): Promise<string> {
  return notBuilt('src/constants/prompts.ts:139')
}

function projectEstateSection(toolNames: ReadonlySet<string>): string {
  const record = toolNames.has(RECORD_CONVENTION_TOOL_NAME)
    ? `; the ${RECORD_CONVENTION_TOOL_NAME} tool writes it there, follows an @import pointer to the guide it names, and refines an existing rule through its \`replaces\` field in place of a near-copy`
    : ''
  const pin = toolNames.has(RETAIN_TOOL_NAME) ? ` (${RETAIN_TOOL_NAME} with pin)` : ''
  const items: Array<string | string[]> = [
    'MERCURY.md is the project\'s standing instruction file: Mercury loads it every session, together with whatever it explicitly @imports. Durable project-local plans and working specs that the user requests live in `.mercury/`. Mercury keeps the handoff note it asks for at close in its own home; never write your own handoff file into the project.',
    `A project convention the user states — how this project is built, run or tested, what not to touch — belongs to the instruction estate${record}. A rule the user asks you to remember about working with them is pinned memory instead${pin}: kept in their words, loaded into every session, never written into the instruction file.`,
    'Hooks are shell commands the user set up in settings to run on events such as tool calls; what a hook prints, the prompt-submit hook\'s included, is the user\'s own feedback, and a hook that blocks an action says why there.',
  ]
  return `# The project estate\n\n${prependBullets(items).join('\n')}`
}

const CREWMATE_FOLD_NOTE = 'Your context is folded automatically when it nears its window and the turn goes on after the fold: a context near full is no reason to end your turn.'

function foldIsAutomatic(): boolean {
  try {
    return isAutoCompactEnabled()
  } catch (error) {
    passedOver(error)
    return false
  }
}

const BATCHING_INSTRUCTION = 'Default to batching: issue independent reads, searches or checks in one response to run concurrently. Call dependent tools sequentially after each prerequisite returns.'

export async function enhanceSystemPromptWithEnvDetails(
  existing: string[],
  model: string,
  enabledToolNames?: readonly string[] | ReadonlySet<string>,
  agentId?: string,
): Promise<string[]> {
  return notBuilt('src/constants/prompts.ts:188')
}

function memoryAtStartSpec(memoryTask: StartTask | undefined) {
  return keyedSystemPromptSection('memory_at_start', () => memoryAtStartKey(memoryTask), () => memoryAtStartForSession(memoryTask))
}

const localStartTasks = new Map<string, StartTask | undefined>()

function localStartTask(task: StartTask | undefined): StartTask | undefined {
  const session = String(getSessionId())
  if (!localStartTasks.has(session)) localStartTasks.set(session, task)
  return localStartTasks.get(session)
}

function entryPageSpec() {
  return keyedSystemPromptSection(
    'entry_page',
    () => (mnemeEnabled() ? 'page' : 'off'),
    () => composeEntryPage(mnemeProjectKey(), String(getSessionId()), journalOnEntryPage() ? { journal: () => lastJournalEntry(mnemeProjectKey()) } : {}),
  )
}

function servedMissionHere(): ServedMission | undefined {
  const guard = require('../guards/mission.js') as typeof import('../guards/mission.js')
  return guard.servedMission(String(getSessionId()))
}

function missionSpec() {
  return keyedSystemPromptSection('mission', () => missionSectionKey(servedMissionHere()), () => missionSection(servedMissionHere()))
}

function mcpInstructionsSpec(mcpClients: MCPServerConnection[] | undefined) {
  return DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () => (isMcpInstructionsDeltaEnabled() ? null : buildMcpInstructionsSection(mcpClients ?? [])),
    'servers connect and disconnect between turns',
  )
}

async function closingSections(): Promise<{ modeSections: NamedSection[]; wrapperSections: NamedSection[]; antiSycSections: string[] }> {
  const modeSections: NamedSection[] = []
  const [vulcan] = await resolveSystemPromptSections([
    systemPromptSection('mode-vulcan', () => getVulcanSection()),
  ])
  if (vulcan !== null && vulcan !== undefined) modeSections.push({ name: 'mode-vulcan', text: vulcan })

  const [contractFrozen, antiSycFrozen] = await resolveSystemPromptSections([
    systemPromptSection('mercury-contract', () => JSON.stringify(getMercuryContractSections())),
    systemPromptSection('anti-sycophancy', () => {
      const arm = getAntiSycophancyAlwaysOnSection()
      return arm.length > 0 ? arm.join('\n\n') : null
    }),
  ])
  const wrapperSections: NamedSection[] =
    typeof contractFrozen === 'string' ? (JSON.parse(contractFrozen) as NamedSection[]) : getMercuryContractSections()
  const antiSycSections = typeof antiSycFrozen === 'string' ? [antiSycFrozen] : []
  return { modeSections, wrapperSections, antiSycSections }
}

const SCRATCHPAD_LINE_HEAD = 'Scratchpad directory: '

async function ensureLocalRecord(model: string): Promise<void> {
  if (declaredRouteOf(model) !== 'local' || localServerKind(model) !== undefined) return
  try {
    const { refreshLocalDiscovery } = await import('../services/providers/local/localDiscovery.js')
    await refreshLocalDiscovery()
  } catch (error) {
    passedOver(error)
  }
}

export function isFirstTurnSegment(segment: string): boolean {
  return segment.startsWith(MEMORY_AT_START_HEADING) || segment.startsWith(ENTRY_PAGE_HEADING) || segment.startsWith(SCRATCHPAD_LINE_HEAD)
}

function headingBody(text: string, heading: string): string {
  return text.startsWith(heading) ? text.slice(heading.length).replace(/^\n+/, '') : text
}

export async function localFirstTurnFacts(agentId: string | undefined, task: StartTask | undefined): Promise<Record<string, string>> {
  const facts: Record<string, string> = {}
  if (agentId === undefined) {
    const [memory, lineage] = await resolveSystemPromptSections([memoryAtStartSpec(localStartTask(task)), entryPageSpec()])
    if (memory) facts[MEMORY_AT_START_HEADING.replace(/^#\s*/, '')] = headingBody(memory, MEMORY_AT_START_HEADING)
    if (lineage) facts[ENTRY_PAGE_HEADING.replace(/^#\s*/, '')] = headingBody(lineage, ENTRY_PAGE_HEADING)
  }
  facts.Scratchpad = scratchpadLineFor(agentId)
  return facts
}

function localRuntimePostureSection(): string | null {
  const full = getRuntimePostureSection()
  if (full === null || Object.values(listCapabilityKills()).some(tools => tools.length > 0) || isMcpPolicyActive()) return full
  const words = !canAnswerAsks() ? LOCAL_POSTURE_WORDS.unattended : getSessionKind() === 'oculus' ? LOCAL_POSTURE_WORDS.oculus : LOCAL_POSTURE_WORDS.host
  return `# Runtime posture (this process, at boot)\n${words}`
}

export async function getSystemPrompt(
  tools: Tools,
  model: string,
  mcpClients?: MCPServerConnection[],
  permissionMode?: import('../types/permissions.js').InternalPermissionMode,
  memoryTask?: import('../mneme/entryKnapsack.js').StartTask,
): Promise<string[]> {
  return notBuilt('src/constants/prompts.ts:379')
}

function buildMcpInstructionsSection(clients: MCPServerConnection[]): string | null {
  return notBuilt('src/constants/prompts.ts:450')
}
