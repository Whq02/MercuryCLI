
import { z } from 'zod'
import { decodeAgentDocument, validateAgentIdentifier } from '../../services/agents/codec.js'
import { revisionDigest } from '../../services/agents/contracts.js'
import {
  loadAgentOverrides,
  type AgentOverrideProvenance,
} from '../../services/agents/overrides.js'
import type { InstructionProfile } from '../../services/instructions/contracts.js'
import type { McpServerConfig } from '../../services/mcp/types.js'
import type { ToolUseContext } from '../../Tool.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type EffortValue,
} from '../../utils/effort.js'
import {
  clearMarkdownFileCache,
  loadMarkdownFilesForSubdir,
} from '../../utils/markdownConfigLoader.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { clearExtensionAgentCache, getExtensionAgents } from '../../extensions/load/agents.js'
import { HooksSchema } from '../../utils/settings/types.js'
import type { HooksSettings } from '../../utils/settings/types.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { getBuiltInAgents } from './builtInAgents.js'
import { setAgentColor, type AgentColorName } from './agentColorManager.js'
import {
  checkAgentMemorySnapshot,
  initializeFromSnapshot,
} from './agentMemorySnapshot.js'
import {
  loadAgentMemoryPrompt,
  type AgentMemoryScope,
} from './agentMemory.js'


export type AgentMcpServerSpec = string | Record<string, McpServerConfig>

export type AgentSource =
  | 'built-in'
  | 'extension'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'flagSettings'

export type BaseAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  mcpServers?: AgentMcpServerSpec[]
  hooks?: HooksSettings
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  instructionProfile?: InstructionProfile
  permissionMode?: PermissionMode
  maxTurns?: number
  filename?: string
  baseDir?: string
  standingRule?: string
  requiredMcpServers?: string[]
  background?: boolean
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: 'worktree' | 'remote'
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  omitProjectInstructions?: boolean
  fixedOutputContract?: boolean
  operatorOverride?: AgentOverrideProvenance
  disabled?: boolean
}

export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: string
  callback?: () => void | Promise<void>
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
}

export type CustomAgentDefinition = BaseAgentDefinition & {
  source: Exclude<AgentSource, 'built-in' | 'extension'>
  getSystemPrompt: () => string
  filePath?: string
  revision?: string
}

export type ExtensionAgentDefinition = BaseAgentDefinition & {
  source: 'extension'
  extensionName?: string
  getSystemPrompt: () => string
}

export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | ExtensionAgentDefinition

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  failedFiles?: { path: string; error: string }[]
  allowedAgentTypes?: string[]
}

export function isBuiltInAgent(
  def: AgentDefinition,
): def is BuiltInAgentDefinition {
  return def.source === 'built-in'
}

export function isExtensionAgent(
  def: AgentDefinition,
): def is ExtensionAgentDefinition {
  return def.source === 'extension'
}

export function isCustomAgent(
  def: AgentDefinition,
): def is CustomAgentDefinition {
  return !isBuiltInAgent(def) && !isExtensionAgent(def)
}


const PRECEDENCE_DESCENDING: readonly AgentSource[] = [
  'policySettings',
  'flagSettings',
  'projectSettings',
  'userSettings',
  'extension',
  'built-in',
]

const EMISSION_ASCENDING: readonly AgentSource[] = [
  'built-in',
  'extension',
  'userSettings',
  'projectSettings',
  'flagSettings',
  'policySettings',
]

export function getActiveAgentsFromList(
  allAgents: readonly AgentDefinition[],
): AgentDefinition[] {
  const winners = new Map<string, AgentDefinition>()
  for (const source of PRECEDENCE_DESCENDING) {
    for (const agent of allAgents) {
      if (agent.source !== source) continue
      if (!winners.has(agent.agentType)) winners.set(agent.agentType, agent)
    }
  }
  const emitted = new Set<string>()
  const active: AgentDefinition[] = []
  for (const source of EMISSION_ASCENDING) {
    for (const agent of allAgents) {
      if (agent.source !== source) continue
      if (emitted.has(agent.agentType)) continue
      emitted.add(agent.agentType)
      const winner = winners.get(agent.agentType)
      if (winner) active.push(winner)
    }
  }
  return active
}

