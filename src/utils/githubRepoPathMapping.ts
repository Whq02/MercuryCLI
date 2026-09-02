import { realpath } from 'node:fs/promises'

import { getOriginalCwd } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { detectCurrentRepository, parseGitHubRepository } from './detectRepository.js'
import { pathExists } from './file.js'
import { findGitRoot } from './git.js'
import { getRemoteUrlForDir } from './git/gitFilesystem.js'

/**
 * A global-config map (`githubRepoPaths`) from a lowercased `owner/repo`
 * key to an ordered list of absolute local clone paths, most-recently-used
 * first.
 */

type RepoPathMap = Record<string, string[]>

function readMap(): RepoPathMap {
  return ((getGlobalConfig() as { githubRepoPaths?: RepoPathMap }).githubRepoPaths ?? {}) as RepoPathMap
}

function writeMap(map: RepoPathMap): void {
  saveGlobalConfig(current => ({ ...current, githubRepoPaths: map }) as typeof current)
}

/**
 * Fire-and-forget startup update: prepend the repository ROOT discovered
 * from the session's original working directory (so the stored path is the
 * root regardless of which subdirectory the session launched from), or that
 * directory when no root is found; realpath'd and NFC'd, tolerating failure.
 * Never throws.
 */
export async function updateGithubRepoPathMapping(): Promise<void> {
  try {
    const repo = await detectCurrentRepository()
    if (!repo) {
      logForDebugging('githubRepoPathMapping: not a GitHub repository; nothing to record')
      return
    }
    const originalCwd = getOriginalCwd()
    let root = findGitRoot(originalCwd) ?? originalCwd
    try {
      root = (await realpath(root)).normalize('NFC')
    } catch {
      root = root.normalize('NFC')
    }
    const key = repo.toLowerCase()
    const map = readMap()
    const existing = map[key] ?? []
    if (existing[0] === root) return
    map[key] = [root, ...existing.filter(path => path !== root)]
    writeMap(map)
  } catch (err) {
    logForDebugging(`githubRepoPathMapping: update failed: ${String(err)}`)
  }
}

export function getKnownPathsForRepo(repo: string): string[] {
  return readMap()[repo.toLowerCase()] ?? []
}

/** The subset that exists on disk, probed in parallel. */
export async function filterExistingPaths(paths: string[]): Promise<string[]> {
  const exists = await Promise.all(paths.map(path => pathExists(path)))
  return paths.filter((_, index) => exists[index])
}

/** Whether the directory's remote resolves to the expected repository (case-insensitive). */
export async function validateRepoAtPath(path: string, expectedRepo: string): Promise<boolean> {
  try {
    const remote = await getRemoteUrlForDir(path)
    if (!remote) return false
    const parsed = parseGitHubRepository(remote)
    if (!parsed) return false
    return parsed.toLowerCase() === expectedRepo.toLowerCase()
  } catch {
    return false
  }
}

/** Drop a path; do nothing when unchanged; remove the key when the list empties. */
export function removePathFromRepo(repo: string, pathToRemove: string): void {
  const key = repo.toLowerCase()
  const map = readMap()
  const existing = map[key]
  if (!existing) return
  const filtered = existing.filter(path => path !== pathToRemove)
  if (filtered.length === existing.length) return
  if (filtered.length === 0) {
    delete map[key]
  } else {
    map[key] = filtered
  }
  writeMap(map)
}
