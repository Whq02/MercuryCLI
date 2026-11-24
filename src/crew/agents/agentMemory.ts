import { normalize, join, relative, sep } from 'node:path'
import { getMemoryBaseDir, isMnemeEnabled } from '../../sessions/mneme/paths.js'
import { getCwd } from '../../platform/files/cwd.js'
import { projectConfigDirs } from '../../platform/settings/projectConfig.js'
import { projectHomePath } from '../../platform/storage/projectHomeStores.js'
import { CORRECT_TOOL_NAME, RECALL_TOOL_NAME, REFLECT_TOOL_NAME, RETAIN_TOOL_NAME } from '../../tools/kit/names/memory.js'

export type AgentMemoryScope = 'user' | 'project' | 'local'

const MEMORY_GRANT_TOOL_NAMES: readonly string[] = [RETAIN_TOOL_NAME, RECALL_TOOL_NAME, REFLECT_TOOL_NAME, CORRECT_TOOL_NAME]

export function withMemoryVerbs(tools: string[] | undefined, memory: AgentMemoryScope | undefined): string[] | undefined {
  if (!memory || !isMnemeEnabled() || tools === undefined) return tools
  const merged = [...tools]
  for (const name of MEMORY_GRANT_TOOL_NAMES) {
    if (!merged.includes(name)) merged.push(name)
  }
  return merged
}

const AGENT_MEMORY_SUBDIR = 'agent-memory'
const AGENT_MEMORY_LOCAL_SUBDIR = 'agent-memory-local'

function isUnder(candidate: string, dir: string): boolean {
  const rel = relative(dir, candidate)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`)
}

export function isAgentMemoryPath(absolutePath: string): boolean {
  const path = normalize(absolutePath)
  if (isUnder(path, join(getMemoryBaseDir(), AGENT_MEMORY_SUBDIR))) {
    return true
  }
  const homes = projectConfigDirs(getCwd())
  for (const home of homes) {
    if (isUnder(path, join(home, AGENT_MEMORY_SUBDIR))) return true
  }
  if (isUnder(path, projectHomePath(getCwd(), AGENT_MEMORY_LOCAL_SUBDIR))) return true
  for (const home of homes) {
    if (isUnder(path, join(home, AGENT_MEMORY_LOCAL_SUBDIR))) return true
  }
  return false
}

const SCOPE_GUIDELINES: Record<AgentMemoryScope, string> = {
  user: 'Keep what you save general rather than project-specific.',
  project: 'Tailor what you save to this project.',
  local: 'Tailor what you save to this project and this machine.',
}

export function loadAgentMemoryPrompt(
  _agentType: string,
  scope: AgentMemoryScope,
): string {
  return [
    '# Memory',
    "You share this project's memory. Retain saves a durable fact for future sessions; Recall searches what is remembered or reads a page; Correct fixes a wrong fact and keeps the old one as history.",
    SCOPE_GUIDELINES[scope],
  ].join('\n')
}
