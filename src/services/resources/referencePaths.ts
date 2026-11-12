import * as path from 'node:path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { parseMercuryRef } from './contracts.js'

const GIT_PATH_FORMS = new Set(['at', 'tree', 'file', 'conflict'])

export function fileReferenceCandidates(id: string, cwd: string): string[] {
  return path.isAbsolute(id) ? [id] : [...new Set([path.resolve(cwd, id), path.resolve(getOriginalCwd(), id)])]
}

export function recordIdNamesNoPath(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..')
}

function decoded(id: string): string {
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

async function gitReferencePaths(id: string, cwd: string): Promise<string[]> {
  const slash = id.indexOf('/')
  const form = slash === -1 ? id : id.slice(0, slash)
  const rest = slash === -1 ? '' : id.slice(slash + 1)
  if (rest === '' || !GIT_PATH_FORMS.has(form)) return []
  const { git, splitRefPath } = await import('../gitGraph/observe.js')
  const named = form === 'at' || form === 'tree' ? splitRefPath(cwd, rest, { allowEmptyPath: form === 'tree' })?.path : rest
  if (named === undefined || named === '') return []
  let top = cwd
  try {
    top = git(cwd, ['rev-parse', '--show-toplevel']).trim() || cwd
  } catch {
  }
  return [...new Set([path.resolve(top, named), path.resolve(cwd, named)])]
}

export async function referenceReadPaths(raw: string, cwd: string): Promise<string[]> {
  const paths = new Set<string>()
  for (const text of new Set([raw, raw.trim()])) {
    const parsed = parseMercuryRef(text)
    if (parsed === null || parsed.id === '') continue
    if (parsed.kind === 'file') {
      const ids = [parsed.id, decoded(parsed.id)]
      for (const id of ids) for (const candidate of fileReferenceCandidates(id, cwd)) paths.add(candidate)
      for (const id of ids) paths.add(id)
    } else if (parsed.kind === 'git') {
      for (const named of await gitReferencePaths(parsed.id, cwd)) paths.add(named)
    }
  }
  return [...paths]
}

export async function referenceReadDecision(
  toolName: string,
  raw: string,
  input: unknown,
  permission: ToolPermissionContext,
  cwd: string,
): Promise<ReturnType<typeof checkReadPermissionForTool> | null> {
  const verdicts = (await referenceReadPaths(raw, cwd)).map(named => checkReadPermissionForTool({ name: toolName, getPath: () => named }, input, permission))
  return verdicts.find(verdict => verdict.behavior === 'deny') ?? verdicts.find(verdict => verdict.behavior === 'ask') ?? verdicts[0] ?? null
}
