import { platform, release, type as osType, version as osVersion } from 'node:os'
import { canAnswerAsks, getOriginalCwd, getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
import { composeSystemPrompt } from '../prompt/composer.js'
import { recordedComposition, recordCurrentStaticComposition } from '../prompt/recordedComposition.js'
import type { NamedSection } from '../prompt/mercuryContract.js'
import {
  MERCURY_CONSTITUTION,
  getMercuryContractSections,
  promptLayerSet,
  promptReplacementText,
} from '../prompt/mercuryContract.js'
import { getAntiSycophancyAlwaysOnSection } from '../utils/antiSycophancy.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isMcpInstructionsDeltaEnabled } from '../utils/mcpInstructionsDelta.js'
import { getVulcanSection } from '../utils/vulcan/vulcanGates.js'
import { getModelKnowledgeCutoff } from '../utils/model/capabilities.js'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getCurrentWorktreeSession } from '../utils/worktree.js'
import { ensureScratchpadDir, scratchpadPromptLine } from '../utils/scratchpad.js'
import { loadMemoryPrompt } from '../mneme/mnemeFrontPage.js'
import { composeEntryPage } from '../mneme/entryPage.js'
import { composeMemoryAtStart } from '../mneme/entryKnapsack.js'
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
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { RECORD_CONVENTION_TOOL_NAME } from '../tools/RecordConventionTool/prompt.js'
import { RETAIN_TOOL_NAME } from '../tools/MemoryTools/prompt.js'
import { getRuntimePostureSection } from '../utils/cockpit/runtimePosture.js'
import { getHarnessMapSection } from '../utils/cockpit/harnessMap.js'
import type { Tools } from '../Tool.js'
import type { MCPServerConnection } from '../services/mcp/types.js'

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
  const out: string[] = []
  for (const item of items) {
    if (typeof item === 'string') out.push(` - ${item}`)
    else for (const nested of item) out.push(`  - ${nested}`)
  }
  return out
}

function shellLine(): string {
  const shellRaw = process.env.SHELL ?? 'unknown'
  const shell = shellRaw.includes('zsh') ? 'zsh' : shellRaw.includes('bash') ? 'bash' : shellRaw
  if (process.platform === 'win32') {
    return `Shell: ${shell} — use Unix shell syntax, not Windows (for example /dev/null rather than NUL, and forward slashes in paths)`
  }
  return `Shell: ${shell}`
}

function getUnameSR(): string {
  if (process.platform === 'win32') return `${osVersion()} ${release()}`
  return `${osType()} ${release()}`
}

function knowledgeCutoffSentence(modelId: string): string | null {
  const cutoff = getModelKnowledgeCutoff(modelId)
  if (!cutoff) return null
  return `Knowledge cutoff for this model: ${cutoff}.`
}

export async function computeEnvInfo(
  modelId: string,
  agentId?: string,
): Promise<string> {
  const cwd = getCwd()
  const scratchpad =
    agentId === undefined
      ? scratchpadPromptLine(ensureScratchpadDir())
      : scratchpadPromptLine(ensureScratchpadDir(agentId), 'crewmate')
  const cutoff = knowledgeCutoffSentence(modelId)
  const currency = `\n\n${MODEL_CURRENCY_NOTE} ${PROVIDER_SKILL_PRECEDENCE}`
  return `The environment this session runs in:
<env>
Working directory: ${cwd}
${scratchpad}
Platform: ${platform()}
${shellLine()}
OS Version: ${getUnameSR()}
</env>${cutoff ? `\n\n${cutoff}` : ''}${currency}`
}

