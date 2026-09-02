import { realpath } from 'node:fs/promises'

import { getOriginalCwd } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { detectCurrentRepository, parseGitHubRepository } from './detectRepository.js'
import { pathExists } from './file.js'
import { findGitRoot } from './git.js'
import { getRemoteUrlForDir } from './git/gitFilesystem.js'


type RepoPathMap = Record<string, string[]>

function readMap(): RepoPathMap {
  return ((getGlobalConfig() as { githubRepoPaths?: RepoPathMap }).githubRepoPaths ?? {}) as RepoPathMap
}

function writeMap(map: RepoPathMap): void {
  saveGlobalConfig(current => ({ ...current, githubRepoPaths: map }) as typeof current)
}

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

export async function filterExistingPaths(paths: string[]): Promise<string[]> {
  const exists = await Promise.all(paths.map(path => pathExists(path)))
  return paths.filter((_, index) => exists[index])
}

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
