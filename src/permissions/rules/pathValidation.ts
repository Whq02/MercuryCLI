import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { getFsImplementation, safeResolvePath } from '../../platform/files/fsOperations.js'
import { rememberedPlatform } from '../../platform/host-os/host.js'
import { expandTildeWithHome, pathSeparatorRegex, preferredHomeEnv, samePathCase } from '../../platform/host-os/paths.js'
import type { PermissionDecisionReason } from './permissions.js'
import {
  checkEditableInternalPath,
  checkUncPathPermission,
  checkReadableInternalPath,
  checkPathSafetyForAutoEdit,
  getResolvedWorkingDirPaths,
  instructionEstateGrant,
  isInstructionEstatePath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from './filesystem.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

export type FileOperationType = 'read' | 'write' | 'create'

type PathCheckResult = {
  allowed: boolean
  decisionReason?: PermissionDecisionReason
}

type ResolvedPathCheckResult = {
  allowed: boolean
  resolvedPath: string
  decisionReason?: PermissionDecisionReason
}

const GLOB_META_RE = /[*?[\]{}]/

function normalizeRemovalPath(path: string): string {
  const collapsed = path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/[.?]\//, '')
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1)
  }
  return collapsed
}

export function formatDirectoryList(directories: string[]): string {
  const quoted = directories.map(dir => `'${dir}'`)
  if (quoted.length <= 5) {
    return quoted.join(', ')
  }
  return `${quoted.slice(0, 5).join(', ')} and ${quoted.length - 5} more`
}

export function expandTilde(path: string): string {
  const env = hostEnv()
  const home = env.HOME || env.USERPROFILE
  if (!home) return path
  return expandTildeWithHome(path, home)
}

export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const pathsToCheck = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(resolvedPath)
  const toolType: 'read' | 'edit' = operationType === 'read' ? 'read' : 'edit'

  for (const candidate of pathsToCheck) {
    const denyRule = matchingRuleForInput(candidate, context, toolType, 'deny')
    if (denyRule !== null) {
      return { allowed: false, decisionReason: { type: 'rule', rule: denyRule } }
    }
  }

  const steering =
    operationType !== 'read' &&
    (context.mode === 'default' || context.mode === 'implement' || context.mode === 'flow') &&
    isInstructionEstatePath(resolvedPath, context.mode === 'flow')

  if (operationType !== 'read') {
    if (!steering && checkEditableInternalPath(resolvedPath).behavior === 'allow') {
      return { allowed: true }
    }
    const safety = checkPathSafetyForAutoEdit(resolvedPath, pathsToCheck, context)
    if (!safety.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safety.message,
          operatorOnly: safety.operatorOnly,
        },
      }
    }
  }

  if (pathInAllowedWorkingPath(resolvedPath, context, pathsToCheck)) {
    if (operationType === 'read') {
      return { allowed: true }
    }
    if (context.mode === 'implement' && !steering) {
      return { allowed: true }
    }
  }

  if (operationType === 'read' && checkReadableInternalPath(resolvedPath).behavior === 'allow') {
    return { allowed: true }
  }

  if (steering) {
    const grant = instructionEstateGrant(pathsToCheck, context)
    if (grant !== undefined) {
      return { allowed: true, decisionReason: { type: 'rule', rule: grant } }
    }
    if (context.mode === 'flow') {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: `Permission to write ${resolvedPath} is required: this file steers every later session.`,
          operatorOnly: true,
        },
      }
    }
    return { allowed: false }
  }

  for (const candidate of pathsToCheck) {
    const allowRule = matchingRuleForInput(candidate, context, toolType, 'allow')
    if (allowRule !== null) {
      return { allowed: true, decisionReason: { type: 'rule', rule: allowRule } }
    }
  }

  return { allowed: false }
}

