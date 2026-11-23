import { z } from 'zod'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { agentToolRuleProblem } from './agentToolRules.js'
import { decodeAgentDocument, validateAgentIdentifier } from '../../crew/agents/codec.js'
import { revisionDigest } from '../../crew/agents/contracts.js'
import {
  loadAgentOverrides,
  type AgentOverrideProvenance,
} from '../../crew/agents/overrides.js'
import { logError } from '../../platform/logs/errorLog.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getCwd } from '../../platform/files/cwd.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import {
  EFFORT_LEVELS,
} from '../../models/effort/effort.js'
import {
  clearMarkdownFileCache,
  loadMarkdownFilesForSubdir,
} from '../../platform/settings/markdownConfigLoader.js'
import { PERMISSION_MODES } from '../../permissions/rules/permissionMode.js'
import { clearExtensionAgentCache, getExtensionAgents } from '../../integrations/extensions/load/agents.js'
import { readHooksMap } from '../../integrations/event-hook-schemas/hooks.js'
import type { HooksSettings } from '../../platform/settings/settingsSchema.js'
import { isMnemeEnabled } from '../../sessions/mneme/paths.js'
import { getBuiltInAgents } from './builtInAgents.js'
import { setAgentColor } from './crewmateColors.js'
import {
  loadAgentMemoryPrompt,
  withMemoryVerbs,
  type AgentMemoryScope,
} from '../../crew/agents/agentMemory.js'
import {
  isBuiltInAgent,
  type AgentDefinition,
  type AgentDefinitionsResult,
  type AgentMcpServerSpec,
  type AgentSource,
  type CustomAgentDefinition,
} from '../../crew/agents/agentDefinition.js'


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

function getActiveAgentsFromList(
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
  return getActiveAgentsFromList(allAgents).filter(agent => agent.disabled !== true)
}

function makeSystemPromptCallback(
  agentType: string,
  prompt: string,
  memory: AgentMemoryScope | undefined,
): () => string {
  return () => {
    if (memory !== undefined && isMnemeEnabled()) {
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
  const reading = readHooksMap(raw)
  for (const fault of reading.faults) logForDebugging(`agents: ${origin} hook ${fault}`)
  return Object.keys(reading.hooks).length > 0 ? reading.hooks : undefined
}


function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: Exclude<AgentSource, 'built-in' | 'extension'>,
  rawContent?: string,
  failures?: { path: string; error: string }[],
): CustomAgentDefinition | null {
  try {
    const raw = rawContent ?? rebuildRawDocument(frontmatter, content)
    const doc = decodeAgentDocument(raw, filePath)
    const errors = doc.diagnostics.filter(d => d.severity === 'error')
    for (const d of doc.diagnostics) {
      if (d.severity !== 'info') {
        logForDebugging(`agents: ${filePath} ${d.severity} [${d.code}] ${d.message}`)
      }
    }
    if (errors.length > 0) {
      if (failures) {
        for (const err of errors) {
          const prefix = err.line !== undefined ? `line ${err.line}: ` : ''
          failures.push({ path: filePath, error: `${prefix}[${err.code}] ${err.message}` })
        }
      }
      return null
    }
    const { fields } = doc
    if (!fields.name) return null
    const agentType = fields.name
    const whenToUse = fields.description || ''
    const promptBody = doc.body.trim()
    const tools = withMemoryVerbs(fields.tools, fields.memory)
    const mcpServers = validateMcpServers(fields.mcpServers, filePath)
    const hooks = validateHooks(frontmatter['hooks'], filePath)
    const standingRule = readStandingRule(frontmatter)

    return {
      agentType,
      whenToUse,
      source,
      filename: basenameWithoutMarkdownExtension(filePath),
      baseDir,
      filePath,
      revision: revisionDigest(raw),
      getSystemPrompt: makeSystemPromptCallback(agentType, promptBody, fields.memory),
      ...(tools !== undefined ? { tools } : {}),
      ...(fields.disallowedTools !== undefined ? { disallowedTools: fields.disallowedTools } : {}),
      ...(fields.skills !== undefined ? { skills: fields.skills } : {}),
      ...(fields.color !== undefined ? { color: fields.color } : {}),
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
      ...(fields.instructionProfile !== undefined ? { instructionProfile: fields.instructionProfile } : {}),
      ...(fields.permissionMode !== undefined ? { permissionMode: fields.permissionMode } : {}),
      ...(fields.maxTurns !== undefined ? { maxTurns: fields.maxTurns } : {}),
      ...(fields.background !== undefined ? { background: fields.background } : {}),
      ...(fields.initialPrompt !== undefined ? { initialPrompt: fields.initialPrompt } : {}),
      ...(fields.memory !== undefined ? { memory: fields.memory } : {}),
      ...(fields.isolation !== undefined ? { isolation: fields.isolation } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      ...(standingRule !== undefined ? { standingRule } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`agents: failed to parse ${filePath}: ${message}`)
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

const STANDING_RULE_KEY = 'standingRule'

function readStandingRule(record: Record<string, unknown>): string | undefined {
  const current = record[STANDING_RULE_KEY]
  if (typeof current === 'string' && current.trim()) return current
  return undefined
}


const toolRuleSchema = z.string().superRefine((spec, context) => {
  const problem = agentToolRuleProblem(spec)
  if (problem !== null) context.addIssue({ code: 'custom', message: problem })
})
const jsonAgentSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(toolRuleSchema).optional(),
  disallowedTools: z.array(toolRuleSchema).optional(),
  model: z
    .string()
    .transform(value => value.trim())
    .pipe(z.string().min(1))
    .transform(value => (value.toLowerCase() === 'inherit' ? 'inherit' : value))
    .optional(),
  effort: z.union([z.enum(EFFORT_LEVELS), z.number().int()]).optional(),
  instructionProfile: z.enum(['auto', 'native']).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  mcpServers: z.array(agentMcpServerSpecSchema).optional(),
  hooks: z.unknown().optional(),
  maxTurns: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  initialPrompt: z.string().optional(),
  standingRule: z.string().optional(),
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
  const data = parsed.data
  const tools = withMemoryVerbs(data.tools, data.memory)
  const mcpServers = validateMcpServers(data.mcpServers, `json:${name}`)
  const hooks = validateHooks(data.hooks, `json:${name}`)
  const standingRule = readStandingRule(data)

  return {
    agentType: name,
    whenToUse: data.description,
    source,
    getSystemPrompt: makeSystemPromptCallback(name, data.prompt, data.memory),
    ...(tools !== undefined ? { tools } : {}),
    ...(data.disallowedTools !== undefined ? { disallowedTools: data.disallowedTools } : {}),
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.effort !== undefined ? { effort: data.effort } : {}),
    ...(data.instructionProfile !== undefined ? { instructionProfile: data.instructionProfile } : {}),
    ...(data.permissionMode !== undefined ? { permissionMode: data.permissionMode } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(data.maxTurns !== undefined ? { maxTurns: data.maxTurns } : {}),
    ...(data.skills !== undefined && data.skills.length > 0 ? { skills: data.skills } : {}),
    ...(data.initialPrompt !== undefined ? { initialPrompt: data.initialPrompt } : {}),
    ...(standingRule !== undefined ? { standingRule } : {}),
    ...(data.memory !== undefined ? { memory: data.memory } : {}),
    ...(data.background !== undefined ? { background: data.background } : {}),
    ...(data.isolation !== undefined ? { isolation: data.isolation } : {}),
  }
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
    if (isEnvTruthy(flagEnv('MERCURY_BARE'))) {
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
