// ============================================================================
//  ide/unityProject — ONE owner for Unity project + editor-location truth
//  (MERCURY_UNITY, opt-in default-OFF per the operator's arming ruling).
//
//  The Godot sibling (services/lsp/godotLane.ts) set the shape: a pure
//  detection owner every Unity surface reads — the C# language lane, the
//  unity DAP adapter row, the headless launch profiles and the doctor rows
//  all speak THIS module's facts, never a re-derivation. Nothing here
//  executes or installs anything: the Unity editor is LOCATED (filesystem
//  facts only) so teaching lines can name a concrete path — running it is
//  always the operator's act.
//
//    · project root — nearest ancestor carrying BOTH Assets/ and
//      ProjectSettings/ directories (the project.godot sibling; either dir
//      alone is a common false positive in non-Unity repos);
//    · version — ProjectSettings/ProjectVersion.txt `m_EditorVersion: <v>`
//      (+ optional m_EditorVersionWithRevision), the YAML-line format
//      (sources, read 2026-08-29: game-ci/unity-builder#162; the
//      Unity-Technologies sample repos carry the same two-line shape).
//      Unreadable/merge-conflicted files answer undefined + reason, never a
//      throw (the ProjectVersion merge-conflict class is a known Unity
//      issue-tracker entry).
//    · editor location — explicit MERCURY_UNITY_EDITOR pin (AUTHORITATIVE;
//      a broken pin refuses naming the pin — the pyright pin-honesty law),
//      else the Unity Hub default install roots per OS
//      (read 2026-08-29 from docs.unity.com/hub install-hub + add-editor and
//      the Hub CLI examples: darwin /Applications/Unity/Hub/Editor/<ver>/
//      Unity.app, win32 %ProgramFiles%\Unity\Hub\Editor\<ver>\Editor\
//      Unity.exe, linux ~/Unity/Hub/Editor/<ver>/Editor/Unity), else a PATH
//      `unity`/`Unity` binary. Version census pin: Unity 6.3 LTS is the
//      current LTS (unity.com/releases/unity-6/support, read 2026-08-29);
//      nothing here is version-gated — the facts hold for every Hub-managed
//      install.
//
//  Proof: scripts/ide/prove-unity-project.ts (cpu-pure, fixture-driven —
//  scratch trees + fake hub roots; no Unity anywhere near the pins).
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { MERCURY_PROJECT_DIR } from '../../utils/projectConfig.js'
import { whichSync } from '../../utils/which.js'

const ROOT_WALK_LIMIT = 24

/** Master gate for the Unity dev lanes (opt-in: MERCURY_UNITY=1 — the
 *  boot-menu row "Unity dev lanes"). Off = every Unity surface absent,
 *  identical to a build without it. */
export function mercuryUnityEnabled(): boolean {
  return flagEnabled('MERCURY_UNITY')
}

/**
 * THE LICENSE DISCLAIMER (operator ruling, binding): honest words at the
 * docs/refusal surfaces and NOTHING else — Mercury never probes, detects,
 * or manages Unity licensing. When a headless run fails with Unity's own
 * licensing error ("No valid Unity Editor license found. Please activate
 * your license."), that error passes through verbatim and this sentence
 * rides beside it. Batch-mode use is subject to Unity's Terms of Service
 * (docs.unity3d.com EditorCommandLineArguments, read 2026-08-29).
 */
export const UNITY_LICENSE_DISCLAIMER =
  "Unity's own licensing applies to headless editor runs (batch mode is subject to Unity's Terms of Service); if the editor exits with its licensing error, activating a license is yours to do — Unity Hub, or -serial with -batchmode. Mercury never checks or manages Unity licenses."

/** The results-XML convention the unity test profiles write and the
 *  results parser reads: <root>/<project-dir>/unity-test-results/<mode>.xml
 *  — the project-dir basename rides its one owner (projectConfig). */
