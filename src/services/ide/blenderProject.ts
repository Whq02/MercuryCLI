
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
  files: string[]
  total: number
  truncated: number
}

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
  pinError?: string
}

export function blenderAppBundleCandidates(home: string = homedir()): string[] {
  return [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    path.join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
  ]
}

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

export function _resetBlenderVersionProbeForTesting(): void {
  versionCache = null
}

export function probeBlenderVersion(bin: string): BlenderVersionProbe {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_CACHE_TTL_MS) {
    return versionCache.result
  }
  let result: BlenderVersionProbe
  try {
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

export const BLENDER_INSTALL_REMEDY =
  'install Blender (blender.org/download — /Applications/Blender.app is the normal Mac install, nothing lands on PATH) or pin a binary with MERCURY_BLENDER_BIN; Mercury never installs or launches it for you'

export interface BlenderContextProfile {
  state: 'ok'
  from: string
  blendFiles: BlendDiscovery
  blender?: BlenderLocation
  version?: string
  pinError?: string
  detail: string
}

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
