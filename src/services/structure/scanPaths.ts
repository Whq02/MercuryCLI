import * as path from 'node:path'
import { normalizeGlobPattern } from '../../utils/globPattern.js'

export function posixRelative(root: string, full: string, platform: NodeJS.Platform = process.platform): string {
  const rel = (platform === 'win32' ? path.win32 : path.posix).relative(root, full)
  return platform === 'win32' ? rel.split('\\').join('/') : rel
}

export function normalizeFileGlobs(globs: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): string[] | undefined {
  return globs?.map(g => normalizeGlobPattern(g, platform).replace(/^\.\//, ''))
}
