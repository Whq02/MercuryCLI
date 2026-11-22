import type { ToolPermissionContext } from '../../Tool.js'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { rememberedPlatform } from '../platform/host.js'
import { expandTildeWithHome, pathSeparatorRegex, preferredHomeEnv, samePathCase } from '../platform/paths.js'
import type { PermissionDecisionReason } from '../../types/permissions.js'
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
import { hostEnv } from '../hostEnv.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type FileOperationType = Unbuilt

type PathCheckResult = Unbuilt
type ResolvedPathCheckResult = Unbuilt

export function formatDirectoryList(directories: string[]): string {
  return notBuilt('src/utils/permissions/pathValidation.ts:27')
}

export function expandTilde(path: string): string {
  return notBuilt('src/utils/permissions/pathValidation.ts:46')
}

export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  return notBuilt('src/utils/permissions/pathValidation.ts:51')
}

export function isDangerousRemovalPath(resolvedPath: string): boolean {
  return notBuilt('src/utils/permissions/pathValidation.ts:117')
}

export function validatePath(
  path: string,
  cwd: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  return notBuilt('src/utils/permissions/pathValidation.ts:135')
}
