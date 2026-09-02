// Agent-definition types, discovery/parsing from markdown and JSON,
// precedence winner selection, and MCP-requirement filtering.
//
// Mercury layers: first-wins precedence over descending source groups,
// operator overrides (patch + disable), instruction-profile field, disabled
// agents removed by the ONE recompute entry point.

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

// ── Types ──────────────────────────────────────────────────────────────

/** A declared agent-scoped MCP server: a configured-server name reference,
 *  or an inline single-key record of name → server configuration. */
export type AgentMcpServerSpec = string | Record<string, McpServerConfig>

/** Where a definition came from (display order derives real precedence). */
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
  /** The delegation cue, written for the CALLING model. */
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
  /** Re-injected at every user turn when declared (verification). */
  criticalSystemReminder_EXPERIMENTAL?: string
  /** Server-name patterns that must expose tools before dispatch. */
  requiredMcpServers?: string[]
  background?: boolean
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: 'worktree' | 'remote'
  /** Stamped by the (unwired) load-time snapshot pass — never by parsers. */
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  /** Slim agent: drop the repository-instruction blob from user context. */
  omitProjectInstructions?: boolean
  /** The agent returns a fixed contract rather than free prose. */
  fixedOutputContract?: boolean
  /** Operator override provenance (per-type model/effort patch). */
  operatorOverride?: AgentOverrideProvenance
  /** Operator-disabled: removed from the active list (built-ins exempt). */
  disabled?: boolean
}

export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: string
  /** Fires on clean completion of a run (termination). */
  callback?: () => void | Promise<void>
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
}

export type CustomAgentDefinition = BaseAgentDefinition & {
  source: Exclude<AgentSource, 'built-in' | 'extension'>
  getSystemPrompt: () => string
  /** Absolute path the definition was discovered at (file-backed only). */
  filePath?: string
  /** Content revision digest of the discovered bytes (conflict anchor). */
  revision?: string
}

/** An agent an approved extension contributes: runs under the session's mode, always. */
export type ExtensionAgentDefinition = BaseAgentDefinition & {
  source: 'extension'
  /** The owning extension's name (the namespace of the agent type). */
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
  /** Omitted entirely when empty. */
  failedFiles?: { path: string; error: string }[]
  /** Part of the shape; never populated by the loader (a later merge sets it). */
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

// ── Precedence ─────────────────────────────────────────────────────

/** Highest authority first: the winner for a type is the first candidate
 *  found while walking these groups. */
const PRECEDENCE_DESCENDING: readonly AgentSource[] = [
  'policySettings',
  'flagSettings',
  'projectSettings',
  'userSettings',
  'extension',
  'built-in',
]

/** Legacy ascending order — the byte order prompt/schema surfaces see. */
const EMISSION_ASCENDING: readonly AgentSource[] = [
  'built-in',
  'extension',
  'userSettings',
  'projectSettings',
  'flagSettings',
  'policySettings',
]

/**
 * The precedence winner pass: walk source groups from highest authority to
 * lowest (inside a group discovery already put the most specific candidate
 * first), then emit winners in the legacy ascending order, de-duplicated by
 * type, each in the position of the first ascending occurrence of its type.
 */
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

/**
 * The ONE recompute entry point: precedence winners minus anything an
 * operator disabled. Every rebuild seam (boot, watch reload, UI refresh)
 * must come through here — the bare winner pass resurrects disabled agents.
 */
export function computeActiveAgents(
  allAgents: readonly AgentDefinition[],
): AgentDefinition[] {
  return getActiveAgentsFromList(allAgents).filter(a => a.disabled !== true)
}

// ── Required MCP servers ───────────────────────────────────────────

/** True when there are no requirements, else every declared pattern must
 *  case-insensitively substring-match at least one available server name. */
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

// ── Runtime shaping shared by both parsers ─────────────────────────────────

const MEMORY_TOOL_NAMES = [
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
]

/**
 * Memory tool injection: a memory-enabled agent with an EXPLICIT
 * tools list must still reach its memory files, so the file write/edit/read
 * tools are appended when missing. Wildcard/undefined lists already include
 * them.
 */
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

/** The system-prompt closure: authored body, plus the memory prompt
 *  block for a memory-enabled definition when auto-memory is on. */
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

/** Per-item MCP validation: one bad entry is dropped and logged while the
 * rest survive. */
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

/** Whole-block hooks validation: an invalid hooks block yields NO hooks at
 * all, read from the raw frontmatter record rather than the codec's
 *  typed fields. */
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

// ── Markdown parsing ───────────────────────────────────────────────

/**
 * Parse one discovered markdown agent file through the lossless document
 * codec. Returns null when the document has no name, when the file is not
 * an agent, or when anything throws (logged).
 */
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
    // The writer refuses to SAVE a document carrying error-severity
    // diagnostics (store.saveAgentDocument throws); the loader holds the
    // same law — refuse the definition into the caller's rows instead of
    // activating the file on defaults.
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

    // MCP entries: per-item validation against the runtime schema.
    const mcpServers = validateMcpServers(fields.mcpServers, filePath)
    if (mcpServers) definition.mcpServers = mcpServers

    // Hooks: validated as a whole from the RAW frontmatter record — a hooks
    // value the codec would not surface still reaches validation.
    const hooks = validateHooks(frontmatter['hooks'], filePath)
    if (hooks) definition.hooks = hooks

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

/** Rebuild a raw document when the loader supplied only parsed pieces. */
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

// ── JSON parsing ───────────────────────────────────────────────────

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
  memory: z.enum(['user', 'project', 'local']).optional(),
  background: z.boolean().optional(),
  isolation: z.literal('worktree').optional(),
})

