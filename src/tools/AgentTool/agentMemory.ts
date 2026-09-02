// Per-agent persistent memory directories and the memory prompt block
// Mercury layer: multi-home project path resolution — the
// membership predicate accepts every project config home (native, retired,
// compat) while writes resolve through the adoptive canonical home.

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
/** The entrypoint file inside each memory directory (contract data). */
const MEMORY_ENTRYPOINT = 'MEMORY.md'

/**
 * Path-safe agent-type name: extension namespacing puts colons in agent types,
 * and a colon cannot appear in a Windows path — every colon becomes a dash.
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replaceAll(':', '-')
}

/**
 * The memory directory for an agent type in a scope. All returned paths
 * carry a trailing separator.
 */
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

/** The MEMORY.md entrypoint inside the scope's directory. */
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

/**
 * Whether an absolute path lies inside agent memory. The path is normalised
 * first — traversal segments would otherwise bypass the test — and every
 * project config home counts (native, retired, and compat homes alike).
 */
export function isAgentMemoryPath(absolutePath: string): boolean {
  const path = normalize(absolutePath)
  // User scope: <memory base>/agent-memory/**
  if (isUnder(path, join(getMemoryBaseDir(), AGENT_MEMORY_SUBDIR))) {
    return true
  }
  const homes = projectConfigDirs(getCwd())
  // Project scope: any config home's agent-memory directory.
  for (const home of homes) {
    if (isUnder(path, join(home, AGENT_MEMORY_SUBDIR))) return true
  }
  // Local scope: any config home's local-memory directory.
  {
    for (const home of homes) {
      if (isUnder(path, join(home, AGENT_MEMORY_LOCAL_SUBDIR))) return true
    }
  }
  return false
}

/**
 * A human-readable scope description. Load-bearing per scope: the
 * user string carries the absolute base; the project string carries the
 * write path relative to the working directory (derived from the resolved
 * home, never a hard-coded home name); the local string describes the scope
 * with a placeholder for the agent-type segment.
 */
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

/**
 * The memory prompt block appended to a memory-enabled agent's system
 * prompt. Synchronous by contract — it runs inside a prompt callback called
 * from render. The directory is created fire-and-forget: the spawned agent
 * cannot write before an API round-trip completes, and the file write tool
 * creates parent directories anyway.
 */
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