export function computeActiveAgents(
  allAgents: readonly AgentDefinition[],
): AgentDefinition[] {
  return getActiveAgentsFromList(allAgents).filter(a => a.disabled !== true)
}


export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: readonly string[],
): boolean {
  const required = agent.requiredMcpServers
  if (!required || required.length === 0) return true
  const lowered = availableServers.map(name => name.toLowerCase())
  return required.every(pattern => {
    const needle = pattern.toLowerCase()
    return lowered.some(name => name.includes(needle))
  })
}

export function filterAgentsByMcpRequirements(
  agents: readonly AgentDefinition[],
  availableServers: readonly string[],
): AgentDefinition[] {
  return agents.filter(agent => hasRequiredMcpServers(agent, availableServers))
}


const MEMORY_TOOL_NAMES = [
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
]

function withMemoryTools(
  tools: string[] | undefined,
  memory: AgentMemoryScope | undefined,
): string[] | undefined {
  if (!memory || !isAutoMemoryEnabled() || tools === undefined) return tools
  const merged = [...tools]
  for (const name of MEMORY_TOOL_NAMES) {
    if (!merged.includes(name)) merged.push(name)
  }
  return merged
}

function makeSystemPromptClosure(
  agentType: string,
  prompt: string,
  memory: AgentMemoryScope | undefined,
): () => string {
  return () => {
    if (memory && isAutoMemoryEnabled()) {
      return `${prompt}\n\n${loadAgentMemoryPrompt(agentType, memory)}`
    }
    return prompt
  }
}

const agentMcpServerSpecSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
])

function validateMcpServers(
  raw: unknown,
  origin: string,
): AgentMcpServerSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    logForDebugging(`agents: ${origin} mcpServers is not a list — dropped`)
    return undefined
  }
  const valid: AgentMcpServerSpec[] = []
  for (const entry of raw) {
    const parsed = agentMcpServerSpecSchema.safeParse(entry)
    if (parsed.success) {
      valid.push(parsed.data as AgentMcpServerSpec)
    } else {
      logForDebugging(
        `agents: ${origin} dropped an invalid mcpServers entry: ${parsed.error.message}`,
      )
    }
  }
  return valid.length > 0 ? valid : undefined
}

function validateHooks(raw: unknown, origin: string): HooksSettings | undefined {
  if (raw === undefined || raw === null) return undefined
  const parsed = HooksSchema().safeParse(raw)
  if (!parsed.success) {
    logForDebugging(
      `agents: ${origin} hooks block failed validation — no hooks registered: ${parsed.error.message}`,
    )
    return undefined
  }
  return parsed.data as HooksSettings
}


