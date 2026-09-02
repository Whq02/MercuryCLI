// ============================================================================
//  operator overrides — enable/disable + per-agent model/effort
//  overrides WITHOUT touching the definition file.
//
//  Why a side store: definitions may be read-only for the operator (built-ins,
//  extensions, managed scope, a teammate's checked-in project agent), yet the
//  operator still owns which agents are OFFERED and on what model/effort tier
//  they run locally. Two scopes:
//    user     <configHome>/agent-overrides.json           (all projects)
//    project  <project stickyProjectPath>/agent-overrides.json  (this repo;
//             the ONE path seam names the home)
//  Project beats user per agent (nearer intent wins, same as definitions).
//
//  APPLICATION POINT: getAgentDefinitionsWithOverrides applies these onto the
//  loaded definitions (model/effort replaced with provenance recorded,
//  disabled definitions dropped from activeAgents but kept in allAgents), so
//  EVERY consumer — Agent tool schema, spawn dispatch, display, CLI — sees
//  one truth. Never a display-only layer.
//
//  SAFETY: built-in agents cannot be disabled (system flows — verification,
//  general-purpose — depend on them); they CAN carry model/effort overrides.
//  Writes ride durableAtomicPublish; a damaged store reads as empty and is
//  reported via diagnostics, never silently rewritten.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import type { EffortValue } from '../../utils/effort.js'
import { parseEffortValue } from '../../utils/effort.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { findGitRoot } from '../../utils/git.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'

export const AGENT_OVERRIDES_BASENAME = 'agent-overrides.json'

export type AgentOverrideScope = 'user' | 'project'

export type AgentOverridePatch = {
  model?: string
  effort?: EffortValue
}

export type AgentOverrideProvenance = AgentOverridePatch & {
  from: AgentOverrideScope
  /** The definition's own declared model, before the override replaced it. */
  intentModel?: string
  /** The definition's own declared effort, before the override replaced it. */
  intentEffort?: EffortValue
}

export type AgentOverridesFile = {
  version: 1
  disabled: string[]
  agents: Record<string, AgentOverridePatch>
}

const EMPTY: AgentOverridesFile = { version: 1, disabled: [], agents: {} }

export function userOverridesPath(): string {
  return join(getMercuryHome(), AGENT_OVERRIDES_BASENAME)
}

export function projectOverridesPath(cwd: string): string {
  const root = findGitRoot(cwd) ?? cwd
  return adoptiveProjectPath(root, AGENT_OVERRIDES_BASENAME)
}

function parseOverridesFile(raw: string, path: string): AgentOverridesFile {
  try {
    const parsed = JSON.parse(raw) as Partial<AgentOverridesFile>
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) {
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
    logForDebugging(
      `agent-overrides at ${path}: unreadable (${e instanceof Error ? e.message : String(e)}), ignored`,
    )
    return EMPTY
  }
}

function readOverridesFile(path: string): AgentOverridesFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return EMPTY
  }
  return parseOverridesFile(raw, path)
}

export type LoadedAgentOverrides = {
  user: AgentOverridesFile
  project: AgentOverridesFile
  /** Merged per-agent view: project beats user per agent and per disable. */
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

/** Set/clear the disabled state for an agent in one scope. Returns the new
 *  file content. The caller invalidates the definitions cache + AppState. */
export async function setAgentDisabled(
  scope: AgentOverrideScope,
  cwd: string,
  agentType: string,
  disabled: boolean,
): Promise<AgentOverridesFile> {
  const path = scope === 'user' ? userOverridesPath() : projectOverridesPath(cwd)
  const current = readOverridesFile(path)
  const set = new Set(current.disabled)
  if (disabled) set.add(agentType)
  else set.delete(agentType)
  const next: AgentOverridesFile = { ...current, disabled: [...set].sort() }
  await writeOverridesFile(path, next)
  return next
}

/** Set (patch defined keys) or clear (undefined patch) an agent's override in
 *  one scope. */
export async function setAgentOverride(
  scope: AgentOverrideScope,
  cwd: string,
  agentType: string,
  patch: AgentOverridePatch | undefined,
): Promise<AgentOverridesFile> {
  const path = scope === 'user' ? userOverridesPath() : projectOverridesPath(cwd)
  const current = readOverridesFile(path)
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