export async function computeSimpleEnvInfo(
  modelId: string,
): Promise<string> {
  const cwd = getOriginalCwd()
  const items: Array<string | string[]> = []
  if (getCurrentWorktreeSession() !== null) {
    items.push(
      'This working directory is an isolated copy of the repository (a git worktree); every command runs here, never in the original repository root.',
    )
  }
  if (declaredRouteOf(modelId) === 'local') {
    items.push(`Files you create go in the working directory: ${cwd}. The memory folder named above is not it.`)
  }
  items.push(scratchpadPromptLine(ensureScratchpadDir()))
  items.push(`Platform: ${platform()}`)
  items.push(shellLine())
  items.push(`OS Version: ${getUnameSR()}`)
  const cutoff = knowledgeCutoffSentence(modelId)
  if (cutoff) items.push(cutoff)
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

const BATCHING_INSTRUCTION = 'Default to batching: when the next step needs several independent reads, searches or checks, issue them in one response so they can run concurrently. Call dependent tools sequentially; wait for each prerequisite before starting the next call.'

export async function enhanceSystemPromptWithEnvDetails(
  existing: string[],
  model: string,
  enabledToolNames?: readonly string[] | ReadonlySet<string>,
  agentId?: string,
): Promise<string[]> {
  void enabledToolNames
  const notes = [
    'Notes:',
    ...prependBullets([
      BATCHING_INSTRUCTION,
      `In a crewmate thread the ${BASH_TOOL_NAME} tool's working directory does not survive between calls: pass absolute paths.`,
      'In your final response, name the file paths that matter, always absolute. Quote code only where the literal characters carry the point — a defect you located, a signature the caller asked to see — never as a retelling of code you simply read.',
      'Do not use emoji.',
      'Do not write a colon before a tool call: "Let me read the file:" followed by a read becomes "Let me read the file." with a period.',
    ]),
  ].join('\n')
  const envBlock = await computeEnvInfo(model, agentId)
  return [...existing.filter(block => block !== ''), notes, envBlock]
}

const SUMMARIZE_TOOL_RESULTS_LINE =
  'Write down important information from tool results in your response — the original tool result may be cleared from context later.'

export async function getSystemPrompt(
  tools: Tools,
  model: string,
  mcpClients?: MCPServerConnection[],
  permissionMode?: import('../types/permissions.js').InternalPermissionMode,
  memoryTask?: import('../mneme/entryKnapsack.js').StartTask,
): Promise<string[]> {
  const recorded = recordedComposition(model)
  if (recorded !== null) {
    noteSessionEngine(model)
    return recorded
  }
  recordCurrentStaticComposition()
  const layers = promptLayerSet()
  const head = `Working directory: ${getOriginalCwd()}`
  if (layers === 'whole') return [head, promptReplacementText()]
  const law = layers === 'replace' ? promptReplacementText() : MERCURY_CONSTITUTION
  if (isEnvTruthy(process.env.MERCURY_BARE)) return [`${head}\n\n${law}`]

  const toolNames: ReadonlySet<string> = new Set((tools as ReadonlyArray<{ name: string }>).map(tool => tool.name))
  noteSessionEngine(model)

  const [frozenHead] = await resolveSystemPromptSections([
    keyedSystemPromptSection('head', () => model, () => head),
  ])
  const staticSections: Array<string | null> = [frozenHead ?? head, law]

  const dynamicSpecs = [
    systemPromptSection('project_estate', () => projectEstateSection(toolNames)),
    systemPromptSection('memory', () => loadMemoryPrompt()),
    keyedSystemPromptSection('memory_at_start', () => memoryAtStartKey(memoryTask), () => memoryAtStartForSession(memoryTask)),
    keyedSystemPromptSection(
      'entry_page',
      () => (mnemeEnabled() ? 'page' : 'off'),
      () => composeEntryPage(mnemeProjectKey(), String(getSessionId()), journalOnEntryPage() ? { journal: () => lastJournalEntry(mnemeProjectKey()) } : {}),
    ),
    keyedSystemPromptSection(
      'env_info_simple',
      () => model,
      () => computeSimpleEnvInfo(model),
    ),
    systemPromptSection('model_currency', () => getModelCurrencySection()),
    systemPromptSection('language', () => {
      const language = getInitialSettings().voice?.language
      if (!language) return null
      return `# Language\nAlways respond in ${language}. Use it for explanations, comments and communications; leave technical terms and code identifiers in their original form.`
    }),
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () => (isMcpInstructionsDeltaEnabled() ? null : buildMcpInstructionsSection(mcpClients ?? [])),
      'servers connect and disconnect between turns',
    ),
    keyedSystemPromptSection('frc', () => model, () => null),
    systemPromptSection('summarize_tool_results', () => SUMMARIZE_TOOL_RESULTS_LINE),
    systemPromptSection('runtime_posture', () => getRuntimePostureSection()),
    systemPromptSection('harness_map', () => getHarnessMapSection()),
  ]
  const dynamicResolved = await resolveSystemPromptSections(dynamicSpecs)

  const modeSections: Array<{ name: string; text: string }> = []
  void permissionMode
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

  return composeSystemPrompt({
    staticSections,
    dynamicBoundary: [],
    dynamicSpecs: dynamicSpecs.map(spec => ({
      name: spec.name,
      cacheBreak: spec.cacheBreaking,
    })),
    dynamicResolved,
    wrapperSections,
    modeSections,
    antiSycSections,
  })
}

function buildMcpInstructionsSection(clients: MCPServerConnection[]): string | null {
  const withInstructions = clients.filter(
    client =>
      (client as { instructions?: string }).instructions !== undefined &&
      (client as { instructions?: string }).instructions !== '',
  )
  if (withInstructions.length === 0) return null
  const blocks = withInstructions.map(
    client =>
      `## ${(client as { name: string }).name}\n${(client as { instructions?: string }).instructions}`,
  )
  return `# MCP server instructions\n\nEach server below says how its tools and resources are used:\n\n${blocks.join('\n\n')}`
}