export function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: Exclude<AgentSource, 'built-in' | 'extension'>,
  rawContent?: string,
  failures?: { path: string; error: string }[],
): CustomAgentDefinition | null {
  try {
    const raw =
      rawContent ?? rebuildRawDocument(frontmatter, content)
    const document = decodeAgentDocument(raw, filePath)
    for (const diagnostic of document.diagnostics) {
      if (diagnostic.severity === 'info') continue
      logForDebugging(
        `agents: ${filePath} ${diagnostic.severity} [${diagnostic.code}] ${diagnostic.message}`,
      )
    }
    const errorDiagnostics = document.diagnostics.filter(d => d.severity === 'error')
    if (errorDiagnostics.length > 0) {
      if (failures) {
        for (const diagnostic of errorDiagnostics) {
          failures.push({ path: filePath, error: `[${diagnostic.code}] ${diagnostic.message}` })
        }
      }
      return null
    }
    const fields = document.fields
    if (!fields.name) return null

    const filename = basenameWithoutMarkdownExtension(filePath)
    const prompt = document.body.trim()
    const memory = fields.memory
    const tools = withMemoryTools(fields.tools, memory)

    const definition: CustomAgentDefinition = {
      agentType: fields.name,
      whenToUse: fields.description ?? '',
      source,
      filename,
      baseDir,
      filePath,
      revision: revisionDigest(raw),
      getSystemPrompt: makeSystemPromptClosure(fields.name, prompt, memory),
      ...(tools !== undefined ? { tools } : {}),
      ...(fields.disallowedTools !== undefined
        ? { disallowedTools: fields.disallowedTools }
        : {}),
      ...(fields.skills !== undefined ? { skills: fields.skills } : {}),
      ...(fields.color !== undefined ? { color: fields.color } : {}),
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
      ...(fields.instructionProfile !== undefined
        ? { instructionProfile: fields.instructionProfile }
        : {}),
      ...(fields.permissionMode !== undefined
        ? { permissionMode: fields.permissionMode }
        : {}),
      ...(fields.maxTurns !== undefined ? { maxTurns: fields.maxTurns } : {}),
      ...(fields.background !== undefined
        ? { background: fields.background }
        : {}),
      ...(fields.initialPrompt !== undefined
        ? { initialPrompt: fields.initialPrompt }
        : {}),
      ...(memory !== undefined ? { memory } : {}),
      ...(fields.isolation !== undefined
        ? { isolation: fields.isolation }
        : {}),
    }

    const mcpServers = validateMcpServers(fields.mcpServers, filePath)
    if (mcpServers) definition.mcpServers = mcpServers

    const hooks = validateHooks(frontmatter['hooks'], filePath)
    if (hooks) definition.hooks = hooks

    const standingRule = readStandingRule(frontmatter)
    if (standingRule !== undefined) definition.standingRule = standingRule

    return definition
  } catch (error) {
    logForDebugging(
      `agents: failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

function basenameWithoutMarkdownExtension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.md$/i, '')
}

function rebuildRawDocument(
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) =>
      `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )
  return `---\n${lines.join('\n')}\n---\n${content}`
}

export const STANDING_RULE_KEY = 'standingRule'
export const STANDING_RULE_RETIRED_KEY = 'criticalSystemReminder_EXPERIMENTAL'

export function readStandingRule(record: Record<string, unknown>): string | undefined {
  const current = record[STANDING_RULE_KEY]
  if (typeof current === 'string' && current.trim()) return current
  const retired = record[STANDING_RULE_RETIRED_KEY]
  if (typeof retired === 'string' && retired.trim()) return retired
  return undefined
}


const jsonAgentSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z
    .string()
    .trim()
    .min(1)
    .transform(value =>
      value.toLowerCase() === 'inherit' ? 'inherit' : value,
    )
    .optional(),
  effort: z
    .union([
      z.enum(EFFORT_LEVELS as readonly EffortLevel[] as [EffortLevel, ...EffortLevel[]]),
      z.number().int(),
    ])
    .optional(),
  instructionProfile: z.enum(['auto', 'native']).optional(),
  permissionMode: z.string().optional(),
  mcpServers: z.array(agentMcpServerSpecSchema).optional(),
  hooks: z.unknown().optional(),
  maxTurns: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  initialPrompt: z.string().optional(),
  standingRule: z.string().optional(),
  criticalSystemReminder_EXPERIMENTAL: z.string().optional(),
  memory: z.enum(['user', 'project', 'local']).optional(),
  background: z.boolean().optional(),
  isolation: z.literal('worktree').optional(),
})

