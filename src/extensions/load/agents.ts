import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import { loadAgentMemoryPrompt, type AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import type { AgentDefinition, ExtensionAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { logForDebugging } from '../../utils/debug.js'
import { EFFORT_LEVELS, parseEffortValue } from '../../utils/effort.js'
import { coerceDescriptionToString, parsePositiveIntFromFrontmatter } from '../../utils/frontmatterParser.js'
import { agentToolsFrontmatterProblem, parseAgentToolsFromFrontmatter, parseSlashCommandToolsFromFrontmatter } from '../../utils/markdownConfigLoader.js'
import { activeFor, type ActiveExtension } from '../active.js'
import { substituteOptionsInContent, substituteRootAndData } from '../options.js'
import type { ResolvedAgent } from './contributions.js'

const MEMORY_SCOPES: readonly AgentMemoryScope[] = ['user', 'project', 'local']

function buildAgent(ext: ActiveExtension, agent: ResolvedAgent): ExtensionAgentDefinition {
  const frontmatter = agent.frontmatter
  const owner = ext.manifest.name
  const agentType = agent.agentType
  const whenToUse =
    coerceDescriptionToString(frontmatter.description, agentType, owner) ??
    coerceDescriptionToString(frontmatter['when-to-use']) ??
    `An agent provided by the ${owner} extension`
  for (const field of ['tools', 'disallowedTools'] as const) {
    const problem = agentToolsFrontmatterProblem(frontmatter[field])
    if (problem) logForDebugging(`extension agent ${agentType}: ${field} unreadable (${problem}) — restricted to no tools`)
  }
  const tools = parseAgentToolsFromFrontmatter(frontmatter['tools'])
  const skills = frontmatter.skills !== undefined && frontmatter.skills !== null ? parseSlashCommandToolsFromFrontmatter(frontmatter.skills) : undefined
  const disallowedTools =
    frontmatter['disallowedTools'] !== undefined && frontmatter['disallowedTools'] !== null ? parseAgentToolsFromFrontmatter(frontmatter['disallowedTools']) : undefined

  let model: string | undefined
  const rawModel = frontmatter.model
  if (typeof rawModel === 'string' && rawModel.trim() !== '') {
    const trimmed = rawModel.trim()
    model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
  }
  const rawBackground = frontmatter['background']
  const background = rawBackground === true || rawBackground === 'true' ? true : undefined
  let memory: AgentMemoryScope | undefined
  const rawMemory = frontmatter['memory']
  if (rawMemory !== undefined && rawMemory !== null) {
    if (MEMORY_SCOPES.includes(rawMemory as AgentMemoryScope)) memory = rawMemory as AgentMemoryScope
    else logForDebugging(`extension agent ${agentType}: memory must be one of ${MEMORY_SCOPES.join(', ')} — dropped`)
  }
  const isolation = frontmatter['isolation'] === 'worktree' ? ('worktree' as const) : undefined
  let effort
  const rawEffort = frontmatter.effort
  if (rawEffort !== undefined && rawEffort !== null) {
    effort = parseEffortValue(rawEffort)
    if (effort === undefined) logForDebugging(`extension agent ${agentType}: effort must be one of ${EFFORT_LEVELS.join(', ')} or an integer — dropped`)
  }
  let maxTurns: number | undefined
  const rawMaxTurns = frontmatter['maxTurns']
  if (rawMaxTurns !== undefined && rawMaxTurns !== null) {
    maxTurns = parsePositiveIntFromFrontmatter(rawMaxTurns)
    if (maxTurns === undefined) logForDebugging(`extension agent ${agentType}: maxTurns must be a positive integer — dropped`)
  }
  let effectiveTools = tools
  if (isAutoMemoryEnabled() && memory !== undefined && effectiveTools) {
    for (const toolName of [FILE_WRITE_TOOL_NAME, FILE_EDIT_TOOL_NAME, FILE_READ_TOOL_NAME]) {
      if (!effectiveTools.includes(toolName)) effectiveTools = [...effectiveTools, toolName]
    }
  }
  const promptBase = substituteOptionsInContent(substituteRootAndData(agent.body.trim(), ext.root, ext.entry.id), ext.options, ext.manifest.needs?.options)
  const memoryScope = memory
  return {
    agentType,
    whenToUse,
    source: 'extension',
    extensionName: owner,
    filename: agent.file.split('/').pop()?.replace(/\.md$/, '') ?? agentType,
    ...(effectiveTools ? { tools: effectiveTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(coerceDescriptionToString(frontmatter['color']) ? { color: coerceDescriptionToString(frontmatter['color']) as AgentColorName } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(memoryScope !== undefined ? { memory: memoryScope } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    getSystemPrompt: () => {
      if (isAutoMemoryEnabled() && memoryScope !== undefined) return `${promptBase}\n\n${loadAgentMemoryPrompt(agentType, memoryScope)}`
      return promptBase
    },
  }
}

let memo: AgentDefinition[] | null = null

export function getExtensionAgents(): AgentDefinition[] {
  if (memo) return memo
  const out: AgentDefinition[] = []
  for (const ext of activeFor('agents')) {
    for (const agent of ext.resolution.agents) {
      try {
        out.push(buildAgent(ext, agent))
      } catch (error) {
        logForDebugging(`extension agent ${agent.agentType} failed to build: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  memo = out
  return out
}

export function clearExtensionAgentCache(): void {
  memo = null
}
