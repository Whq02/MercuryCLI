import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'

import { memoize } from 'lodash-es'

import { logError } from './log.js'


export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

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

export const getWslVersion = memoize((): string | undefined => {
  if (process.platform !== 'linux') return undefined
  try {
    const version = readFileSync('/proc/version', 'utf8')
    const explicit = /WSL(\d+)/i.exec(version)
    if (explicit) return explicit[1]
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
  }
  return info
})
