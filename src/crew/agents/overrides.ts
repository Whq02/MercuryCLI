import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublish } from '../../platform/substrate/durablePublish.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { EffortValue } from '../../models/effort/effort.js'
import { parseEffortValue } from '../../models/effort/effort.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { findGitRoot } from '../../platform/git/git.js'
import { projectLocalPath } from '../../platform/project-local/paths.js'

const AGENT_OVERRIDES_BASENAME = 'agent-overrides.json'

type AgentOverrideScope = 'user' | 'project'

type AgentOverridePatch = {
  model?: string
  effort?: EffortValue
}

export type AgentOverrideProvenance = AgentOverridePatch & {
  from: AgentOverrideScope
  intentModel?: string
  intentEffort?: EffortValue
}

type AgentOverridesFile = {
  version: 1
  disabled: string[]
  agents: Record<string, AgentOverridePatch>
}

const EMPTY: AgentOverridesFile = { version: 1, disabled: [], agents: {} }

export function userOverridesPath(): string {
  return join(getMercuryHome(), AGENT_OVERRIDES_BASENAME)
}

function projectOverridesPath(cwd: string): string {
  const root = findGitRoot(cwd) ?? cwd
  return projectLocalPath(root, AGENT_OVERRIDES_BASENAME)
}

function parseOverridesFile(raw: string, path: string, strict = false): AgentOverridesFile {
  try {
    const parsed = JSON.parse(raw) as Partial<AgentOverridesFile>
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) {
      if (strict) {
        throw new Error(`agent-overrides at ${path}: unrecognized shape`)
      }
      logForDebugging(`agent-overrides at ${path}: unrecognized shape, ignored`)
      return EMPTY
    }
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter((d): d is string => typeof d === 'string')
      : []
    const agents: Record<string, AgentOverridePatch> = {}
    for (const [name, patch] of Object.entries(parsed.agents ?? {})) {
      if (typeof patch !== 'object' || patch === null) continue
      const out: AgentOverridePatch = {}
      if (typeof patch.model === 'string' && patch.model.trim()) {
        out.model = patch.model.trim()
      }
      if (patch.effort !== undefined) {
        const effort = parseEffortValue(patch.effort)
        if (effort !== undefined) out.effort = effort
      }
      if (out.model !== undefined || out.effort !== undefined) {
        agents[name] = out
      }
    }
    return { version: 1, disabled, agents }
  } catch (e) {
    if (strict) {
      throw e instanceof Error
        ? e
        : new Error(`agent-overrides at ${path}: unreadable (${String(e)})`)
    }
    logForDebugging(
      `agent-overrides at ${path}: unreadable (${e instanceof Error ? e.message : String(e)}), ignored`,
    )
    return EMPTY
  }
}

function readOverridesFile(path: string, strict = false): AgentOverridesFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return EMPTY
    if (strict) throw e
    logForDebugging(
      `agent-overrides at ${path}: unreadable (${e instanceof Error ? e.message : String(e)}), ignored`,
    )
    return EMPTY
  }
  return parseOverridesFile(raw, path, strict)
}

type LoadedAgentOverrides = {
  user: AgentOverridesFile
  project: AgentOverridesFile
  disabledSet: Set<string>
  overrideFor(name: string): AgentOverrideProvenance | undefined
}

export function loadAgentOverrides(cwd: string): LoadedAgentOverrides {
  const user = readOverridesFile(userOverridesPath())
  const project = readOverridesFile(projectOverridesPath(cwd))
  const disabledSet = new Set([...user.disabled, ...project.disabled])
  return {
    user,
    project,
    disabledSet,
    overrideFor(name: string): AgentOverrideProvenance | undefined {
      const fromProject = project.agents[name]
      if (fromProject) return { ...fromProject, from: 'project' }
      const fromUser = user.agents[name]
      if (fromUser) return { ...fromUser, from: 'user' }
      return undefined
    },
  }
}

async function writeOverridesFile(
  path: string,
  file: AgentOverridesFile,
): Promise<void> {
  await durableAtomicPublish(path, JSON.stringify(file, null, 2) + '\n')
}

export async function setAgentDisabled(
  scope: AgentOverrideScope,
  cwd: string,
  agentType: string,
  disabled: boolean,
): Promise<AgentOverridesFile> {
  const path = scope === 'user' ? userOverridesPath() : projectOverridesPath(cwd)
  const current = readOverridesFile(path, true)
  const set = new Set(current.disabled)
  if (disabled) set.add(agentType)
  else set.delete(agentType)
  const next: AgentOverridesFile = { ...current, disabled: [...set].sort() }
  await writeOverridesFile(path, next)
  return next
}

export async function setAgentOverride(
  scope: AgentOverrideScope,
  cwd: string,
  agentType: string,
  patch: AgentOverridePatch | undefined,
): Promise<AgentOverridesFile> {
  const path = scope === 'user' ? userOverridesPath() : projectOverridesPath(cwd)
  const current = readOverridesFile(path, true)
  const agents = { ...current.agents }
  if (
    patch === undefined ||
    (patch.model === undefined && patch.effort === undefined)
  ) {
    delete agents[agentType]
  } else {
    agents[agentType] = {
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    }
  }
  const next: AgentOverridesFile = { ...current, agents }
  await writeOverridesFile(path, next)
  return next
}
