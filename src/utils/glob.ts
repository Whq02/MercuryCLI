import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { statSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import { resolveRelativePatternPrefix } from './globPrefix.js'

import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import { globSearchDepth, normalizeGlobPattern, resolveSearchGlob } from './globPattern.js'
import { getFileReadIgnorePatterns, normalizePatternsToPath, readDenialFilter } from './permissions/filesystem.js'
import { ensureDriveRootSeparator } from './platform/paths.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { ripGrepAnswer } from './ripgrep.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'


function lastSeparatorIndex(value: string): number {
  const slashIndex = value.lastIndexOf('/')
  if (sep === '/') return slashIndex
  return Math.max(slashIndex, value.lastIndexOf(sep))
}

export function extractGlobBaseDirectory(pattern: string): { baseDir: string; relativePattern: string } {
  return notBuilt('src/utils/glob.ts:22')
}

function fixDrive(baseDir: string): string {
  return ensureDriveRootSeparator(baseDir)
}

function envFlagDefaultOn(name: string): boolean {
  const raw = flagEnv(name)
  return isEnvTruthy(raw === undefined || raw === '' ? '1' : raw)
}

function sampleAcrossTopLevel(files: string[], root: string, limit: number, offset: number): string[] {
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const key = relative(root, file).split(sep)[0]!
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }
  let active = [...groups.values()].map(group => group.values())
  const selected = new Set<string>()
  let count = 0
  while (active.length && count < offset + limit) {
    const next: typeof active = []
    for (const group of active) {
      const item = group.next()
      if (item.done) continue
      if (count >= offset) selected.add(item.value)
      count++
      next.push(group)
      if (count >= offset + limit) break
    }
    active = next
  }
  return files.filter(file => selected.has(file))
}

export async function glob(
  filePattern: string,
  cwd: string,
  arg2: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean; ignored: number; incomplete?: string }> {
  return notBuilt('src/utils/glob.ts:79')
}
