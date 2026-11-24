import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'

import { memoize } from 'lodash-es'

import { logError } from '../logs/errorLog.js'
import { passedOver } from '../errors/passedOver.js'

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

type LinuxDistroInfo = {
  kernelRelease?: string
  distroId?: string
  distroVersion?: string
}

export const getPlatform = memoize((): Platform => {
  try {
    if (process.platform === 'darwin') return 'macos'
    if (process.platform === 'win32') return 'windows'
    if (process.platform !== 'linux') return 'unknown'
    try {
      const version = readFileSync('/proc/version', 'utf8').toLowerCase()
      if (version.includes('microsoft') || version.includes('wsl')) return 'wsl'
    } catch (error) {
      logError(error)
    }
    return 'linux'
  } catch (error) {
    logError(error)
    return 'unknown'
  }
})

function osReleaseValue(rest: string): string {
  return rest.trim().replace(/^"(.*)"$/, '$1')
}

export const getLinuxDistroInfo = memoize(async (): Promise<LinuxDistroInfo | undefined> => {
  if (process.platform !== 'linux') return undefined
  const info: LinuxDistroInfo = { kernelRelease: release() }
  try {
    const text = await readFile('/etc/os-release', 'utf8')
    for (const line of text.split('\n')) {
      if (line.startsWith('ID=')) info.distroId = osReleaseValue(line.slice('ID='.length))
      else if (line.startsWith('VERSION_ID=')) info.distroVersion = osReleaseValue(line.slice('VERSION_ID='.length))
    }
  } catch (error) {
    passedOver(error)
  }
  return info
})
