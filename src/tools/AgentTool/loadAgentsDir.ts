import { z } from 'zod'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { agentToolRuleProblem } from './agentToolRules.js'
import { decodeAgentDocument, validateAgentIdentifier } from '../../services/agents/codec.js'
import { revisionDigest } from '../../services/agents/contracts.js'
import {
  loadAgentOverrides,
  type AgentOverrideProvenance,
} from '../../services/agents/overrides.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  EFFORT_LEVELS,
  type EffortLevel,
} from '../../utils/effort.js'
import {
  clearMarkdownFileCache,
  loadMarkdownFilesForSubdir,
} from '../../utils/markdownConfigLoader.js'
import { PERMISSION_MODES, type PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { clearExtensionAgentCache, getExtensionAgents } from '../../extensions/load/agents.js'
import { readHooksMap } from '../../schemas/hooks.js'
import type { HooksSettings } from '../../utils/settings/types.js'
import { isMnemeEnabled } from '../../mneme/paths.js'
import { getBuiltInAgents } from './builtInAgents.js'
import { setAgentColor } from './agentColorManager.js'
import {
  loadAgentMemoryPrompt,
  withMemoryVerbs,
  type AgentMemoryScope,
} from '../../utils/agentMemory.js'
import {
  isBuiltInAgent,
  type AgentDefinition,
  type AgentDefinitionsResult,
  type AgentMcpServerSpec,
  type AgentSource,
  type CustomAgentDefinition,
} from '../../types/agent.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


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
  return notBuilt('src/tools/AgentTool/loadAgentsDir.ts:87')
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
  return notBuilt('src/tools/AgentTool/loadAgentsDir.ts:143')
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
const jsonAgentSchema: Unbuilt = unbuilt('src/tools/AgentTool/loadAgentsDir.ts:262')

export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source?: Exclude<AgentSource, 'built-in' | 'extension'>,
): CustomAgentDefinition | null {
  return notBuilt('src/tools/AgentTool/loadAgentsDir.ts:294')
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
