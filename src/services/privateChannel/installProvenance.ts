
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { resolveLayoutRoots } from './installLayout.js'

export type InstallProvenanceKind =
  | 'managed'
  | 'extracted-release'
  | 'development'
  | 'unknown'

export interface InstallProvenanceV1 {
  v: 1
  kind: InstallProvenanceKind
  version: string
  buildSha?: string
  activeRoot: string
  invokedPath: string
  updateOwner: 'private-channel' | 'source-build' | 'release-archive' | 'none-known'
  evidence: string[]
  disagreements: string[]
  managedCoResident?: { root: string; current: string | null }
}

export interface InstallProbeFacts {
  invokedPath: string
  isWindows: boolean
  entryVersionDir: string | null
  entryVersion: string | null
  currentPointer: string | null
  currentPointerState: 'ok' | 'missing' | 'unreadable'
  pointerTargetExists: boolean
  entryManifestPresent: boolean
  entryLaunchersPresent: boolean
  devMarkersPresent: boolean
  managedCoResident: { root: string; current: string | null } | null
  version: string
  buildSha?: string
}

export function classifyInstallProvenance(f: InstallProbeFacts): InstallProvenanceV1 {
  const base = {
    v: 1 as const,
    version: f.version,
    ...(f.buildSha ? { buildSha: f.buildSha } : {}),
    invokedPath: f.invokedPath,
  }

  if (f.entryVersionDir !== null) {
    if (!f.entryManifestPresent) {
      return {
        ...base,
        kind: 'unknown',
        activeRoot: f.entryVersionDir,
        updateOwner: 'none-known',
        evidence: [
          `entry runs inside a versions layout (${f.entryVersionDir})`,
          'payload manifest.json is MISSING beside the bundle — conflicting evidence',
        ],
        disagreements: ['versions layout without its payload manifest'],
      }
    }
    const disagreements: string[] = []
    if (f.currentPointerState === 'missing') {
      disagreements.push('no current.txt pointer beside the versions layout')
    } else if (f.currentPointerState === 'unreadable') {
      disagreements.push('current.txt is unreadable')
    } else if (f.currentPointer !== null && f.currentPointer !== f.entryVersion) {
      disagreements.push(
        `direct versioned invocation: running ${f.entryVersion ?? '?'} while current.txt names ${f.currentPointer}`,
      )
    }
    if (f.currentPointerState === 'ok' && !f.pointerTargetExists) {
      disagreements.push(`stale pointer: current.txt names ${f.currentPointer} but its version dir is missing`)
    }
    return {
      ...base,
      kind: 'managed',
      activeRoot: f.entryVersionDir,
      updateOwner: 'private-channel',
      evidence: [
        `entry bound to the versions layout at ${f.entryVersionDir} (IP-18: the running path, not pointer presence)`,
        'payload manifest present beside the bundle',
        ...(f.currentPointerState === 'ok' && f.currentPointer === f.entryVersion
          ? [`current.txt confirms ${f.currentPointer}`]
          : []),
      ],
      disagreements,
    }
  }

  if (f.devMarkersPresent) {
    return {
      ...base,
      kind: 'development',
      activeRoot: dirname(f.invokedPath),
      updateOwner: 'source-build',
      evidence: ['build.ts + src/ + .git above the entry — a confirmed source checkout (IP-04)'],
      disagreements: [],
    }
  }

  if (f.entryManifestPresent && f.entryLaunchersPresent) {
    return {
      ...base,
      kind: 'extracted-release',
      activeRoot: dirname(f.invokedPath),
      updateOwner: 'release-archive',
      evidence: ['complete release payload run in place (bundle + manifest + launchers, IP-03)'],
      disagreements: [],
      ...(f.managedCoResident ? { managedCoResident: f.managedCoResident } : {}),
    }
  }

  return {
    ...base,
    kind: 'unknown',
    activeRoot: f.invokedPath ? dirname(f.invokedPath) : '',
    updateOwner: 'none-known',
    evidence: [
      f.invokedPath
        ? 'no managed layout, no dev markers, no complete release payload beside the entry'
        : 'no entry path to classify',
    ],
    disagreements: [],
    ...(f.managedCoResident ? { managedCoResident: f.managedCoResident } : {}),
  }
}

