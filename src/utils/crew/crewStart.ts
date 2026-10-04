import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { createAgentWorktree, preflightWorktreeCapability } from '../worktree.js'

export type CrewStartRequestV1 = {
  name: string
  cwd: string
  worktree?: { at?: string }
  model: string
}

export type CrewStartWorktreeV1 = {
  path: string
  branch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}

export type CrewStartPlanV1 = {
  name: string
  cwd: string
  worktree: CrewStartWorktreeV1 | null
  runDir: string
  model: string
}

export type CrewStartRecordV1 = {
  name: string
  cwd: string
  worktree: string | null
  model: string
}

export const CREW_START_MODEL_REFUSAL = "a crewmate's model is the operator's word: name one — nothing is picked by default"

export function crewStartName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '') throw new Error('a crewmate needs a name — the address SendMessage and the crew view use')
  if (trimmed.includes('@') || trimmed === '*') {
    throw new Error(`a crewmate's name must be addressable by SendMessage: "${trimmed}" cannot contain "@" or be "*"`)
  }
  return trimmed
}

export function crewStartFolder(cwd: string): string {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('a crewmate needs a working folder — an absolute directory that exists')
  if (!isAbsolute(cwd)) throw new Error(`a crewmate's working folder must be an absolute directory: ${cwd}`)
  let entry: ReturnType<typeof statSync> | null
  try {
    entry = statSync(cwd)
  } catch {
    entry = null
  }
  if (entry === null) throw new Error(`a crewmate's working folder does not exist: ${cwd}`)
  if (!entry.isDirectory()) throw new Error(`a crewmate's working folder is not a folder: ${cwd}`)
  return realpathSync(cwd)
}

export function crewStartModel(model: string | undefined): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (trimmed === '') throw new Error(CREW_START_MODEL_REFUSAL)
  return trimmed
}

export function crewWorktreeSlug(id: string): string {
  return `agent-${id.slice(0, 8)}`
}

export async function resolveCrewStart(
  request: CrewStartRequestV1,
  options?: { slug?: string },
): Promise<CrewStartPlanV1> {
  const name = crewStartName(request.name)
  const model = crewStartModel(request.model)
  const cwd = crewStartFolder(request.cwd)
  if (request.worktree === undefined) {
    return { name, cwd, worktree: null, runDir: cwd, model }
  }
  const capability = preflightWorktreeCapability(cwd)
  if (!capability.available) {
    throw new Error(`a worktree for crewmate "${name}" cannot be cut: ${capability.detail}`)
  }
  const slug = options?.slug ?? crewWorktreeSlug(name.replace(/[^A-Za-z0-9._-]/g, '-'))
  const cut = await createAgentWorktree(slug, {
    from: cwd,
    ...(request.worktree.at !== undefined ? { at: request.worktree.at } : {}),
  })
  const worktree: CrewStartWorktreeV1 = {
    path: cut.worktreePath,
    ...(cut.worktreeBranch !== undefined ? { branch: cut.worktreeBranch } : {}),
    ...(cut.headCommit !== undefined ? { headCommit: cut.headCommit } : {}),
    ...(cut.gitRoot !== undefined ? { gitRoot: cut.gitRoot } : {}),
    ...(cut.hookBased !== undefined ? { hookBased: cut.hookBased } : {}),
  }
  return { name, cwd, worktree, runDir: worktree.path, model }
}

const crewStarts = new Map<string, CrewStartRecordV1>()

export function recordCrewStart(id: string, record: CrewStartRecordV1): void {
  crewStarts.set(id, record)
}

export function crewStartOf(id: string): CrewStartRecordV1 | null {
  return crewStarts.get(id) ?? null
}
