import type { ToolPermissionContext } from '../../Tool.js'
import { isAbsolute, resolve as resolvePath, sep as platformSep } from 'node:path'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { getPlatform } from '../platform.js'
import { SandboxManager } from '../sandbox/sandbox-adapter.js'
import { containsVulnerableUncPath } from '../shell/readOnlyCommandValidation.js'
import type { PermissionDecisionReason } from '../../types/permissions.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  checkPathSafetyForAutoEdit,
  getResolvedWorkingDirPaths,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from './filesystem.js'

export type FileOperationType = 'read' | 'write' | 'create'

export type PathCheckResult = { allowed: boolean; decisionReason?: PermissionDecisionReason }
export type ResolvedPathCheckResult = PathCheckResult & { resolvedPath: string }

const GLOB_METACHARS = /[*?[\]{}]/

export function formatDirectoryList(directories: string[]): string {
  const quoted = directories.map(dir => `'${dir}'`)
  if (quoted.length <= 5) return quoted.join(', ')
  return `${quoted.slice(0, 5).join(', ')} and ${quoted.length - 5} more`
}

export function getGlobBaseDirectory(path: string): string {
  if (!GLOB_METACHARS.test(path)) return path
  const firstMeta = path.search(GLOB_METACHARS)
  const prefix = path.slice(0, firstMeta)
  const seps = getPlatform() === 'windows' ? /[/\\]/g : /\//g
  let lastSep = -1
  let match: RegExpExecArray | null
  while ((match = seps.exec(prefix)) !== null) lastSep = match.index
  if (lastSep === -1) return '.'
  const base = prefix.slice(0, lastSep)
  return base === '' ? '/' : base
}

export function expandTilde(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  if (getPlatform() === 'windows' && path.startsWith('~\\')) return home + path.slice(1)
  return path
}

export function isPathInSandboxWriteAllowlist(resolvedPath: string): boolean {
  if (!SandboxManager.isSandboxingEnabled()) return false
  const config = SandboxManager.getFsWriteConfig()
  if (!config) return false
  const allowEntries = (config.allowOnly ?? []).flatMap(getResolvedWorkingDirPaths)
  const denyEntries = (config.denyWithinAllow ?? []).flatMap(getResolvedWorkingDirPaths)
  const resolvedForms = getResolvedWorkingDirPaths(resolvedPath)
  return resolvedForms.every(
    form =>
      !denyEntries.some(deny => isUnder(form, deny)) &&
      allowEntries.some(allow => isUnder(form, allow)),
  )
}

function isUnder(path: string, base: string): boolean {
  if (path === base) return true
  const baseWithSep = base.endsWith('/') || base.endsWith(platformSep) ? base : base + platformSep
  return path.startsWith(baseWithSep) || path.startsWith(base + '/')
}

export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const permType = operationType === 'read' ? 'read' : 'edit'
  const resolutionSet = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(resolvedPath)

  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, permType, 'deny')
    if (rule) return { allowed: false, decisionReason: { type: 'rule', rule } }
  }
  if (operationType !== 'read') {
    const internal = checkEditableInternalPath(resolvedPath, undefined)
    if ((internal as { behavior: string }).behavior === 'allow') return { allowed: true }
    const safety = checkPathSafetyForAutoEdit(resolvedPath, resolutionSet)
    if (!safety.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safety.message,
          classifierApprovable: safety.classifierApprovable,
        },
      }
    }
  }
  const inside = pathInAllowedWorkingPath(resolvedPath, context, resolutionSet)
  if (inside) {
    if (operationType === 'read') return { allowed: true }
    if (context.mode === 'implement') return { allowed: true }
  }
  if (operationType === 'read') {
    const internal = checkReadableInternalPath(resolvedPath, undefined)
    if ((internal as { behavior: string }).behavior === 'allow') return { allowed: true }
  }
  if (operationType !== 'read' && !inside && isPathInSandboxWriteAllowlist(resolvedPath)) {
    return { allowed: true, decisionReason: { type: 'other', reason: 'path is in sandbox write allowlist' } }
  }
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, permType, 'allow')
    if (rule) return { allowed: true, decisionReason: { type: 'rule', rule } }
  }
  return { allowed: false }
}

export function validateGlobPattern(
  cleanPath: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  const hasTraversal = cleanPath.includes('..')
  const target = hasTraversal ? cleanPath : getGlobBaseDirectory(cleanPath)
  const absolute = isAbsolute(target) ? target : resolvePath(cwd, target)
  const { resolvedPath, isCanonical } = safeResolvePath(getFsImplementation(), absolute)
  const precomputed = isCanonical ? getResolvedWorkingDirPaths(resolvedPath) : undefined
  const result = isPathAllowed(resolvedPath, context, operationType, precomputed)
  return { ...result, resolvedPath }
}

export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const collapsed = resolvedPath.replace(/[/\\]+/g, '/').replace(/^\/[?.]\//, '')

  if (collapsed === '*' || collapsed.endsWith('/*')) return true
  if (collapsed === '/') return true

  const trimmed = collapsed.endsWith('/') && collapsed !== '/' ? collapsed.slice(0, -1) : collapsed

  if (/^[A-Za-z]:$/.test(trimmed) || /^[A-Za-z]:\/?$/.test(collapsed)) return true
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/[/\\]+/g, '/')
  if (home && trimmed === home) return true
  if (/^\/[^/]+$/.test(trimmed)) return true
  if (/^[A-Za-z]:\/[^/]+$/.test(trimmed)) return true

  return false
}

export function validatePath(
  path: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  let cleaned = path
  if (/^['"]/.test(cleaned)) cleaned = cleaned.slice(1)
  if (/['"]$/.test(cleaned)) cleaned = cleaned.slice(0, -1)
  cleaned = expandTilde(cleaned)

  if (containsVulnerableUncPath(cleaned)) {
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: { type: 'other', reason: 'UNC network paths require manual approval' },
    }
  }
  if (cleaned.startsWith('~')) {
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: { type: 'other', reason: 'tilde expansion variants require manual approval' },
    }
  }
  if (cleaned.includes('$') || cleaned.includes('%') || cleaned.startsWith('=')) {
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: { type: 'other', reason: 'shell expansion syntax in paths requires manual approval' },
    }
  }
  if (GLOB_METACHARS.test(cleaned)) {
    if (operationType === 'read') {
      return validateGlobPattern(cleaned, cwd, context, operationType)
    }
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: {
        type: 'other',
        reason: 'glob patterns are not allowed in write operations; specify an exact file path',
      },
    }
  }
  const absolute = isAbsolute(cleaned) ? cleaned : resolvePath(cwd, cleaned)
  const { resolvedPath, isCanonical } = safeResolvePath(getFsImplementation(), absolute)
  const precomputed = isCanonical ? getResolvedWorkingDirPaths(resolvedPath) : undefined
  const result = isPathAllowed(resolvedPath, context, operationType, precomputed)
  return { ...result, resolvedPath }
}
