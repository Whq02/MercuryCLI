import { accessSync, constants, existsSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { hostEnv } from '../hostEnv.js'
import { passedOver } from '../passedOver.js'

const WIN32_SPAWNABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const

export function spawnableCommandSpellings(command: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [command]
  return [...WIN32_SPAWNABLE_EXTENSIONS.map(ext => `${command}${ext}`), command]
}

function isSpawnableSpelling(line: string): boolean {
  const lower = line.toLowerCase()
  return WIN32_SPAWNABLE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export function pickWin32ExecutableLine(lines: readonly string[]): string | null {
  const listed = lines.map(line => line.trim()).filter(line => line !== '')
  const spawnable = listed.find(isSpawnableSpelling)
  return spawnable ?? listed[0] ?? null
}

function searchDirs(pathValue: string, platform: string): string[] {
  const entries = pathValue.split(platform === 'win32' ? ';' : ':')
  if (platform === 'win32') {
    return entries.map(entry => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry)).filter(entry => entry !== '')
  }
  return entries.map(entry => (entry === '' ? '.' : entry))
}

export function isExecutableFile(candidate: string, platform: string = process.platform): boolean {
  try {
    if (platform !== 'win32') accessSync(candidate, constants.X_OK)
    return statSync(candidate).isFile()
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function isExecutablePath(candidate: string, platform: string = process.platform): boolean {
  try {
    if (platform === 'win32') return existsSync(candidate)
    accessSync(candidate, constants.X_OK)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

function commandHasDirectoryPart(command: string, platform: string): boolean {
  return command.includes('/') || (platform === 'win32' && command.includes('\\'))
}

export function resolveProgramInPath(command: string, pathValue: string, platform: string = process.platform): string | null {
  if (command === '') return null
  const spellings = spawnableCommandSpellings(command, platform)
  if (commandHasDirectoryPart(command, platform)) {
    for (const spelling of spellings) {
      const candidate = path.resolve(spelling)
      if (isExecutableFile(candidate, platform)) return candidate
    }
    return null
  }
  if (platform === 'win32') {
    const listed: string[] = []
    for (const dir of searchDirs(pathValue, platform)) {
      for (const spelling of spellings) {
        const candidate = path.resolve(dir, spelling)
        if (isExecutableFile(candidate, platform)) listed.push(candidate)
      }
      if (listed.some(isSpawnableSpelling)) break
    }
    return pickWin32ExecutableLine(listed)
  }
  for (const dir of searchDirs(pathValue, platform)) {
    const candidate = path.resolve(dir, command)
    if (isExecutableFile(candidate, platform)) return candidate
  }
  return null
}

export function pathExtensions(env: NodeJS.ProcessEnv = hostEnv(), platform: string = process.platform): string[] {
  return platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
}

export function executableSuffixes(win32Suffixes: readonly string[], platform: string = process.platform): readonly string[] {
  return platform === 'win32' ? win32Suffixes : ['']
}

export function pathDelimiter(platform: string = process.platform): ';' | ':' {
  return platform === 'win32' ? ';' : ':'
}

export function hostPathDelimiter(platform: string = process.platform): string {
  return platform === 'win32' ? ';' : path.delimiter
}

export function envPathDirs(env: NodeJS.ProcessEnv = hostEnv(), platform: string = process.platform): string[] {
  return (env.PATH ?? env.Path ?? '').split(hostPathDelimiter(platform)).filter(dir => dir !== '')
}

export function executableName(name: string, platform: string = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name
}

export function vendoredNodeRelativePath(platform: string = process.platform): string {
  return platform === 'win32' ? 'node.exe' : 'bin/node'
}

export function venvPythonPath(venvDir: string, platform: string = process.platform): string {
  return platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python')
}

export function evalPythonCommands(platform: string = process.platform): string[] {
  return platform === 'win32' ? ['python3', 'python', 'py'] : ['python3']
}

export function debugpyPythonCommands(platform: string = process.platform): string[] {
  if (platform === 'win32') return ['python3', 'python', 'py']
  if (platform === 'darwin') return ['python3', 'python', '/usr/bin/python3']
  return ['python3', 'python']
}