export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: Exclude<AgentSource, 'built-in' | 'extension'> = 'flagSettings',
): CustomAgentDefinition | null {
  const parsed = jsonAgentSchema.safeParse(definition)
  if (!parsed.success) {
    logForDebugging(
      `agents: JSON definition '${name}' failed validation: ${parsed.error.message}`,
    )
    return null
  }
  const fields = parsed.data
  const memory = fields.memory as AgentMemoryScope | undefined
  const tools = withMemoryTools(fields.tools, memory)
  const result: CustomAgentDefinition = {
    agentType: name,
    whenToUse: fields.description,
    source,
    getSystemPrompt: makeSystemPromptClosure(name, fields.prompt, memory),
  }
  if (tools !== undefined) result.tools = tools
  if (fields.disallowedTools !== undefined)
    result.disallowedTools = fields.disallowedTools
  if (fields.model !== undefined) result.model = fields.model
  if (fields.effort !== undefined) result.effort = fields.effort
  if (fields.instructionProfile !== undefined)
    result.instructionProfile = fields.instructionProfile
  if (fields.permissionMode !== undefined)
    result.permissionMode = fields.permissionMode as PermissionMode
  if (fields.mcpServers !== undefined && fields.mcpServers.length > 0)
    result.mcpServers = fields.mcpServers as AgentMcpServerSpec[]
  if (fields.hooks !== undefined) {
    const hooks = validateHooks(fields.hooks, `json:${name}`)
    if (hooks) result.hooks = hooks
  }
  if (fields.maxTurns !== undefined) result.maxTurns = fields.maxTurns
  if (fields.skills !== undefined && fields.skills.length > 0)
    result.skills = fields.skills
  if (fields.initialPrompt !== undefined)
    result.initialPrompt = fields.initialPrompt
  const standingRule = readStandingRule(fields)
  if (standingRule !== undefined) result.standingRule = standingRule
  if (memory !== undefined) result.memory = memory
  if (fields.background !== undefined) result.background = fields.background
  if (fields.isolation !== undefined) result.isolation = fields.isolation
  return result
}

export function parseAgentsFromJson(
  agentsJson: unknown,
  source: Exclude<AgentSource, 'built-in' | 'extension'> = 'flagSettings',
): AgentDefinition[] {
  const batch = z.record(z.string(), jsonAgentSchema).safeParse(agentsJson)
  if (!batch.success) {
    logForDebugging(
      `agents: JSON agent batch failed validation — no agents loaded: ${batch.error.message}`,
    )
    return []
  }
  const agents: AgentDefinition[] = []
  for (const [name, definition] of Object.entries(batch.data)) {
    const parsed = parseAgentFromJson(name, definition, source)
    if (parsed) agents.push(parsed)
  }
  return agents
}


type FailedFileRow = { path: string; error: string }

const AGENTS_SUBDIR = 'agents'

export async function applyLoadTimeMemorySnapshots(
  definitions: readonly AgentDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    if (definition.memory !== 'user') continue
    const check = await checkAgentMemorySnapshot(
      definition.agentType,
      definition.memory,
    )
    if (check.action === 'initialize' && check.snapshotTimestamp) {
      await initializeFromSnapshot(
        definition.agentType,
        definition.memory,
        check.snapshotTimestamp,
      )
    } else if (check.action === 'prompt-update' && check.snapshotTimestamp) {
      ;(definition as BaseAgentDefinition).pendingSnapshotUpdate = {
        snapshotTimestamp: check.snapshotTimestamp,
      }
      logForDebugging(
        `agents: ${definition.agentType} has a newer memory snapshot (${check.snapshotTimestamp})`,
      )
    }
  }
}

