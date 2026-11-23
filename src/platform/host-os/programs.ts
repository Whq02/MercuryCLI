import { accessSync, constants, existsSync, lstatSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { hostEnv } from '../environment/hostEnv.js'
import { passedOver } from '../errors/passedOver.js'

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

function isWin32SpawnCandidate(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch (error) {
    passedOver(error)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    try {
      return !lstatSync(candidate).isDirectory()
    } catch (lstatError) {
      passedOver(lstatError)
      return false
    }
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

function envValueInsensitive(env: NodeJS.ProcessEnv, target: string): string | undefined {
  const upper = target.toUpperCase()
  let found: string | undefined
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) found = value
  }
  return found
}

function win32SpawnSpellings(command: string, env: NodeJS.ProcessEnv): string[] {
  const exts: string[] = [...WIN32_SPAWNABLE_EXTENSIONS]
  const seen = new Set<string>(exts)
  const rawPathExt = envValueInsensitive(env, 'PATHEXT') ?? envValueInsensitive(hostEnv(), 'PATHEXT')
  if (rawPathExt) {
    for (const raw of rawPathExt.split(';')) {
      const ext = raw.trim()
      if (ext === '') continue
      const lower = ext.toLowerCase()
      if (!seen.has(lower)) {
        seen.add(lower)
        exts.push(ext)
      }
    }
  }
  return [...exts.map(ext => `${command}${ext}`), command]
}

export function missingSpawnCommandError(
  command: string,
  env: NodeJS.ProcessEnv = hostEnv(),
  cwd?: string,
  platform: string = process.platform,
): NodeJS.ErrnoException | null {
  if (platform !== 'win32') return null
  const missing = (): NodeJS.ErrnoException =>
    Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }) as NodeJS.ErrnoException
  if (command === '') return missing()
  const spellings = win32SpawnSpellings(command, env)
  if (commandHasDirectoryPart(command, platform)) {
    for (const spelling of spellings) {
      const candidate = cwd !== undefined ? path.resolve(cwd, spelling) : path.resolve(spelling)
      if (isWin32SpawnCandidate(candidate)) return null
    }
    return missing()
  }
  const pathValue = envValueInsensitive(env, 'PATH') ?? envValueInsensitive(hostEnv(), 'PATH') ?? ''
  const dirs = [cwd ?? process.cwd(), ...searchDirs(pathValue, platform)]
  for (const dir of dirs) {
    for (const spelling of spellings) {
      const candidate = path.resolve(dir, spelling)
      if (isWin32SpawnCandidate(candidate)) return null
    }
  }
  return missing()
}

type PackPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win-x64' | 'win-arm64'

export function packPlatformFor(platform: string = process.platform, arch: string = process.arch): PackPlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'win32' && arch === 'arm64') return 'win-arm64'
  return null
}

export function vendorPlatformTag(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform === 'win32' ? 'win' : platform}-${arch}`
}

export function hostOsFamily(platform: string = process.platform): 'windows' | 'darwin' | 'linux' {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
}

export function normalizedOsPlatform(platform: string = process.platform): 'win32' | 'darwin' | 'linux' {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'darwin'
  return 'linux'
}

export function pathExtensionsForName(
  name: string,
  env: NodeJS.ProcessEnv = hostEnv(),
  platform: string = process.platform,
): string[] {
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExtension = extensions.some(ext => name.toLowerCase().endsWith(ext.toLowerCase()))
  const exts: string[] = platform === 'win32' && !hasExtension ? [] : ['']
  if (platform === 'win32' && !hasExtension) {
    for (const raw of (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')) {
      if (raw.length === 0) continue
      const lower = raw.toLowerCase()
      if (!exts.includes(lower)) exts.push(lower)
      if (!exts.includes(raw)) exts.push(raw)
    }
  }
  return exts
}

export function pathLookupExtensions(env: NodeJS.ProcessEnv = hostEnv(), platform: string = process.platform): string[] {
  if (platform !== 'win32') return ['']
  return [...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(ext => ext !== ''), '']
}

export function hasRequiredProgramExtension(filePath: string, platform: string = process.platform): boolean {
  return platform !== 'win32' || path.extname(filePath) !== ''
}
