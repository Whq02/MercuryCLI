import { execFileSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'


export interface IDEPathConverter {
  toLocalPath(idePath: string): string
  toIDEPath(localPath: string): string
}

const WSL_UNC = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)/

export function checkWSLDistroMatch(windowsPath: string, wslDistroName: string): boolean {
  const match = WSL_UNC.exec(windowsPath)
  if (!match) return true
  return match[1] === wslDistroName
}

function runWslpath(direction: '-u' | '-w', path: string): string | null {
  try {
    const output = execFileSync('wslpath', [direction, path], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env: { ...subprocessEnv() } })
    return output.toString('utf8').trim()
  } catch {
    return null
  }
}

function manualWindowsToLocal(windowsPath: string): string {
  const slashed = windowsPath.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(slashed)
  if (drive) return `/mnt/${(drive[1] as string).toLowerCase()}${drive[2] ?? ''}`
  return slashed
}

export class WindowsToWSLConverter implements IDEPathConverter {
  private readonly distroName: string | undefined

  constructor(distroName: string | undefined) {
    this.distroName = distroName
  }

  toLocalPath(idePath: string): string {
    if (!idePath) return idePath
    if (this.distroName && !checkWSLDistroMatch(idePath, this.distroName)) return idePath
    const converted = runWslpath('-u', idePath)
    if (converted !== null) return converted
    return manualWindowsToLocal(idePath)
  }

  toIDEPath(localPath: string): string {
    if (!localPath) return localPath
    const converted = runWslpath('-w', localPath)
    return converted !== null ? converted : localPath
  }
}
