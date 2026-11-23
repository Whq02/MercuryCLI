import * as os from 'node:os'
import * as path from 'node:path'
import { hostEnv } from '../environment/hostEnv.js'
import { pathModuleFor } from './paths.js'

const EDITOR_CLIS = ['code', 'code-insiders', 'cursor', 'codium', 'windsurf'] as const

const DARWIN_BUNDLE_CLIS: Record<(typeof EDITOR_CLIS)[number], string> = {
  code: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  'code-insiders': '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
  cursor: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  codium: '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
  windsurf: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
}

const WIN32_EDITOR_CANDIDATES = [
  'code.cmd',
  'code',
  'code.exe',
  'code-insiders.cmd',
  'cursor.cmd',
  'codium.cmd',
  'windsurf.cmd',
]

export function editorCliCandidates(
  platform: NodeJS.Platform = process.platform,
): { candidates: string[]; execShell: boolean } {
  if (platform === 'win32') {
    return { candidates: [...WIN32_EDITOR_CANDIDATES], execShell: true }
  }
  const candidates: string[] = []
  for (const cli of EDITOR_CLIS) {
    candidates.push(cli, `/usr/local/bin/${cli}`, `/opt/homebrew/bin/${cli}`)
    if (platform === 'darwin') candidates.push(DARWIN_BUNDLE_CLIS[cli])
  }
  return { candidates, execShell: false }
}

export function blenderUserConfigBase(
  version: string,
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Blender', version)
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Blender Foundation', 'Blender', version)
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'blender', version)
}

export function browserDiscoveryCandidates(
  family: { darwin: readonly string[]; win32: readonly string[]; linuxBinaries: readonly string[] },
  platform: NodeJS.Platform = os.platform(),
): { kind: 'paths'; candidates: readonly string[] } | { kind: 'binaries'; binaries: readonly string[] } {
  if (platform === 'darwin') return { kind: 'paths', candidates: family.darwin }
  if (platform === 'win32') return { kind: 'paths', candidates: family.win32 }
  return { kind: 'binaries', binaries: family.linuxBinaries }
}

export function chromeForTestingRelativePaths(platform: NodeJS.Platform = os.platform()): readonly string[] {
  if (platform === 'darwin') {
    return [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ]
  }
  if (platform === 'win32') {
    return ['chrome-win64/chrome.exe', 'chrome-win32/chrome.exe']
  }
  return ['chrome-linux64/chrome', 'chrome-linux-arm64/chrome']
}

export function ollamaWindowsExeCandidate(
  env: NodeJS.ProcessEnv,
  windowsExePath: string,
  platform: string = process.platform,
): string | null {
  return platform === 'win32' ? windowsExePath : null
}

export function godotWellKnownRootsForPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = hostEnv(),
): string[] {
  const roots: string[] = []
  const joinPath = pathModuleFor(platform).join
  const add = (...parts: Array<string | undefined>): void => {
    if (parts.some(p => !p)) return
    const root = joinPath(...(parts as string[]))
    if (!roots.includes(root)) roots.push(root)
  }
  if (platform === 'win32') {
    const home = env.USERPROFILE
    add(env.LOCALAPPDATA, 'Programs', 'Godot')
    add(env.ProgramFiles, 'Godot')
    add(env['ProgramFiles(x86)'], 'Godot')
    add(env['ProgramFiles(x86)'], 'Steam', 'steamapps', 'common', 'Godot Engine')
    add(env.ProgramFiles, 'Steam', 'steamapps', 'common', 'Godot Engine')
    add(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')
    add(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    add(env.SCOOP ?? (home ? joinPath(home, 'scoop') : undefined), 'shims')
    add(env.SCOOP ?? (home ? joinPath(home, 'scoop') : undefined), 'apps', 'godot', 'current')
    add(env.ChocolateyInstall ?? (env.ProgramData ? joinPath(env.ProgramData, 'chocolatey') : undefined), 'bin')
    return roots
  }
  const home = env.HOME
  if (platform === 'darwin') {
    add('/Applications')
    add(home, 'Applications')
    add(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Godot Engine')
    add('/opt/homebrew/bin')
    add('/usr/local/bin')
    return roots
  }
  add(home, '.local', 'bin')
  add('/usr/local/bin')
  add('/usr/bin')
  add('/var/lib/flatpak/exports/bin')
  add(home, '.local', 'share', 'flatpak', 'exports', 'bin')
  add(home, '.steam', 'steam', 'steamapps', 'common', 'Godot Engine')
  add(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Godot Engine')
  add(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam', 'steamapps', 'common', 'Godot Engine')
  return roots
}

export function isWinGetGodotPackageDir(
  lowerName: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && lowerName.startsWith('godotengine.')
}

export function godotBinaryNeedsExeSuffix(
  lowerName: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && !lowerName.endsWith('.exe')
}

export function asepriteSteamInstallCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = hostEnv(),
): string[] {
  const tail = ['steamapps', 'common', 'Aseprite']
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Steam', ...tail, 'Aseprite.app', 'Contents', 'MacOS', 'aseprite'),
    ]
  }
  if (platform === 'win32') {
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const pf = env.ProgramFiles ?? 'C:\\Program Files'
    return [
      path.join(pf86, 'Steam', ...tail, 'Aseprite.exe'),
      path.join(pf, 'Steam', ...tail, 'Aseprite.exe'),
    ]
  }
  return [
    path.join(home, '.steam', 'steam', ...tail, 'aseprite'),
    path.join(home, '.local', 'share', 'Steam', ...tail, 'aseprite'),
  ]
}

interface AsepriteWindowsInstallCandidate {
  candidate: string
  source: 'program-files' | 'itch'
}

export function asepriteWindowsInstallCandidates(
  platform: NodeJS.Platform = process.platform,
  override?: readonly AsepriteWindowsInstallCandidate[],
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = hostEnv(),
): readonly AsepriteWindowsInstallCandidate[] {
  if (platform !== 'win32') return []
  if (override !== undefined) return override
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  return [
    { candidate: path.join(pf, 'Aseprite', 'Aseprite.exe'), source: 'program-files' },
    { candidate: path.join(pf86, 'Aseprite', 'Aseprite.exe'), source: 'program-files' },
    { candidate: path.join(localAppData, 'itch', 'apps', 'aseprite', 'Aseprite.exe'), source: 'itch' },
  ]
}

export function blenderProgramFilesRoot(
  platform: NodeJS.Platform = process.platform,
  override?: string,
  env: NodeJS.ProcessEnv = hostEnv(),
): string | null {
  if (platform !== 'win32') return null
  return override ?? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')
}

export function unityHubEditorRoots(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = hostEnv(),
): string[] {
  if (platform === 'darwin') return ['/Applications/Unity/Hub/Editor']
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    return [path.join(programFiles, 'Unity', 'Hub', 'Editor')]
  }
  return [path.join(home, 'Unity', 'Hub', 'Editor')]
}

export function unityEditorExecutablePath(
  versionDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return path.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity')
  }
  if (platform === 'win32') return path.join(versionDir, 'Editor', 'Unity.exe')
  return path.join(versionDir, 'Editor', 'Unity')
}
