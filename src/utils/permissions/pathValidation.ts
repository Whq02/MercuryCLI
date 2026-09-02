/**
 * Path-level permission validation for shell tools, where the shell expands
 * things the validator cannot see. Its rejection rules are TOCTOU defences,
 * each returning a reason string the UI shows.
 */
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

/** The operation being validated. */
export type FileOperationType = 'read' | 'write' | 'create'

/** The result of an allow check. */
export type PathCheckResult = { allowed: boolean; decisionReason?: PermissionDecisionReason }
/** The result of full path validation, with the resolved path attached. */
export type ResolvedPathCheckResult = PathCheckResult & { resolvedPath: string }

const GLOB_METACHARS = /[*?[\]{}]/

/** Render a directory list as single-quoted, comma-separated names; cap at 5. */
export function formatDirectoryList(directories: string[]): string {
  const quoted = directories.map(dir => `'${dir}'`)
  if (quoted.length <= 5) return quoted.join(', ')
  return `${quoted.slice(0, 5).join(', ')} and ${quoted.length - 5} more`
}

/** The base directory of a glob: everything before the first metachar, to the last separator. */
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

/** Expand a leading tilde (`~`, `~/…`, and on Windows `~\…`); `~user` is not supported. */
export function expandTilde(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  if (getPlatform() === 'windows' && path.startsWith('~\\')) return home + path.slice(1)
  return path
}

/** Whether every resolved form of a path passes the sandbox write allowlist. */
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

/** Whether a path may be operated on, given it is already resolved. */
export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const permType = operationType === 'read' ? 'read' : 'edit'
  const resolutionSet = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(resolvedPath)

  // 1. Deny rules for the operation's permission type.
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, permType, 'deny')
    if (rule) return { allowed: false, decisionReason: { type: 'rule', rule } }
  }
  // 2. write/create: internal editable paths → allowed, before the safety check.
  if (operationType !== 'read') {
    const internal = checkEditableInternalPath(resolvedPath, undefined)
    if ((internal as { behavior: string }).behavior === 'allow') return { allowed: true }
    // 3. path safety → not allowed, before the working-directory check.
    const safety = checkPathSafetyForAutoEdit(resolvedPath, resolutionSet)
    if (!safety.safe) {
      // The union's field is `reason` — consumers read it for the surfaced
      // safety-check text.
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
  // 4. Working-directory containment.
  const inside = pathInAllowedWorkingPath(resolvedPath, context, resolutionSet)
  if (inside) {
    if (operationType === 'read') return { allowed: true }
    if (context.mode === 'implement') return { allowed: true }
    // write/create in another mode falls through to allow rules.
  }
  // 5. read: internal readable paths.
  if (operationType === 'read') {
    const internal = checkReadableInternalPath(resolvedPath, undefined)
    if ((internal as { behavior: string }).behavior === 'allow') return { allowed: true }
  }
  // 6. write/create OUTSIDE the working directory: the sandbox write allowlist.
  if (operationType !== 'read' && !inside && isPathInSandboxWriteAllowlist(resolvedPath)) {
    return { allowed: true, decisionReason: { type: 'other', reason: 'path is in sandbox write allowlist' } }
  }
  // 7. Allow rules for the operation type.
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, permType, 'allow')
    if (rule) return { allowed: true, decisionReason: { type: 'rule', rule } }
  }
  // 8. Otherwise not allowed, no reason.
  return { allowed: false }
}

/** Validate a glob pattern for a read operation. */
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

/** Whether an `rm`/`rmdir` target is dangerous and must force approval. */
export function isDangerousRemovalPath(resolvedPath: string): boolean {
  // The Windows extended-length / device prefix spells the same target:
  // strip the collapsed `\\?\` · `\\.\` head so `\\?\C:\` still reads as a
  // drive root instead of slipping past every anchor below.
  const collapsed = resolvedPath.replace(/[/\\]+/g, '/').replace(/^\/[?.]\//, '')

  if (collapsed === '*' || collapsed.endsWith('/*')) return true
  if (collapsed === '/') return true

  const trimmed = collapsed.endsWith('/') && collapsed !== '/' ? collapsed.slice(0, -1) : collapsed

  // Windows drive root.
  if (/^[A-Za-z]:$/.test(trimmed) || /^[A-Za-z]:\/?$/.test(collapsed)) return true
  // The user's home directory.
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/[/\\]+/g, '/')
  if (home && trimmed === home) return true
  // Any direct child of root (/etc), not a second-level path (/usr/local).
  if (/^\/[^/]+$/.test(trimmed)) return true
  // Any direct child of a Windows drive root (C:/Windows).
  if (/^[A-Za-z]:\/[^/]+$/.test(trimmed)) return true

  return false
}

/**
 * Validate a raw path string extracted from a shell command.
 */
export function validatePath(
  path: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // 1. Strip one leading/trailing quote, then expand a leading tilde.
  let cleaned = path
  if (/^['"]/.test(cleaned)) cleaned = cleaned.slice(1)
  if (/['"]$/.test(cleaned)) cleaned = cleaned.slice(0, -1)
  cleaned = expandTilde(cleaned)

  // 2. Reject vulnerable UNC paths.
  if (containsVulnerableUncPath(cleaned)) {
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: { type: 'other', reason: 'UNC network paths require manual approval' },
    }
  }
  // 3. Reject any remaining leading tilde (~user, ~+, ~-, ~N).
  if (cleaned.startsWith('~')) {
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: { type: 'other', reason: 'tilde expansion variants require manual approval' },
    }
  }
  // 4. Reject shell expansion syntax.
  if (cleaned.includes('$') || cleaned.includes('%') || cleaned.startsWith('=')) {
    return {
      allowed: false,
      resolvedPath: cleaned,
      decisionReason: { type: 'other', reason: 'shell expansion syntax in paths requires manual approval' },
    }
  }
  // 5. Glob metacharacters.
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
  // 6. Resolve against cwd, canonicalise, and run the allow check.
  const absolute = isAbsolute(cleaned) ? cleaned : resolvePath(cwd, cleaned)
  const { resolvedPath, isCanonical } = safeResolvePath(getFsImplementation(), absolute)
  const precomputed = isCanonical ? getResolvedWorkingDirPaths(resolvedPath) : undefined
  const result = isPathAllowed(resolvedPath, context, operationType, precomputed)
  return { ...result, resolvedPath }
}