function containedIn(root: string, p: string, isWindows: boolean): boolean {
  const norm = (x: string): string => {
    const r = resolve(x)
    return isWindows ? r.toLowerCase() : r
  }
  const r = norm(root)
  const t = norm(p)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function readPointer(path: string): { value: string | null; state: 'ok' | 'missing' | 'unreadable' } {
  try {
    if (!existsSync(path)) return { value: null, state: 'missing' }
    const raw = readFileSync(path, 'utf8').trim()
    return raw ? { value: raw, state: 'ok' } : { value: null, state: 'unreadable' }
  } catch {
    return { value: null, state: 'unreadable' }
  }
}

export function gatherInstallProbeFacts(overrides?: {
  invokedPath?: string
  platform?: NodeJS.Platform
  versionsDir?: string
}): InstallProbeFacts {
  const platform = overrides?.platform ?? process.platform
  const isWindows = platform === 'win32'
  const rawInvoked = overrides?.invokedPath ?? process.argv[1] ?? ''
  const invokedPath = rawInvoked ? realpathSafe(rawInvoked) : ''
  const entryDir = invokedPath ? dirname(invokedPath) : ''

  const version =
    typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : 'dev'
  const buildSha =
    typeof MACRO !== 'undefined' && typeof (MACRO as { BUILD_SHA?: string }).BUILD_SHA === 'string'
      ? (MACRO as { BUILD_SHA?: string }).BUILD_SHA
      : undefined

  const versionsDir = realpathSafe(
    overrides?.versionsDir ?? resolveLayoutRoots(platform).versionsDir,
  )

  let entryVersionDir: string | null = null
  let entryVersion: string | null = null
  if (invokedPath && containedIn(versionsDir, invokedPath, isWindows)) {
    const rel = resolve(invokedPath).slice(resolve(versionsDir).length).replace(/^[/\\]+/, '')
    const seg = rel.split(/[/\\]/)[0]
    if (seg && seg !== 'current.txt' && seg !== 'previous.txt') {
      entryVersion = seg
      entryVersionDir = join(versionsDir, seg)
    }
  }

  const pointer = readPointer(join(versionsDir, 'current.txt'))
  const pointerTargetExists =
    pointer.state === 'ok' && pointer.value !== null
      ? existsSync(join(versionsDir, pointer.value))
      : false

  const entryManifestPresent = entryDir ? existsSync(join(entryDir, 'manifest.json')) : false
  const entryLaunchersPresent = entryDir
    ? ['mercury', 'mercury.cmd', 'mercury.ps1', 'mercury.sh'].some(l => existsSync(join(entryDir, l)))
    : false

  let devMarkersPresent = false
  if (entryDir) {
    for (const root of [dirname(entryDir), dirname(dirname(entryDir))]) {
      if (
        existsSync(join(root, 'build.ts')) &&
        existsSync(join(root, 'src')) &&
        existsSync(join(root, '.git'))
      ) {
        devMarkersPresent = true
        break
      }
    }
  }

  let managedCoResident: { root: string; current: string | null } | null = null
  if (entryVersionDir === null) {
    const co = readPointer(join(versionsDir, 'current.txt'))
    if (co.state === 'ok' && co.value && existsSync(join(versionsDir, co.value))) {
      managedCoResident = { root: versionsDir, current: co.value }
    }
  }

  return {
    invokedPath,
    isWindows,
    entryVersionDir,
    entryVersion,
    currentPointer: pointer.value,
    currentPointerState: pointer.state,
    pointerTargetExists,
    entryManifestPresent,
    entryLaunchersPresent,
    devMarkersPresent,
    managedCoResident,
    version,
    ...(buildSha ? { buildSha } : {}),
  }
}

let memoized: InstallProvenanceV1 | null = null

export function resolveInstallProvenance(): InstallProvenanceV1 {
  if (memoized) return memoized
  try {
    memoized = classifyInstallProvenance(gatherInstallProbeFacts())
  } catch {
    memoized = {
      v: 1,
      kind: 'unknown',
      version: typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : 'dev',
      activeRoot: '',
      invokedPath: process.argv[1] ?? '',
      updateOwner: 'none-known',
      evidence: ['provenance probe threw — no evidence either way'],
      disagreements: [],
    }
  }
  return memoized
}

export function _resetInstallProvenanceForProofs(): void {
  memoized = null
}

export function provenanceGuidance(p: InstallProvenanceV1): string {
  switch (p.kind) {
    case 'managed':
      return 'update with `mercury update` (check: `mercury update --check`; rollback: `mercury update --rollback`)'
    case 'development':
      return 'rebuild with `git pull && bun run build.ts`'
    case 'extracted-release':
      return 'update by extracting a newer release archive in place, or adopt the managed layout with `mercury install`'
    case 'unknown':
      return 'installation shape unrecognized — adopt the managed layout with `mercury install` for update support'
  }
}

export function provenanceLine(p: InstallProvenanceV1): string {
  const co = p.managedCoResident
    ? ` · co-resident managed install: ${p.managedCoResident.current} at ${basename(p.managedCoResident.root)}`
    : ''
  const dis = p.disagreements.length > 0 ? ` · ${p.disagreements.join(' · ')}` : ''
  return `${p.kind} ${p.version}${p.buildSha ? ` (${p.buildSha.slice(0, 9)})` : ''} at ${p.activeRoot}${co}${dis}`
}


export const PROVENANCE_NOTICE_MARKER_PREFIX = 'provenance-noted-'

export function provenanceNoticeMarkerPath(payloadDir: string): string | null {
  const dir = realpathSafe(payloadDir)
  const parent = dirname(dir)
  if (!existsSync(join(parent, 'current.txt'))) return null
  return join(parent, `${PROVENANCE_NOTICE_MARKER_PREFIX}${basename(dir)}.txt`)
}

export function provenanceNoticeSaid(payloadDir: string, state: string): boolean {
  const marker = provenanceNoticeMarkerPath(payloadDir)
  if (marker === null) return false
  try {
    return readFileSync(marker, 'utf8').split('\n')[0]?.trim() === state
  } catch {
    return false
  }
}

export function recordProvenanceNotice(payloadDir: string, state: string): void {
  const marker = provenanceNoticeMarkerPath(payloadDir)
  if (marker === null) return
  try {
    writeFileSync(marker, `${state}\n${new Date().toISOString()}\n`)
  } catch {
  }
}