/**
 * Parse one JSON agent definition (CLI-flag / settings lane). Only fields
 * actually present are copied; empty mcpServers/skills arrays are dropped.
 */
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
  if (memory !== undefined) result.memory = memory
  if (fields.background !== undefined) result.background = fields.background
  if (fields.isolation !== undefined) result.isolation = fields.isolation
  return result
}

/**
 * The batch form validates the WHOLE record in one parse — a single
 * malformed entry rejects the entire batch (logged, empty list returned),
 * not just the bad entry.
 */
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

// ── The loader ─────────────────────────────────────────────────────

type FailedFileRow = { path: string; error: string }

const AGENTS_SUBDIR = 'agents'

/**
 * PRESENT BUT UNWIRED (a deliberate
 * keep): the load-time memory-snapshot pass. For user-scope
 * memory definitions it would either initialize local memory from the
 * project snapshot (recording the sync timestamp) or attach a
 * pending-snapshot-update marker and log. Nothing calls it in the snapshot;
 * wiring it live would ADD behaviour — kept as shape pending the operator
 * ruling.
 */
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

/** The extension agents: read from the active set (a synchronous read; wrapped so a throw never loses the others). */
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
    // Simple mode: built-ins only.
    if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
      const builtIns = getBuiltInAgents()
      return { activeAgents: builtIns, allAgents: builtIns }
    }

    const extensionAgents = loadExtensionAgentsSafe()

    const failedFiles: FailedFileRow[] = []
    const customAgents: AgentDefinition[] = []
    const markdownFiles = await loadMarkdownFilesForSubdir(AGENTS_SUBDIR, cwd)
    for (const file of markdownFiles) {
      const frontmatter: Record<string, unknown> = file.frontmatter ?? {}
      // A present-but-unparseable block fails CLOSED: the file is refused
      // with the parse error, never read as an empty object or mistaken
      // for a reference document (the diagnosis was already made one
      // layer down — it lands in the row instead of a debug log).
      if (file.parseError) {
        failedFiles.push({
          path: file.filePath,
          error: `frontmatter did not parse: ${file.parseError.message}`,
        })
        continue
      }
      const rawName = frontmatter['name']
      // Files with no `name` are co-located reference documents — skipped
      // silently, no failed-file row. A PRESENT name of the wrong type is
      // an authored agent with a defect, not a reference document.
      if (rawName === undefined || rawName === null || rawName === '') {
        // Deliberate skip (reference documents live beside agents) — but
        // named in the debug log (FC-069: the skip was fully silent while
        // doctor counted the file, and the mismatch had no lead at all).
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
      // The writer's identifier law runs at the loading door too: a name
      // is a filesystem path segment downstream (agent memory) and a line
      // on the inventory, so traversal words, whitespace and control
      // characters never activate. The row never echoes the hostile name.
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

    // Operator overrides: a per-type patch may set model/effort; a per-type
    // disable applies to everything except built-ins. The patched
    // definition CARRIES the override values (one truth for spawn and
    // display) plus provenance including the pre-override intent.
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

/** Definitions memo, keyed on the working directory. */
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

/**
 * Clear the definitions memo, the extension-agent cache, AND the markdown
 * file-scan memo beneath it — clearing only the outer memo hands the
 * "fresh" load the same file list it had before.
 */
export function clearAgentDefinitionsCache(): void {
  definitionsCache.clear()
  clearExtensionAgentCache()
  clearMarkdownFileCache()
}
