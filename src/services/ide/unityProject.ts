
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { projectHomeStore } from '../../utils/projectHomeStores.js'
import { whichSync } from '../../utils/which.js'

const ROOT_WALK_LIMIT = 24

export function mercuryUnityEnabled(): boolean {
  return flagEnabled('MERCURY_UNITY')
}

export const UNITY_LICENSE_DISCLAIMER =
  "Unity's own licensing applies to headless editor runs (batch mode is subject to Unity's Terms of Service); if the editor exits with its licensing error, activating a license is yours to do — Unity Hub, or -serial with -batchmode. Mercury never checks or manages Unity licenses."

export function unityTestResultsPath(root: string, mode: 'EditMode' | 'PlayMode'): string {
  return path.join(projectHomeStore(root, 'unity-test-results'), `${mode.toLowerCase()}.xml`)
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
  version?: string
  versionWithRevision?: string
  reason?: string
}

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
  version?: string
  path: string
  source: 'pin' | 'hub' | 'path'
}

export interface UnityEditorCensus {
  editors: UnityEditorLocation[]
  pinError?: string
}

export function unityHubRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['/Applications/Unity/Hub/Editor']
  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    return [path.join(programFiles, 'Unity', 'Hub', 'Editor')]
  }
  return [path.join(homedir(), 'Unity', 'Hub', 'Editor')]
}

function editorExecutableIn(versionDir: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return path.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity')
  }
  if (platform === 'win32') return path.join(versionDir, 'Editor', 'Unity.exe')
  return path.join(versionDir, 'Editor', 'Unity')
}

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
  markers: string[]
  projectVersion: UnityProjectVersion
  editors: UnityEditorLocation[]
  pinError?: string
  projectEditor?: UnityEditorLocation
  editorDetail: string
}

export interface UnityProjectAbsent {
  state: 'absent'
  detail: string
}

export type UnityProjectResult = UnityProjectProfile | UnityProjectAbsent

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
