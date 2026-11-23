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
  const result: string[] = []
  for (const item of items) {
    if (Array.isArray(item)) {
      for (const sub of item) {
        result.push(`  - ${sub}`)
      }
    } else {
      result.push(` - ${item}`)
    }
  }
  return result
}

function scratchpadLineFor(agentId?: string): string {
  return scratchpadPromptLine(
    ensureScratchpadDir(agentId),
    agentId === undefined ? 'session' : 'crewmate',
  )
}

async function buildEnvBlock(
  modelId: string,
  agentId?: string,
  withScratchpad = true,
): Promise<string> {
  const shell = await shellLineWords()
  const osVer = platformKernelLine()
  const cutoff = getModelKnowledgeCutoff(modelId)
  const lines: string[] = [
    `Working directory: ${getCwd()}`,
    ...(withScratchpad ? [scratchpadLineFor(agentId)] : []),
    `Platform: ${platform()}`,
    `Shell: ${shell}`,
    `OS Version: ${osVer}`,
  ]
  const env = `The environment this session runs in:\n<env>\n${lines.join('\n')}\n</env>`
  return cutoff ? `${env}\n\nKnowledge cutoff for this model: ${cutoff}.` : env
}

export async function computeEnvInfo(
  modelId: string,
  agentId?: string,
): Promise<string> {
  const env = await buildEnvBlock(modelId, agentId, true)
  return `${env}\n\n${getModelCurrencySection()}`
}

