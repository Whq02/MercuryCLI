
import { normalize, join, relative, sep } from 'node:path'
import { buildMemoryPrompt, ensureMemoryDirExists } from '../../memdir/memdir.js'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { getCwd } from '../../utils/cwd.js'
import {
  PROJECT_CONFIG_DIR_NAMES,
  projectConfigDirs,
} from '../../utils/projectConfig.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'

export type AgentMemoryScope = 'user' | 'project' | 'local'

const AGENT_MEMORY_SUBDIR = 'agent-memory'
const AGENT_MEMORY_LOCAL_SUBDIR = 'agent-memory-local'
const MEMORY_ENTRYPOINT = 'MEMORY.md'

function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replaceAll(':', '-')
}

export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'user':
      return join(getMemoryBaseDir(), AGENT_MEMORY_SUBDIR, dirName) + sep
    case 'project':
      return (
        adoptiveProjectPath(getCwd(), AGENT_MEMORY_SUBDIR, dirName) + sep
      )
    case 'local':
      return (
        adoptiveProjectPath(getCwd(), AGENT_MEMORY_LOCAL_SUBDIR, dirName) +
        sep
      )
  }
}

export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), MEMORY_ENTRYPOINT)
}

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
  {
    for (const home of homes) {
      if (isUnder(path, join(home, AGENT_MEMORY_LOCAL_SUBDIR))) return true
    }
  }
  return false
}

export function getMemoryScopeDisplay(
  scope: AgentMemoryScope | undefined,
): string {
  switch (scope) {
    case 'user':
      return `user (${join(getMemoryBaseDir(), AGENT_MEMORY_SUBDIR)})`
    case 'project': {
      const dir = adoptiveProjectPath(getCwd(), AGENT_MEMORY_SUBDIR)
      return `project (${relative(getCwd(), dir)})`
    }
    case 'local': {
      const dir = adoptiveProjectPath(getCwd(), AGENT_MEMORY_LOCAL_SUBDIR)
      return `local (${join(dir, '<agent-type>')})`
    }
    default:
      return 'none'
  }
}

const SCOPE_GUIDELINES: Record<AgentMemoryScope, string> = {
  user: 'This memory applies across all projects. Keep learnings general rather than project-specific.',
  project:
    'This memory is shared with your team through version control. Tailor it to this project.',
  local:
    'This memory is not version-controlled. Tailor it to this project and this machine.',
}

export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const dir = getAgentMemoryDir(agentType, scope)
  void ensureMemoryDirExists(dir)
  const extraGuidelines = [SCOPE_GUIDELINES[scope]]
  return buildMemoryPrompt({
    displayName: 'persistent agent memory',
    memoryDir: dir,
    extraGuidelines,
  })
}
