// ============================================================================
//  ide/blenderProject — ONE owner for Blender context + app-location truth
//  (MERCURY_BLENDER, opt-in default-OFF per the operator's arming ruling —
//  off = no Blender surface anywhere, identical to a build without it).
//
//  Blender has no project-root marker convention: the .blend file IS the
//  unit of work. Context here is therefore .blend AWARENESS — a bounded
//  deterministic walk (the godot scene-walk sibling: lexicographic DFS,
//  VCS/hidden dirs skipped, capped, the total still counted honestly) —
//  plus the app LOCATED the Mac way too: /Applications/Blender.app is the
//  NORMAL install (the Godot.app lesson — a .app-only install with nothing
//  on PATH is not a broken box).
//
//  Location (never executed for location; never installed):
//    MERCURY_BLENDER_BIN pin (AUTHORITATIVE; a broken pin refuses BY NAME)
//    → PATH `blender` → darwin /Applications/Blender.app + the ~/Applications
//    sibling (Contents/MacOS/Blender) → win32 %ProgramFiles%\Blender
//    Foundation\Blender <ver>\blender.exe (version dirs, newest first).
//
//  Version probe: `blender --version` prints "Blender <version>" and exits
//  ("--version: Print Blender version and exit" — creator/creator_args.cc,
//  the flags' source of truth, read 2026-08-29). Bounded spawnSync in the
//  gdb-probe shape (5s, 30s cache) — the ONE Blender spawn in the estate,
//  probe-class; the prover drives it through a PATH-shim fake. Version
//  census pin: Blender 5.2 LTS is current (blender.org/download/lts, read
//  2026-08-29; 4.5 LTS supported to Jul 2027); nothing here is
//  version-gated.
//
//  Proof: scripts/ide/prove-blender-project.ts (cpu-pure: scratch trees,
//  fake app bundles, a shim `blender`).
// ============================================================================

import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { whichSync } from '../../utils/which.js'

export const BLEND_FILE_CAP = 50
const DIR_VISIT_CAP = 4_000
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__'])

/** Master gate for the Blender dev lanes (opt-in: MERCURY_BLENDER=1 — the
 *  boot-menu row "Blender dev lanes"). Off = every Blender surface absent. */
export function mercuryBlenderEnabled(): boolean {
  return flagEnabled('MERCURY_BLENDER')
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface BlendDiscovery {
  /** Relative .blend paths, deterministic order, capped. */
  files: string[]
  /** Total found before the cap. */
  total: number
  truncated: number
}

/** Bounded deterministic .blend walk from `from` (the godot walkScenes
 *  sibling): lexicographic DFS, hidden/VCS dirs skipped, capped, total
 *  counted honestly. */
export function discoverBlendFiles(from: string = getCwd()): BlendDiscovery {
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
      } else if (e.isFile() && e.name.endsWith('.blend')) {
        total++
        if (files.length < BLEND_FILE_CAP) {
          files.push(rel ? `${rel}/${e.name}` : e.name)
        }
      }
    }
  }
  walk(path.resolve(from), '')
  return { files, total, truncated: Math.max(0, total - files.length) }
}

export interface BlenderLocation {
  path: string
  source: 'pin' | 'path' | 'app-bundle' | 'program-files'
}

export interface BlenderCensus {
  blender?: BlenderLocation
  /** MERCURY_BLENDER_BIN set but not an existing file. */
  pinError?: string
}

/** The darwin app-bundle executables probed (the NORMAL Mac install). */
export function blenderAppBundleCandidates(home: string = homedir()): string[] {
  return [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    path.join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
  ]
}

/** Numeric-aware descending order for 'Blender 4.5'-style dir names. */
function compareBlenderDirsDesc(a: string, b: string): number {
  const num = (s: string): number[] =>
    (s.match(/\d+/g) ?? []).map(n => Number.parseInt(n, 10))
  const as = num(a)
  const bs = num(b)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (bs[i] ?? -1) - (as[i] ?? -1)
    if (d !== 0) return d
  }
  return a < b ? 1 : a > b ? -1 : 0
}

/**
 * LOCATE Blender — filesystem facts only. Pin (exclusive) → PATH → the
 * darwin app bundles → the win32 Program Files version dirs.
 * @param testOpts proof seam: candidate overrides + PATH-probe skip.
 */
export function locateBlender(testOpts?: {
  appBundles?: string[]
  programFilesRoot?: string
  skipPathProbe?: boolean
  platform?: NodeJS.Platform
}): BlenderCensus {
  const platform = testOpts?.platform ?? process.platform
  const pin = flagEnv('MERCURY_BLENDER_BIN')
  if (pin && pin.trim() !== '') {
    if (isFile(pin)) return { blender: { path: pin, source: 'pin' } }
    return {
      pinError: `MERCURY_BLENDER_BIN set but ${pin} is not an existing file — the pin names itself, no silent fallback`,
    }
  }
  if (!testOpts?.skipPathProbe) {
    const onPath = whichSync('blender')
    if (onPath) return { blender: { path: onPath, source: 'path' } }
  }
  if (platform === 'darwin') {
    for (const candidate of testOpts?.appBundles ?? blenderAppBundleCandidates()) {
      if (isFile(candidate)) return { blender: { path: candidate, source: 'app-bundle' } }
    }
  }
  if (platform === 'win32') {
    const root =
      testOpts?.programFilesRoot ??
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')
    let dirs: string[] = []
    try {
      dirs = readdirSync(root).filter(name => isDir(path.join(root, name)))
    } catch {
      /* no Blender Foundation dir */
    }
    dirs.sort(compareBlenderDirsDesc)
    for (const dir of dirs) {
      const exe = path.join(root, dir, 'blender.exe')
      if (isFile(exe)) return { blender: { path: exe, source: 'program-files' } }
    }
  }
  return {}
}

