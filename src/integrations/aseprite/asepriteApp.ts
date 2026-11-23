
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getCwd } from '../../platform/files/cwd.js'
import { execFileNoThrowWithCwd } from '../../platform/processes/execFileNoThrow.js'
import { whichSync } from '../../platform/processes/which.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import {
  asepriteSteamInstallCandidates,
  asepriteWindowsInstallCandidates,
} from '../../platform/host-os/vendors.js'

export const SPRITE_FILE_CAP = 50
const DIR_VISIT_CAP = 4_000
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__'])

export function mercuryAsepriteEnabled(): boolean {
  return flagEnabled('MERCURY_ASEPRITE')
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch (error) {
    passedOver(error)
    return false
  }
}

interface SpriteDiscovery {
  files: string[]
  total: number
  truncated: number
}

export function discoverSpriteFiles(from: string = getCwd(), denied?: (file: string) => boolean): SpriteDiscovery {
  const files: string[] = []
  let total = 0
  let visited = 0
  const walk = (dir: string, rel: string): void => {
    if (visited >= DIR_VISIT_CAP) return
    visited++
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      passedOver(error)
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile() && (e.name.endsWith('.aseprite') || e.name.endsWith('.ase'))) {
        if (denied?.(path.join(dir, e.name))) continue
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

interface AsepriteLocation {
  path: string
  source: 'pin' | 'path' | 'app-bundle' | 'steam' | 'program-files' | 'itch'
}

interface AsepriteCensus {
  aseprite?: AsepriteLocation
  pinError?: string
}

function asepriteAppBundleCandidates(home: string = homedir()): string[] {
  return [
    '/Applications/Aseprite.app/Contents/MacOS/aseprite',
    path.join(home, 'Applications', 'Aseprite.app', 'Contents', 'MacOS', 'aseprite'),
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
      pinError: `MERCURY_ASEPRITE_BIN is set to ${pin}, which does not exist`,
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
  for (const candidate of testOpts?.steamCandidates ?? asepriteSteamInstallCandidates(platform)) {
    if (isFile(candidate)) return { aseprite: { path: candidate, source: 'steam' } }
  }
  for (const { candidate, source } of asepriteWindowsInstallCandidates(platform, testOpts?.win32Candidates)) {
    if (isFile(candidate)) return { aseprite: { path: candidate, source } }
  }
  return {}
}

interface AsepriteVersionProbe {
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

interface AsepriteUnavailable {
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

interface AsepriteRunResult {
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
  opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; abortSignal?: AbortSignal },
): Promise<AsepriteRunResult> {
  const r = await execFileNoThrowWithCwd(bin, ['-b', ...args], {
    timeout: opts.timeoutMs,
    cwd: opts.cwd ?? getCwd(),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
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