export function unityTestResultsPath(root: string, mode: 'EditMode' | 'PlayMode'): string {
  return path.join(root, MERCURY_PROJECT_DIR, 'unity-test-results', `${mode.toLowerCase()}.xml`)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Nearest ancestor (including `from` itself) carrying BOTH Assets/ and
 *  ProjectSettings/ directories — the Unity project root markers. */
export function findUnityProjectRoot(from: string = getCwd()): string | undefined {
  let dir = path.resolve(from)
  for (let depth = 0; depth < ROOT_WALK_LIMIT; depth++) {
    if (isDir(path.join(dir, 'Assets')) && isDir(path.join(dir, 'ProjectSettings'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export interface UnityProjectVersion {
  /** m_EditorVersion, e.g. '6000.3.4f1'. */
  version?: string
  /** m_EditorVersionWithRevision verbatim, when the second line exists. */
  versionWithRevision?: string
  /** Why version is absent (unreadable / unparseable), for honest surfaces. */
  reason?: string
}

/**
 * Parse <root>/ProjectSettings/ProjectVersion.txt — the YAML-line format
 * (`m_EditorVersion: <v>`). BOM and CRLF tolerated; a merge-conflicted or
 * otherwise unparseable file answers a reason, never a throw.
 */
export function readUnityProjectVersion(root: string): UnityProjectVersion {
  const file = path.join(root, 'ProjectSettings', 'ProjectVersion.txt')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { reason: 'ProjectSettings/ProjectVersion.txt unreadable or absent' }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const version = text.match(/^m_EditorVersion:[ \t]*(\S+)[ \t]*\r?$/m)?.[1]
  const withRevision = text
    .match(/^m_EditorVersionWithRevision:[ \t]*(.+?)[ \t]*\r?$/m)?.[1]
  if (!version) {
    return {
      reason:
        'ProjectVersion.txt carries no m_EditorVersion line (merge conflict or foreign format?)',
      ...(withRevision ? { versionWithRevision: withRevision } : {}),
    }
  }
  return { version, ...(withRevision ? { versionWithRevision: withRevision } : {}) }
}

export interface UnityEditorLocation {
  /** The Hub version-directory name ('6000.3.4f1'); undefined for pin/PATH
   *  finds (Mercury never runs a binary to ask it). */
  version?: string
  /** Absolute executable path (existence-checked; NEVER executed here). */
  path: string
  source: 'pin' | 'hub' | 'path'
}

export interface UnityEditorCensus {
  editors: UnityEditorLocation[]
  /** MERCURY_UNITY_EDITOR set but not an existing file — the pin names
   *  itself; no silent fallback ever rides a broken pin. */
  pinError?: string
}

/** The Unity Hub default editor-install roots for this platform (documented
 *  defaults; a custom Hub install location is out of census — the pin env
 *  covers it). */
export function unityHubRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['/Applications/Unity/Hub/Editor']
  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    return [path.join(programFiles, 'Unity', 'Hub', 'Editor')]
  }
  return [path.join(homedir(), 'Unity', 'Hub', 'Editor')]
}

/** <hubRoot>/<version>/ → the editor executable inside, per platform. */
function editorExecutableIn(versionDir: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return path.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity')
  }
  if (platform === 'win32') return path.join(versionDir, 'Editor', 'Unity.exe')
  return path.join(versionDir, 'Editor', 'Unity')
}

/** Numeric-aware descending version-dir order ('6000.10.1f1' above
 *  '6000.9.2f1'); non-numeric segments compare as strings. */
export function compareUnityVersionsDesc(a: string, b: string): number {
  const as = a.split(/[.\-]/)
  const bs = b.split(/[.\-]/)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = as[i] ?? ''
    const bv = bs[i] ?? ''
    if (av === bv) continue
    const an = Number.parseInt(av, 10)
    const bn = Number.parseInt(bv, 10)
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an
    return av < bv ? 1 : -1
  }
  return 0
}

/**
 * LOCATE Unity editors — filesystem facts only, never a spawn, never an
 * install. Pin (exclusive when set) → Hub roots (every version dir whose
 * executable exists, newest first) → PATH.
 *
 * @param testOpts proof seam (scripts/ide/prove-unity-project.ts): fake hub
 *   roots + PATH-probe skip so any box proves the census deterministically.
 */
export function locateUnityEditors(testOpts?: {
  hubRoots?: string[]
  skipPathProbe?: boolean
  platform?: NodeJS.Platform
}): UnityEditorCensus {
  const platform = testOpts?.platform ?? process.platform
  const pin = flagEnv('MERCURY_UNITY_EDITOR')
  if (pin && pin.trim() !== '') {
    if (isFile(pin)) return { editors: [{ path: pin, source: 'pin' }] }
    return {
      editors: [],
      pinError: `MERCURY_UNITY_EDITOR set but ${pin} is not an existing file — the pin names itself, no silent fallback`,
    }
  }
  const editors: UnityEditorLocation[] = []
  for (const root of testOpts?.hubRoots ?? unityHubRoots(platform)) {
    let versionDirs: string[]
    try {
      versionDirs = readdirSync(root).filter(name => isDir(path.join(root, name)))
    } catch {
      continue
    }
    versionDirs.sort(compareUnityVersionsDesc)
    for (const version of versionDirs) {
      const executable = editorExecutableIn(path.join(root, version), platform)
      if (isFile(executable)) editors.push({ version, path: executable, source: 'hub' })
    }
  }
  if (!testOpts?.skipPathProbe) {
    const onPath = whichSync('unity') ?? whichSync('Unity')
    if (onPath && !editors.some(e => e.path === onPath)) {
      editors.push({ path: onPath, source: 'path' })
    }
  }
  return { editors }
}

export interface UnityProjectProfile {
  state: 'ok'
  root: string
  /** Marker evidence for root detection. */
  markers: string[]
  /** ProjectVersion facts (version may be absent WITH its reason). */
  projectVersion: UnityProjectVersion
  /** Every located editor (pin/hub/path), newest hub versions first. */
  editors: UnityEditorLocation[]
  pinError?: string
  /** The located editor whose Hub version EQUALS the project's
   *  m_EditorVersion (a pin matches unconditionally — the operator chose). */
  projectEditor?: UnityEditorLocation
  /** One honest sentence about editor availability for teaching surfaces. */
  editorDetail: string
}

export interface UnityProjectAbsent {
  state: 'absent'
  detail: string
}

export type UnityProjectResult = UnityProjectProfile | UnityProjectAbsent

/**
 * The fused Unity project record every surface reads. Pure filesystem
 * census — bounded, no spawns, never a throw for absence (absent is a
 * STATE). NOT gated on MERCURY_UNITY itself: gating lives at each consumer
 * surface (lane sources, adapter rows, profiles, doctor rows) so the off
 * contract is enforced where surfaces are born.
 */
export function buildUnityProjectProfile(from: string = getCwd()): UnityProjectResult {
  const root = findUnityProjectRoot(from)
  if (!root) {
    return {
      state: 'absent',
      detail: `no Unity project (Assets/ + ProjectSettings/) from ${path.resolve(from)} (walk-up)`,
    }
  }
  const markers = ['Assets/', 'ProjectSettings/']
  if (existsSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'))) {
    markers.push('ProjectSettings/ProjectVersion.txt')
  }
  const projectVersion = readUnityProjectVersion(root)
  const census = locateUnityEditors()
  const pinned = census.editors.find(e => e.source === 'pin')
  const projectEditor =
    pinned ??
    (projectVersion.version
      ? census.editors.find(e => e.version === projectVersion.version)
      : undefined)
  let editorDetail: string
  if (census.pinError) {
    editorDetail = census.pinError
  } else if (projectEditor) {
    editorDetail =
      projectEditor.source === 'pin'
        ? `editor pinned via MERCURY_UNITY_EDITOR: ${projectEditor.path}`
        : `editor ${projectEditor.version ?? '?'} located (${projectEditor.source}): ${projectEditor.path}`
  } else if (census.editors.length > 0) {
    const versions = census.editors
      .map(e => e.version ?? `(unversioned: ${e.path})`)
      .join(', ')
    editorDetail = projectVersion.version
      ? `project wants ${projectVersion.version}; located editors: ${versions} — install the matching version via Unity Hub (Mercury never installs one)`
      : `located editors: ${versions} (project version unknown — ${projectVersion.reason ?? 'no version fact'})`
  } else {
    editorDetail =
      'no Unity editor located (Hub default roots + PATH) — install via Unity Hub, or pin a binary with MERCURY_UNITY_EDITOR (Mercury never installs or runs one itself)'
  }
  return {
    state: 'ok',
    root,
    markers,
    projectVersion,
    editors: census.editors,
    ...(census.pinError ? { pinError: census.pinError } : {}),
    ...(projectEditor ? { projectEditor } : {}),
    editorDetail,
  }
}
