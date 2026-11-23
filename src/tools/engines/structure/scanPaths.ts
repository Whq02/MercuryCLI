import { normalizeGlobPattern } from '../../glob/globPattern.js'
import { pathModuleFor, toPosixSeparators } from '../../../platform/host-os/paths.js'

export function posixRelative(root: string, full: string, platform: NodeJS.Platform = process.platform): string {
  const rel = pathModuleFor(platform).relative(root, full)
  return toPosixSeparators(rel, platform)
}

export function normalizeFileGlobs(globs: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): string[] | undefined {
  return globs?.map(g => normalizeGlobPattern(g, platform).replace(/^\.\//, ''))
}
