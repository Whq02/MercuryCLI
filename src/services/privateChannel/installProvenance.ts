// ============================================================================
//  installProvenance — the ONE typed install-provenance owner (
//  provenance record family).
//
//  getCurrentInstallationType() was an explicit placeholder returning
//  'source-build' unconditionally — every managed install's health screen
//  claimed a source build and recommended `git pull && bun run build.ts`
//  (the field's false guidance). Provenance now resolves ONCE per process
//  from authoritative layout/payload evidence:
//
//    managed           — the RUNNING entry sits inside the managed
//                        <versions>/<v>/ layout with its payload manifest;
//                        the binding is the entry path itself, never
//                        current.txt presence alone (IP-18). Pointer
//                        disagreements (stale pointer, direct versioned
//                        invocation) stay VISIBLE (IP-13), never reclassify.
//    extracted-release — a complete release payload (bundle + manifest +
//                        launchers) run in place outside a versions layout
//                        (IP-03); a healthy co-resident managed install is
//                        reported separately, never conflated (IP-17).
//    development       — a confirmed source checkout (build.ts + src/ +
//                        .git above the entry) (IP-04).
//    unknown           — missing or conflicting evidence; NEVER
//                        'source-build' by default (IP-05).
//
//  The classifier is PURE over gathered facts (fixture-provable, IP-15);
//  the gatherer is memoized and bounded — a handful of stats, no spawns,
//  nothing per-frame (IP-16). Windows case/separator/realpath equivalence
//  is normalized for CONTAINMENT only — version-string mismatches stay
//  visible (IP-19). The resolver never searches PATH for a launcher by name
//  (IP-12).
// ============================================================================

import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
  /** The active root: versions/<v> for managed, the bundle dir otherwise. */
  activeRoot: string
  invokedPath: string
  /** The update owner appropriate to this shape (IP-07..09). */
  updateOwner: 'private-channel' | 'source-build' | 'release-archive' | 'none-known'
  /** The facts that decided the kind. */
  evidence: string[]
  /** IP-13: pointer/manifest/receipt disagreements — visible, never collapsed. */
  disagreements: string[]
  /** IP-17: a healthy co-resident managed install, reported separately. */
  managedCoResident?: { root: string; current: string | null }
}

export interface InstallProbeFacts {
  invokedPath: string
  isWindows: boolean
  /** The entry's containing versions/<v> dir when inside the managed layout. */
  entryVersionDir: string | null
  entryVersion: string | null
  /** current.txt beside the entry's versions root. */
  currentPointer: string | null
  currentPointerState: 'ok' | 'missing' | 'unreadable'
  /** Does the version dir the pointer names exist? */
  pointerTargetExists: boolean
  /** manifest.json beside the entry bundle. */
  entryManifestPresent: boolean
  /** a mercury launcher beside the entry bundle (release-payload shape). */
  entryLaunchersPresent: boolean
  /** build.ts + src/ + .git above the entry (confirmed checkout). */
  devMarkersPresent: boolean
  /** a healthy managed install at the DEFAULT root, when the entry is elsewhere. */
  managedCoResident: { root: string; current: string | null } | null
  version: string
  buildSha?: string
}

/** The PURE classification (IP-02..05, IP-13, IP-17/18) — fixture-provable. */
export function classifyInstallProvenance(f: InstallProbeFacts): InstallProvenanceV1 {
  const base = {
    v: 1 as const,
    version: f.version,
    ...(f.buildSha ? { buildSha: f.buildSha } : {}),
    invokedPath: f.invokedPath,
  }

  if (f.entryVersionDir !== null) {
    // Inside the managed versions layout: the payload manifest is the
    // authoritative evidence (IP-02); without it the evidence CONFLICTS and
    // the answer is unknown, never a guess (IP-05).
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

/** Containment under `root`, platform-normalized (IP-19): win32 compares
 *  case-insensitively over realpaths; version STRINGS are never normalized. */
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

/** Gather the facts (bounded: a handful of stats, zero spawns — IP-16).
 *  `overrides` is the fixture seam; production passes nothing. */
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

  // Managed containment: <versionsDir>/<v>/... holds the entry (IP-18).
  let entryVersionDir: string | null = null
  let entryVersion: string | null = null
  if (invokedPath && containedIn(versionsDir, invokedPath, isWindows)) {
    // The version segment is the FIRST path element under versionsDir.
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

  // Development markers: dist/<bundle> one level under the checkout root, or
  // a src-tree entry (proof/bun contexts) — build.ts + src/ + .git confirm.
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

  // IP-17: when the entry is NOT the managed layout, report a healthy
  // co-resident managed install separately.
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

/** The ONE process-wide snapshot every consumer takes (IP-01/10/16). */
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

/** Proof seam: drop the memo (never product logic). */
export function _resetInstallProvenanceForProofs(): void {
  memoized = null
}

/** Mode-appropriate update guidance (IP-07..09): `git pull && bun run
 *  build.ts` appears ONLY for a confirmed development checkout. */
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

/** One display line for headers/diagnostics (bug reports, crash guidance). */
export function provenanceLine(p: InstallProvenanceV1): string {
  const co = p.managedCoResident
    ? ` · co-resident managed install: ${p.managedCoResident.current} at ${basename(p.managedCoResident.root)}`
    : ''
  const dis = p.disagreements.length > 0 ? ` · ${p.disagreements.join(' · ')}` : ''
  return `${p.kind} ${p.version}${p.buildSha ? ` (${p.buildSha.slice(0, 9)})` : ''} at ${p.activeRoot}${co}${dis}`
}