function loadExtensionAgentsSafe(): AgentDefinition[] {
  try {
    return getExtensionAgents()
  } catch (error) {
    logForDebugging(
      `agents: extension agent load failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

async function loadAgentDefinitionsUncached(
  cwd: string,
): Promise<AgentDefinitionsResult> {
  try {
    if (isEnvTruthy(process.env.MERCURY_BARE)) {
      const builtIns = getBuiltInAgents()
      return { activeAgents: builtIns, allAgents: builtIns }
    }

    const extensionAgents = loadExtensionAgentsSafe()

    const failedFiles: FailedFileRow[] = []
    const customAgents: AgentDefinition[] = []
    const markdownFiles = await loadMarkdownFilesForSubdir(AGENTS_SUBDIR, cwd)
    for (const file of markdownFiles) {
      const frontmatter: Record<string, unknown> = file.frontmatter ?? {}
      if (file.parseError) {
        failedFiles.push({
          path: file.filePath,
          error: `frontmatter did not parse: ${file.parseError.message}`,
        })
        continue
      }
      const rawName = frontmatter['name']
      if (rawName === undefined || rawName === null || rawName === '') {
        logForDebugging(`agents: ${file.filePath} has no frontmatter name — treated as a co-located reference document, not a definition`)
        continue
      }
      if (typeof rawName !== 'string') {
        failedFiles.push({
          path: file.filePath,
          error: `name must be a string (got ${typeof rawName})`,
        })
        continue
      }
      const identifierError = validateAgentIdentifier(rawName)
      if (identifierError !== null) {
        failedFiles.push({
          path: file.filePath,
          error: `name is not a legal agent identifier: ${identifierError}`,
        })
        continue
      }
      const rawDescription = frontmatter['description']
      if (rawDescription === undefined || rawDescription === null || rawDescription === '') {
        failedFiles.push({
          path: file.filePath,
          error: 'missing description in frontmatter',
        })
        continue
      }
      if (typeof rawDescription !== 'string') {
        failedFiles.push({
          path: file.filePath,
          error: `description must be a string (got ${typeof rawDescription})`,
        })
        continue
      }
      const rowsBefore = failedFiles.length
      const parsed = parseAgentFromMarkdown(
        file.filePath,
        file.baseDir,
        frontmatter,
        file.content,
        file.source,
        file.rawContent,
        failedFiles,
      )
      if (parsed) {
        customAgents.push(parsed)
      } else if (failedFiles.length === rowsBefore) {
        failedFiles.push({
          path: file.filePath,
          error: 'unknown error parsing agent file',
        })
      }
    }

    const allAgents: AgentDefinition[] = [
      ...getBuiltInAgents(),
      ...extensionAgents,
      ...customAgents,
    ]

    const overrides = loadAgentOverrides(cwd)
    const withOverrides = allAgents.map(agent => {
      const patch = overrides.overrideFor(agent.agentType)
      const disabled =
        overrides.disabledSet.has(agent.agentType) && !isBuiltInAgent(agent)
      if (!patch && !disabled) return agent
      const patched: AgentDefinition = { ...agent }
      if (patch) {
        const provenance: AgentOverrideProvenance = {
          ...patch,
          intentModel: agent.model,
          intentEffort: agent.effort,
        }
        if (patch.model !== undefined) patched.model = patch.model
        if (patch.effort !== undefined) patched.effort = patch.effort
        patched.operatorOverride = provenance
      }
      if (disabled) patched.disabled = true
      return patched
    })

    const activeAgents = computeActiveAgents(withOverrides)
    for (const agent of activeAgents) {
      if (agent.color) setAgentColor(agent.agentType, agent.color)
    }

    return {
      activeAgents,
      allAgents: withOverrides,
      ...(failedFiles.length > 0 ? { failedFiles } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`agents: definition load failed: ${message}`)
    logError(error)
    const builtIns = getBuiltInAgents()
    return {
      activeAgents: builtIns,
      allAgents: builtIns,
      failedFiles: [{ path: 'unknown', error: message }],
    }
  }
}

const definitionsCache = new Map<string, Promise<AgentDefinitionsResult>>()

export function getAgentDefinitionsWithOverrides(
  cwd: string = getCwd(),
): Promise<AgentDefinitionsResult> {
  let cached = definitionsCache.get(cwd)
  if (!cached) {
    cached = loadAgentDefinitionsUncached(cwd)
    definitionsCache.set(cwd, cached)
  }
  return cached
}

export function clearAgentDefinitionsCache(): void {
  definitionsCache.clear()
  clearExtensionAgentCache()
  clearMarkdownFileCache()
}
