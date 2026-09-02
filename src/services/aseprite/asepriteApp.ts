// ============================================================================
//  aseprite/asepriteApp — ONE owner for Aseprite context + app-location +
//  batch-run truth (MERCURY_ASEPRITE, opt-in default-OFF — off = no Aseprite
//  surface anywhere, identical to a build without it). The blenderProject
//  sibling with one structural difference: Aseprite ships a REAL batch CLI
//  (`aseprite -b`: exports, sprite sheets, list flags, Lua --script), so the
//  door is a bounded spawn per operation — no live bridge, no add-on, no
//  port, no token. Every operation rides batch mode; a GUI is never
//  launched.
//
//  Like Blender, Aseprite has no project-root marker: the sprite file
//  (.aseprite/.ase) IS the unit of work. Context is sprite AWARENESS — the
//  same bounded deterministic walk (lexicographic DFS, VCS/hidden dirs
//  skipped, capped, the total counted honestly).
//
//  Location (never executed for location; never installed):
//    MERCURY_ASEPRITE_BIN pin (AUTHORITATIVE; a broken pin refuses BY NAME)
//    → PATH `aseprite` → darwin /Applications/Aseprite.app + the
//    ~/Applications sibling (Contents/MacOS/aseprite) → the Steam library
//    (all three platforms — Aseprite's main store) → the win32 installer
//    root (%ProgramFiles%\Aseprite) and the itch.io app home.
//
//  Version probe: `aseprite --version` prints "Aseprite <version>" and
//  exits (release builds "Aseprite 1.3.7-arm64", source builds "Aseprite
//  1.x-dev" — captured from the binary's own output).
//  Bounded ASYNC probe through the house exec wrapper (5s, 30s cache) — a
//  hung or foreign binary answers a reason, never a hang or a throw.
//
//  Proof: scripts/aseprite/ (hermetic: scratch trees, fake app bundles, a
//  shim `aseprite`; the real-engine legs run only where the app resolves).
// ============================================================================

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

/** Master gate for the Aseprite dev lanes (opt-in: MERCURY_ASEPRITE=1 — the
 *  boot-menu row "Aseprite dev lanes"). Off = every Aseprite surface absent. */
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
  /** Relative .aseprite/.ase paths, deterministic order, capped. */
  files: string[]
  /** Total found before the cap. */
  total: number
  truncated: number
}

/** Bounded deterministic sprite walk from `from` (the blender walk sibling):
 *  lexicographic DFS, hidden/VCS dirs skipped, capped, total counted
 *  honestly. */
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
  /** MERCURY_ASEPRITE_BIN set but not an existing file. */
  pinError?: string
}

/** The darwin app-bundle executables probed (the direct-download install). */
export function asepriteAppBundleCandidates(home: string = homedir()): string[] {
  return [
    '/Applications/Aseprite.app/Contents/MacOS/aseprite',
    path.join(home, 'Applications', 'Aseprite.app', 'Contents', 'MacOS', 'aseprite'),
  ]
}

/** The Steam-library executables per platform (Aseprite's main store road).
 *  Steam roots vary by install; the standard per-OS homes are probed. */
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

/** The win32 non-Steam installs: the installer default + the itch.io app
 *  home (both store roads the operator may have used). */
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

/**
 * LOCATE Aseprite — filesystem facts only, never executed for location.
 * Pin (exclusive) → PATH → the darwin app bundles → the Steam library →
 * the win32 installer/itch roots.
 * @param testOpts proof seam: candidate overrides + PATH-probe skip.
 */
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
  // The ambient-state proof seam (the browser-resolver grammar): resolution
  // proofs must not read the calibration machine — the seam blanks every
  // discovery rung below the pin.
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

/** TEST-ONLY: drop the version-probe cache. */
export function _resetAsepriteVersionProbeForTesting(): void {
  versionCache = null
}

/** Bounded `aseprite --version` probe (async — never blocks the loop): 5s
 *  timeout, 30s cache, first-line parse. Release builds answer
 *  "Aseprite 1.3.7-arm64", source builds "Aseprite 1.x-dev" — the token is
 *  carried as-is, never forced numeric. A hung or foreign binary answers a
 *  reason, never a hang or a throw. */
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

/** The install remedy every absent surface speaks (the operator's act). */
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

/** The ONE resolution verdict (pin > PATH > app bundle > Steam > win32
 *  installer/itch > precise unavailable naming every road). */
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
  /** Non-zero exits and kill reasons, the wrapper's own sentence. */
  error?: string
  /** True when a cap swallowed output — the count is in the text. */
  truncated: boolean
}

function capStream(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CAP_CHARS) return { text: s, truncated: false }
  return {
    text: s.slice(0, OUTPUT_CAP_CHARS) + `\n… [truncated ${s.length - OUTPUT_CAP_CHARS} chars]`,
    truncated: true,
  }
}

/**
 * The ONE Aseprite spawn owner: every operation rides `-b` (batch — the UI
 * is never started), the house exec wrapper (scrubbed env, windowsHide,
 * never throws, the child killed on timeout), and an explicit bound.
 * Output is capped with truncation counted.
 */
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