export async function computeSimpleEnvInfo(
  modelId: string,
  withScratchpad = true,
): Promise<string> {
  const items: string[] = []
  if (getCurrentWorktreeSession()) {
    items.push(
      'This working directory is an isolated copy of the repository (a git worktree); every command runs here, never in the original repository root.',
    )
  }
  if (declaredRouteOf(modelId) === 'local') {
    items.push(
      `Files you create go in the working directory: ${getOriginalCwd()}. The memory folder named above is not it.`,
    )
  }
  if (withScratchpad) {
    items.push(scratchpadLineFor())
  }
  items.push(`Platform: ${platform()}`)
  items.push(`Shell: ${await shellLineWords()}`)
  items.push(`OS Version: ${platformKernelLine()}`)
  const cutoff = getModelKnowledgeCutoff(modelId)
  if (cutoff) {
    items.push(`Knowledge cutoff for this model: ${cutoff}.`)
  }
  return `# Environment\n${prependBullets(items).join('\n')}`
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
  void enabledToolNames
  const filtered = existing.filter(block => block !== '')
  if (localPromptProfileApplies(model)) {
    await ensureLocalRecord(model)
    const rewritten = filtered.map(block => {
      if (block === MERCURY_CONSTITUTION) return localLaw(model)
      if (block.startsWith('<subagent-doctrine>')) return LOCAL_SUBAGENT_DOCTRINE
      return block
    })
    const notesBlock = `Notes:\n${prependBullets([...LOCAL_CREWMATE_NOTES]).join('\n')}`
    const envBlock = await buildEnvBlock(model, agentId, false)
    return [...rewritten, notesBlock, envBlock, scratchpadLineFor(agentId)]
  }
  const notes: string[] = [
    BATCHING_INSTRUCTION,
    `In a crewmate thread the ${BASH_TOOL_NAME} tool's working directory does not survive between calls: pass absolute paths.`,
    ...(foldIsAutomatic() ? [CREWMATE_FOLD_NOTE] : []),
    'Name relevant files by absolute path in your final response; quote code only where exact characters matter (a located defect or requested signature), never to retell read code.',
    'Do not use emoji.',
    'End sentences before tool calls with a period, never a colon.',
  ]
  const notesBlock = `Notes:\n${prependBullets(notes).join('\n')}`
  const envInfo = await computeEnvInfo(model, agentId)
  return [...filtered, notesBlock, envInfo]
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

const SUMMARIZE_TOOL_RESULTS =
  'Write down important information from tool results in your response — the original tool result may be cleared from context later.'

function languageSpec() {
  return systemPromptSection('language', () => {
    const language = getInitialSettings().voice?.language
    if (!language) return null
    return `# Language\nAlways respond in ${language}. Use it for explanations, comments and communications; leave technical terms and code identifiers in their original form.`
  })
}

export async function getSystemPrompt(
  tools: Tools,
  model: string,
  mcpClients?: MCPServerConnection[],
  permissionMode?: import('../types/permissions.js').InternalPermissionMode,
  memoryTask?: import('../mneme/entryKnapsack.js').StartTask,
): Promise<string[]> {
  void permissionMode
  const toolNames = new Set(tools.map(tool => tool.name))
  if (toolNames.has(BASH_TOOL_NAME)) beginLoginFiles()

  const recorded = recordedComposition(model)
  if (recorded !== null) {
    noteSessionEngine(model)
    return recorded
  }

  const layers = promptLayerSet()
  const liveHead = `Working directory: ${getOriginalCwd()}`
  const bare = isEnvTruthy(flagEnv('MERCURY_BARE'))

  if (localPromptProfileApplies(model)) {
    if (layers === 'whole') return [liveHead, promptReplacementText()]
    await ensureLocalRecord(model)
    const [resolvedLocalLaw] = await resolveSystemPromptSections([
      keyedSystemPromptSection('local_law', () => model, () => localLaw(model)),
    ])
    const stockLaw = resolvedLocalLaw ?? localLaw(model)
    const selectedLaw = layers === 'replace' ? promptReplacementText() : stockLaw
    if (bare) return [`${liveHead}\n\n${selectedLaw}`]

    noteSessionEngine(model)
    const [frozenHead] = await resolveSystemPromptSections([
      keyedSystemPromptSection('head', () => model, () => liveHead),
    ])
    const dynamicSpecs = [
      systemPromptSection('local_posture', () => localRuntimePostureSection()),
      systemPromptSection('local_estate', () =>
        localEstateSection(
          toolNames.has(RECORD_CONVENTION_TOOL_NAME) ? RECORD_CONVENTION_TOOL_NAME : null,
          toolNames.has(RETAIN_TOOL_NAME) ? RETAIN_TOOL_NAME : null,
        ),
      ),
      systemPromptSection('memory', () => loadMemoryPrompt()),
      languageSpec(),
      systemPromptSection('summarize_tool_results', () => (isUnattendedRun() ? null : SUMMARIZE_TOOL_RESULTS)),
      keyedSystemPromptSection('local_env', () => model, () => computeSimpleEnvInfo(model, false)),
      mcpInstructionsSpec(mcpClients),
      memoryAtStartSpec(localStartTask(memoryTask)),
      entryPageSpec(),
      systemPromptSection('local_scratchpad', () => scratchpadLineFor()),
      missionSpec(),
    ]
    const [dynamicResolved, closing] = await Promise.all([
      resolveSystemPromptSections(dynamicSpecs),
      closingSections(),
    ])
    return composeSystemPrompt({
      staticSections: [frozenHead ?? liveHead, selectedLaw],
      dynamicBoundary: [],
      dynamicSpecs: dynamicSpecs.map(spec => ({ name: spec.name, cacheBreak: spec.cacheBreaking })),
      dynamicResolved,
      wrapperSections: closing.wrapperSections,
      modeSections: closing.modeSections,
      antiSycSections: closing.antiSycSections,
    })
  }

  const [resolvedConstitution] = await resolveSystemPromptSections([
    systemPromptSection('constitution', () =>
      isUnattendedRun() ? MERCURY_HEADLESS_CONSTITUTION : MERCURY_CONSTITUTION,
    ),
  ])
  const stockLaw = resolvedConstitution ?? MERCURY_CONSTITUTION
  recordCurrentStaticComposition(stockLaw)
  if (layers === 'whole') return [liveHead, promptReplacementText()]
  const selectedLaw = layers === 'replace' ? promptReplacementText() : stockLaw
  if (bare) return [`${liveHead}\n\n${selectedLaw}`]

  noteSessionEngine(model)
  const [frozenHead] = await resolveSystemPromptSections([
    keyedSystemPromptSection('head', () => model, () => liveHead),
  ])
  const dynamicSpecs = [
    systemPromptSection('project_estate', () => projectEstateSection(toolNames)),
    systemPromptSection('memory', () => loadMemoryPrompt()),
    memoryAtStartSpec(memoryTask),
    entryPageSpec(),
    keyedSystemPromptSection('env_info_simple', () => model, () => computeSimpleEnvInfo(model)),
    systemPromptSection('model_currency', () => getModelCurrencySection()),
    languageSpec(),
    mcpInstructionsSpec(mcpClients),
    keyedSystemPromptSection('frc', () => model, () => null),
    systemPromptSection('summarize_tool_results', () =>
      stockLaw === MERCURY_HEADLESS_CONSTITUTION ? null : SUMMARIZE_TOOL_RESULTS,
    ),
    systemPromptSection('runtime_posture', () => getRuntimePostureSection()),
    systemPromptSection('harness_map', () => getHarnessMapSection()),
    missionSpec(),
  ]
  const [dynamicResolved, closing] = await Promise.all([
    resolveSystemPromptSections(dynamicSpecs),
    closingSections(),
  ])
  return composeSystemPrompt({
    staticSections: [frozenHead ?? liveHead, selectedLaw],
    dynamicBoundary: [],
    dynamicSpecs: dynamicSpecs.map(spec => ({ name: spec.name, cacheBreak: spec.cacheBreaking })),
    dynamicResolved,
    wrapperSections: closing.wrapperSections,
    modeSections: closing.modeSections,
    antiSycSections: closing.antiSycSections,
  })
}

function buildMcpInstructionsSection(clients: MCPServerConnection[]): string | null {
  const blocks: string[] = []
  for (const client of clients) {
    const withInstructions: { instructions?: string } = client
    const instructions = withInstructions.instructions
    if (instructions !== undefined && instructions !== '') {
      blocks.push(`## ${client.name}\n${instructions}`)
    }
  }
  if (blocks.length === 0) return null
  return `# MCP server instructions\n\nEach server below says how its tools and resources are used:\n\n${blocks.join('\n\n')}`
}