export interface BlenderVersionProbe {
  version?: string
  reason?: string
}

let versionCache: { at: number; bin: string; result: BlenderVersionProbe } | null = null
const VERSION_CACHE_TTL_MS = 30_000

/** TEST-ONLY: drop the version-probe cache. */
export function _resetBlenderVersionProbeForTesting(): void {
  versionCache = null
}

/** Bounded `blender --version` probe (the gdb-probe shape): 5s timeout,
 *  30s cache, first-line parse — a hung or foreign binary answers a
 *  reason, never a hang or a throw. */
export function probeBlenderVersion(bin: string): BlenderVersionProbe {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_CACHE_TTL_MS) {
    return versionCache.result
  }
  let result: BlenderVersionProbe
  try {
    // env spread is load-bearing under Bun (the recorded house lesson).
    const r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 5_000, encoding: 'utf8', env: { ...subprocessEnv() } })
    const firstLine = (r.stdout ?? '').split('\n')[0] ?? ''
    const m = firstLine.match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/)
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      result = { reason: 'blender --version timed out after 5s — the binary hangs; check the install' }
    } else if (r.status !== 0 || !m || m[1] === undefined) {
      result = { reason: `blender --version unparseable: ${firstLine.slice(0, 80) || `exit ${r.status ?? 'null'}`}` }
    } else {
      result = { version: m[1] }
    }
  } catch (e) {
    result = { reason: `blender probe failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  versionCache = { at: Date.now(), bin, result }
  return result
}

/** The install remedy every absent surface speaks (the operator's act). */
export const BLENDER_INSTALL_REMEDY =
  'install Blender (blender.org/download — /Applications/Blender.app is the normal Mac install, nothing lands on PATH) or pin a binary with MERCURY_BLENDER_BIN; Mercury never installs or launches it for you'

export interface BlenderContextProfile {
  state: 'ok'
  from: string
  blendFiles: BlendDiscovery
  blender?: BlenderLocation
  /** --version truth when a binary was located (probe-class spawn). */
  version?: string
  pinError?: string
  /** One honest sentence for teaching surfaces. */
  detail: string
}

/** The fused Blender context record (never throws; absence is a STATE
 *  described in `detail`). NOT gated on MERCURY_BLENDER itself — gating
 *  lives at each consumer surface (readiness rows, profiles, the menu). */
export function buildBlenderContextProfile(from: string = getCwd()): BlenderContextProfile {
  const blendFiles = discoverBlendFiles(from)
  const census = locateBlender()
  let version: string | undefined
  let detail: string
  if (census.pinError) {
    detail = census.pinError
  } else if (census.blender) {
    const probe = probeBlenderVersion(census.blender.path)
    version = probe.version
    detail = probe.version
      ? `Blender ${probe.version} located (${census.blender.source}): ${census.blender.path}`
      : `blender located (${census.blender.source}) at ${census.blender.path} — version unknown (${probe.reason ?? 'unprobed'})`
  } else {
    detail = `no Blender located — ${BLENDER_INSTALL_REMEDY}`
  }
  return {
    state: 'ok',
    from: path.resolve(from),
    blendFiles,
    ...(census.blender ? { blender: census.blender } : {}),
    ...(version ? { version } : {}),
    ...(census.pinError ? { pinError: census.pinError } : {}),
    detail,
  }
}

/**
 * Readiness rows for the Blender lane — EMPTY while disarmed (the opt-in
 * off contract). Armed: located ⇒ configured naming path+version;
 * absent ⇒ unavailable with the install remedy; broken pin ⇒ unavailable
 * naming the pin.
 */
export function blenderLaneReadinessRecords(): Array<{
  id: string
  kind: 'lane'
  label: string
  state: 'configured' | 'unavailable'
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
}> {
  if (!mercuryBlenderEnabled()) return []
  const at = Date.now()
  const base = {
    id: 'lane:blender',
    kind: 'lane' as const,
    label: 'Blender lane',
    source: 'blender location census (pin > PATH > app bundle > Program Files)',
    lastCheckedAt: at,
  }
  const census = locateBlender()
  if (census.pinError) {
    return [
      {
        ...base,
        state: 'unavailable',
        detail: census.pinError,
        remedy: BLENDER_INSTALL_REMEDY,
      },
    ]
  }
  if (!census.blender) {
    return [
      {
        ...base,
        state: 'unavailable',
        detail: 'no blender binary located (PATH, /Applications, Program Files)',
        remedy: BLENDER_INSTALL_REMEDY,
      },
    ]
  }
  const probe = probeBlenderVersion(census.blender.path)
  return [
    {
      ...base,
      state: 'configured',
      detail:
        `${probe.version ? `Blender ${probe.version}` : 'blender (version unknown)'} at ` +
        `${census.blender.path} (${census.blender.source}) — headless profiles + the debugpy attach recipe ride it; runs are the operator's act`,
    },
  ]
}
