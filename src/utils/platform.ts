import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'

import { memoize } from 'lodash-es'

import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'

/**
 * Coarse platform classification, WSL version, Linux distro info, and VCS
 * marker detection.
 */

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

/** Advisory data consumed elsewhere (the Claude Desktop reader gates on membership). */
export const SUPPORTED_PLATFORMS: Platform[] = ['macos', 'wsl']

export const getPlatform = memoize((): Platform => {
  try {
    if (process.platform === 'darwin') return 'macos'
    if (process.platform === 'win32') return 'windows'
    if (process.platform === 'linux') {
      try {
        const version = readFileSync('/proc/version', 'utf8').toLowerCase()
        if (version.includes('microsoft') || version.includes('wsl')) return 'wsl'
      } catch (err) {
        logError(err)
      }
      return 'linux'
    }
    return 'unknown'
  } catch (err) {
    logError(err)
    return 'unknown'
  }
})

/** A version digit string, or nothing. Only meaningful on Linux. */
export const getWslVersion = memoize((): string | undefined => {
  if (process.platform !== 'linux') return undefined
  try {
    const version = readFileSync('/proc/version', 'utf8')
    const explicit = /WSL(\d+)/i.exec(version)
    if (explicit) return explicit[1]
    // The original WSL kernel string carries no explicit version.
    if (version.toLowerCase().includes('microsoft')) return '1'
    return undefined
  } catch (err) {
    logError(err)
    return undefined
  }
})

export type LinuxDistroInfo = {
  distroId?: string
  distroVersion?: string
  kernelRelease?: string
}

export const getLinuxDistroInfo = memoize(async (): Promise<LinuxDistroInfo | undefined> => {
  if (process.platform !== 'linux') return undefined
  const info: LinuxDistroInfo = { kernelRelease: release() }
  try {
    const osRelease = await readFile('/etc/os-release', 'utf8')
    for (const line of osRelease.split('\n')) {
      const stripQuotes = (raw: string): string => raw.replace(/^"(.*)"$/, '$1')
      if (line.startsWith('ID=')) info.distroId = stripQuotes(line.slice('ID='.length).trim())
      else if (line.startsWith('VERSION_ID=')) info.distroVersion = stripQuotes(line.slice('VERSION_ID='.length).trim())
    }
  } catch {
    // A missing os-release is not an error; the kernel alone is the result.
  }
  return info
})

/** Marker entry → reported VCS; first-insertion order with the env signal first. */
const VCS_MARKERS: Array<[string, string]> = [
  ['.git', 'git'],
  ['.hg', 'mercurial'],
  ['.svn', 'svn'],
  ['.p4config', 'perforce'],
  ['$tf', 'tfs'],
  ['.tfvc', 'tfs'],
  ['.jj', 'jujutsu'],
  ['.sl', 'sapling'],
]

export async function detectVcs(dir?: string): Promise<string[]> {
  const found = new Set<string>()
  if (process.env.P4PORT) found.add('perforce')
  const fs = getFsImplementation()
  const target = dir ?? process.cwd()
  let entries: Set<string>
  try {
    entries = new Set(fs.readdirSync(target).map(entry => entry.name))
  } catch {
    // An unreadable directory yields whatever the env signal produced.
    return [...found]
  }
  for (const [marker, vcs] of VCS_MARKERS) {
    if (entries.has(marker)) found.add(vcs)
  }
  return [...found]
}
