
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { whichSync } from '../../utils/which.js'

export const SPRITE_FILE_CAP = 50
const DIR_VISIT_CAP = 4_000
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__'])

export function mercuryAsepriteEnabled(): boolean {
  return flagEnabled('MERCURY_ASEPRITE')
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export interface SpriteDiscovery {
  files: string[]
  total: number
  truncated: number
}

export function discoverSpriteFiles(from: string = getCwd()): SpriteDiscovery {
  const files: string[] = []
  let total = 0
  let visited = 0
  const walk = (dir: string, rel: string): void => {
    if (visited >= DIR_VISIT_CAP) return
    visited++
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile() && (e.name.endsWith('.aseprite') || e.name.endsWith('.ase'))) {
        total++
        if (files.length < SPRITE_FILE_CAP) {
          files.push(rel ? `${rel}/${e.name}` : e.name)
        }
      }
    }
  }
  walk(path.resolve(from), '')
  return { files, total, truncated: Math.max(0, total - files.length) }
}

export interface AsepriteLocation {
  path: string
  source: 'pin' | 'path' | 'app-bundle' | 'steam' | 'program-files' | 'itch'
}

export interface AsepriteCensus {
  aseprite?: AsepriteLocation
  pinError?: string
}

export function asepriteAppBundleCandidates(home: string = homedir()): string[] {
  return [
    '/Applications/Aseprite.app/Contents/MacOS/aseprite',
    path.join(home, 'Applications', 'Aseprite.app', 'Contents', 'MacOS', 'aseprite'),
  ]
}

export function asepriteSteamCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const tail = ['steamapps', 'common', 'Aseprite']
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Steam', ...tail, 'Aseprite.app', 'Contents', 'MacOS', 'aseprite'),
    ]
  }
  if (platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
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

export function asepriteWin32Candidates(home: string = homedir()): Array<{
  candidate: string
  source: 'program-files' | 'itch'
}> {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  return [
    { candidate: path.join(pf, 'Aseprite', 'Aseprite.exe'), source: 'program-files' as const },
    { candidate: path.join(pf86, 'Aseprite', 'Aseprite.exe'), source: 'program-files' as const },
    { candidate: path.join(localAppData, 'itch', 'apps', 'aseprite', 'Aseprite.exe'), source: 'itch' as const },
  ]
}

export function locateAseprite(testOpts?: {
  appBundles?: string[]
  steamCandidates?: string[]
  win32Candidates?: Array<{ candidate: string; source: 'program-files' | 'itch' }>
  skipPathProbe?: boolean
  platform?: NodeJS.Platform
}): AsepriteCensus {
  const platform = testOpts?.platform ?? process.platform
  const pin = flagEnv('MERCURY_ASEPRITE_BIN')
  if (pin && pin.trim() !== '') {
    if (isFile(pin)) return { aseprite: { path: pin, source: 'pin' } }
    return {
      pinError: `MERCURY_ASEPRITE_BIN set but ${pin} is not an existing file — the pin names itself, no silent fallback`,
    }
  }
  if (flagEnv('MERCURY_ASEPRITE_NO_DISCOVERY') === '1') return {}
  if (!testOpts?.skipPathProbe) {
    const onPath = whichSync('aseprite')
    if (onPath) return { aseprite: { path: onPath, source: 'path' } }
  }
  if (platform === 'darwin') {
    for (const candidate of testOpts?.appBundles ?? asepriteAppBundleCandidates()) {
      if (isFile(candidate)) return { aseprite: { path: candidate, source: 'app-bundle' } }
    }
  }
  for (const candidate of testOpts?.steamCandidates ?? asepriteSteamCandidates(platform)) {
    if (isFile(candidate)) return { aseprite: { path: candidate, source: 'steam' } }
  }
  if (platform === 'win32') {
    for (const { candidate, source } of testOpts?.win32Candidates ?? asepriteWin32Candidates()) {
      if (isFile(candidate)) return { aseprite: { path: candidate, source } }
    }
  }
  return {}
}

export interface AsepriteVersionProbe {
  version?: string
  reason?: string
}

let versionCache: { at: number; bin: string; result: AsepriteVersionProbe } | null = null
const VERSION_CACHE_TTL_MS = 30_000

export function _resetAsepriteVersionProbeForTesting(): void {
  versionCache = null
}

export async function probeAsepriteVersion(bin: string): Promise<AsepriteVersionProbe> {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_CACHE_TTL_MS) {
    return versionCache.result
  }
  const r = await execFileNoThrowWithCwd(bin, ['--version'], { timeout: 5_000 })
  const firstLine = (r.stdout ?? '').split('\n')[0] ?? ''
  const m = firstLine.match(/^Aseprite\s+v?(\S+)/)
  let result: AsepriteVersionProbe
  if (r.code !== 0 || !m || m[1] === undefined) {
    result = {
      reason: `aseprite --version unparseable: ${firstLine.slice(0, 80) || r.error || `exit ${r.code}`}`,
    }
  } else {
    result = { version: m[1] }
  }
  versionCache = { at: Date.now(), bin, result }
  return result
}

export const ASEPRITE_INSTALL_REMEDY =
  'install Aseprite (aseprite.org — Steam/itch builds and the direct download all count; a source build works too) or pin the binary with MERCURY_ASEPRITE_BIN; Mercury never installs or launches it for you'

export interface AsepriteResolution {
  state: 'ok'
  location: AsepriteLocation
}

export interface AsepriteUnavailable {
  state: 'unavailable'
  note: string
  remedies: string[]
}

export function resolveAseprite(): AsepriteResolution | AsepriteUnavailable {
  const census = locateAseprite()
  if (census.pinError) {
    return {
      state: 'unavailable',
      note: census.pinError,
      remedies: ['fix or unset MERCURY_ASEPRITE_BIN'],
    }
  }
  if (census.aseprite) return { state: 'ok', location: census.aseprite }
  return {
    state: 'unavailable',
    note: 'no Aseprite located — probed the MERCURY_ASEPRITE_BIN pin (unset), PATH, the app bundles, the Steam library, and the win32 installer/itch roots',
    remedies: [ASEPRITE_INSTALL_REMEDY],
  }
}

const OUTPUT_CAP_CHARS = 64 * 1024

export interface AsepriteRunResult {
  code: number
  stdout: string
  stderr: string
  error?: string
  truncated: boolean
}

function capStream(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CAP_CHARS) return { text: s, truncated: false }
  return {
    text: s.slice(0, OUTPUT_CAP_CHARS) + `\n… [truncated ${s.length - OUTPUT_CAP_CHARS} chars]`,
    truncated: true,
  }
}

export async function runAseprite(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
): Promise<AsepriteRunResult> {
  const r = await execFileNoThrowWithCwd(bin, ['-b', ...args], {
    timeout: opts.timeoutMs,
    cwd: opts.cwd ?? getCwd(),
  })
  const out = capStream(r.stdout ?? '')
  const err = capStream(r.stderr ?? '')
  return {
    code: r.code,
    stdout: out.text,
    stderr: err.text,
    ...(r.error ? { error: r.error } : {}),
    truncated: out.truncated || err.truncated,
  }
}
