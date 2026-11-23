import { realpath } from 'node:fs/promises'
import { getOriginalCwd } from './process-state/processState.js'
import { getGlobalConfig, saveGlobalConfig } from '../platform/settings/config.js'
import { logForDebugging } from '../platform/logs/debugLog.js'
import { detectCurrentRepository } from '../platform/git/detectRepository.js'
import { findGitRoot } from '../platform/git/git.js'
import { passedOverAs } from '../platform/errors/passedOver.js'

export async function updateGithubRepoPathMapping(): Promise<void> {
  try {
    const repo = await detectCurrentRepository()
    if (!repo) {
      logForDebugging('githubRepoPathMapping: not a GitHub repository; nothing to record')
      return
    }
    const original = getOriginalCwd()
    const root = findGitRoot(original) ?? original
    const path = (await realpath(root).catch(passedOverAs(root))).normalize('NFC')
    const key = repo.toLowerCase()
    const map = getGlobalConfig().githubRepoPaths ?? {}
    const paths = Object.hasOwn(map, key) ? map[key]! : []
    if (paths[0] === path) return
    Object.defineProperty(map, key, { value: [path, ...paths.filter(item => item !== path)], writable: true, enumerable: true, configurable: true })
    saveGlobalConfig(current => ({ ...current, githubRepoPaths: map }))
  } catch (error) {
    logForDebugging(`githubRepoPathMapping: update failed: ${String(error)}`)
  }
}
