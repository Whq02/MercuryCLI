import { realpath } from 'node:fs/promises'

import { getOriginalCwd } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { detectCurrentRepository } from './detectRepository.js'
import { findGitRoot } from './git.js'


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