export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const normalized = normalizeRemovalPath(resolvedPath)
  if (
    normalized === '*' ||
    normalized.endsWith('/*') ||
    normalized === '/' ||
    /^[A-Za-z]:$/.test(normalized) ||
    /^\/[^/]+$/.test(normalized) ||
    /^[A-Za-z]:\/[^/]+$/.test(normalized)
  ) {
    return true
  }
  const home = preferredHomeEnv(hostEnv())
  if (home) {
    const normalizedHome = normalizeRemovalPath(home)
    if (samePathCase(normalized, normalizedHome, rememberedPlatform())) {
      return true
    }
  }
  return false
}

function globBaseDirectory(path: string): string {
  const globIndex = path.search(GLOB_META_RE)
  const prefix = path.slice(0, globIndex)
  const sepRe = pathSeparatorRegex()
  let lastSep = -1
  for (const match of prefix.matchAll(sepRe)) {
    if (match.index !== undefined) {
      lastSep = match.index
    }
  }
  if (lastSep === -1) return '.'
  if (lastSep === 0) return '/'
  if (lastSep === 2 && /^[A-Za-z]:/.test(prefix)) return prefix.slice(0, 3)
  return prefix.slice(0, lastSep)
}

export function validatePath(
  path: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  let stripped = path
  if (
    stripped.length >= 2 &&
    ((stripped.startsWith("'") && stripped.endsWith("'")) ||
      (stripped.startsWith('"') && stripped.endsWith('"')))
  ) {
    stripped = stripped.slice(1, -1)
  }

  const expanded = expandTilde(stripped)

  const unc = checkUncPathPermission(
    expanded,
    context,
    operationType === 'read' ? 'read' : 'edit',
  )
  if (unc !== null) {
    if (unc.behavior === 'allow') {
      return {
        allowed: true,
        resolvedPath: expanded,
        ...(unc.decisionReason ? { decisionReason: unc.decisionReason } : {}),
      }
    }
    if (unc.behavior === 'deny') {
      return {
        allowed: false,
        resolvedPath: expanded,
        decisionReason: unc.decisionReason,
      }
    }
    const decisionReason: PermissionDecisionReason =
      unc.decisionReason?.type === 'safetyCheck'
        ? unc.decisionReason
        : { type: 'safetyCheck', reason: unc.message, operatorOnly: true }
    return {
      allowed: false,
      resolvedPath: expanded,
      decisionReason,
    }
  }

  if (expanded.startsWith('~')) {
    return {
      allowed: false,
      resolvedPath: expanded,
      decisionReason: {
        type: 'other',
        reason: 'tilde expansion variants require manual approval',
      },
    }
  }

  if (expanded.includes('$') || expanded.includes('%') || expanded.startsWith('=')) {
    return {
      allowed: false,
      resolvedPath: expanded,
      decisionReason: {
        type: 'other',
        reason: 'shell expansion syntax in paths requires manual approval',
      },
    }
  }

  if (GLOB_META_RE.test(expanded)) {
    if (operationType !== 'read') {
      return {
        allowed: false,
        resolvedPath: expanded,
        decisionReason: {
          type: 'other',
          reason: 'glob patterns are not allowed in write operations; specify an exact file path',
        },
      }
    }
    const target = expanded.includes('..') ? expanded : globBaseDirectory(expanded)
    const absoluteTarget = isAbsolute(target) ? target : resolvePath(cwd, target)
    const { resolvedPath } = safeResolvePath(getFsImplementation(), absoluteTarget)
    const check = isPathAllowed(resolvedPath, context, operationType)
    return {
      allowed: check.allowed,
      resolvedPath,
      ...(check.decisionReason ? { decisionReason: check.decisionReason } : {}),
    }
  }

  const absolutePath = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded)
  const { resolvedPath } = safeResolvePath(getFsImplementation(), absolutePath)
  const check = isPathAllowed(resolvedPath, context, operationType)
  return {
    allowed: check.allowed,
    resolvedPath,
    ...(check.decisionReason ? { decisionReason: check.decisionReason } : {}),
  }
}
