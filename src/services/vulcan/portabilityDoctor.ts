
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { delimiter, join } from 'path'
import { projectConfigCandidates } from '../../utils/projectConfig.js'
import {
  censusPlatform,
  editorsForProject,
  isGodotExecutable,
  runningGodotProcesses,
  type CensusPlatform,
  type GodotProcess,
} from './godotProcessCensus.js'

export interface AbsolutePathFinding {
  skillFile: string
  line: number
  text: string
}

export interface ControlDiscrepancy {
  skillFile: string
  declaredNotLive: string[]
  liveNotDeclared: string[]
}

export interface ExecutableReceipt {
  resolved?: string
  source: 'running-editor' | 'PATH' | 'well-known-location' | 'not-found'
  note: string
  probed: string[]
}

export interface SemanticLaunch {
  skillFile: string
  scene?: string
}

export interface PortabilityReport {
  absolutePaths: AbsolutePathFinding[]
  controlDiscrepancies: ControlDiscrepancy[]
  executable: ExecutableReceipt
  semanticLaunches: SemanticLaunch[]
}

const ABS_PATH_RE = /(?:\/(?:Users|home|Volumes)\/[^\s"'`)\]]+|[A-Za-z]:\\[^\s"'`)\]]+|\\\\[^\s"'`)\]]+)/g

export function liveInputActions(projectGodotText: string): string[] {
  const m = /\[input\]([^]*?)(?:\n\[[^\]]+\]|$)/.exec(projectGodotText)
  if (!m) return []
  return [...m[1]!.matchAll(/^([A-Za-z0-9_.]+)\s*=/gm)].map(x => x[1]!)
}

export function declaredControls(skillText: string): string[] {
  const lines = skillText.split('\n')
  const out: string[] = []
  let inControls = false
  for (const line of lines) {
    if (/^#+\s.*(controls|input)/i.test(line)) {
      inControls = true
      continue
    }
    if (/^#+\s/.test(line)) inControls = false
    if (inControls) {
      const m = /^\|\s*([A-Za-z0-9_.]+)\s*\|/.exec(line)
      if (m && !/^-+$/.test(m[1]!) && m[1]!.toLowerCase() !== 'action') out.push(m[1]!)
    }
  }
  return out
}

export function semanticLaunchOf(skillText: string): string | undefined {
  const res = /res:\/\/[^\s"'`)\]]+\.tscn/.exec(skillText)
  if (res) return res[0]
  const bare = /(?:^|[\s"'`(=])([A-Za-z0-9_./\\-]+\.tscn)/m.exec(skillText)
  return bare ? bare[1]!.split(/[/\\]/).pop() : undefined
}


export function godotWellKnownRoots(platform: CensusPlatform, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = []
  const add = (...parts: Array<string | undefined>): void => {
    if (parts.some(p => !p)) return
    const root = join(...(parts as string[]))
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
    add(env.SCOOP ?? (home ? join(home, 'scoop') : undefined), 'shims')
    add(env.SCOOP ?? (home ? join(home, 'scoop') : undefined), 'apps', 'godot', 'current')
    add(env.ChocolateyInstall ?? (env.ProgramData ? join(env.ProgramData, 'chocolatey') : undefined), 'bin')
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

export interface RootWalkFs {
  list(dir: string): string[]
  isDir(p: string): boolean
  executable(p: string): boolean
}

const realRootWalkFs: RootWalkFs = {
  list(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isDir(p) {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  executable(p) {
    try {
      accessSync(p, constants.X_OK)
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
}

function candidateTier(name: string): number {
  const lower = name.toLowerCase()
  if (lower.includes('console')) return 2
  const bare = lower === 'godot' || lower === 'godot.exe' || lower === 'godot4' || lower === 'godot4.exe'
  return bare ? 0 : 1
}

function compareCandidates(a: { name: string }, b: { name: string }): number {
  const tier = candidateTier(a.name) - candidateTier(b.name)
  if (tier !== 0) return tier
  return b.name.toLowerCase().localeCompare(a.name.toLowerCase())
}

export function findGodotInRoot(root: string, platform: CensusPlatform, fs: RootWalkFs = realRootWalkFs): string | undefined {
  const candidates: Array<{ name: string; path: string }> = []
  for (const name of fs.list(root)) {
    const full = join(root, name)
    const lower = name.toLowerCase()
    if (platform === 'darwin' && lower.startsWith('godot') && lower.endsWith('.app')) {
      const bin = join(full, 'Contents', 'MacOS', 'Godot')
      if (fs.executable(bin)) candidates.push({ name, path: bin })
      continue
    }
    if (platform === 'win32' && lower.startsWith('godotengine.') && fs.isDir(full)) {
      const inner = findGodotInRoot(full, platform, fs)
      if (inner) candidates.push({ name, path: inner })
      continue
    }
    if (!isGodotExecutable(name)) continue
    if (platform === 'win32' && !lower.endsWith('.exe')) continue
    if (fs.isDir(full)) continue
    if (fs.executable(full)) candidates.push({ name, path: full })
  }
  candidates.sort(compareCandidates)
  return candidates[0]?.path
}

export interface ResolveGodotOptions {
  platform?: CensusPlatform
  env?: NodeJS.ProcessEnv
  census?: GodotProcess[]
  projectRoot?: string
  fs?: RootWalkFs
}

export async function resolveGodotExecutable(opts: ResolveGodotOptions = {}): Promise<ExecutableReceipt> {
  const platform = opts.platform ?? censusPlatform()
  const env = opts.env ?? process.env
  const fs = opts.fs ?? realRootWalkFs
  const census = opts.census ?? (await runningGodotProcesses({ platform }))
  const probed = godotWellKnownRoots(platform, env)

  const mine = opts.projectRoot ? editorsForProject(census, opts.projectRoot, platform).filter(p => p.project) : []
  if (mine[0]) {
    return { resolved: mine[0].executable, source: 'running-editor', note: `the running editor's own executable (pid ${mine[0].pid}, this project)`, probed }
  }
  const names = platform === 'win32' ? ['godot.exe', 'godot4.exe'] : ['godot', 'godot4']
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (fs.executable(candidate)) return { resolved: candidate, source: 'PATH', note: `resolved via PATH (${dir})`, probed }
    }
  }
  for (const root of probed) {
    const found = findGodotInRoot(root, platform, fs)
    if (found) return { resolved: found, source: 'well-known-location', note: `resolved under ${root}`, probed }
  }
  const any = census.find(p => p.editor) ?? census[0]
  if (any) {
    return {
      resolved: any.executable,
      source: 'running-editor',
      note: `a running Godot process's own executable (pid ${any.pid}${any.project ? `, project ${any.project}` : ''})`,
      probed,
    }
  }
  return {
    source: 'not-found',
    note: `no godot executable on PATH, under ${probed.length} well-known root(s), or running — install Godot or add it to PATH`,
    probed,
  }
}

function projectSkillFiles(projectRoot: string): string[] {
  const out: string[] = []
  for (const dir of projectConfigCandidates(projectRoot, 'skills')) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const skillMd = join(dir, e, 'SKILL.md')
      if (existsSync(skillMd)) out.push(skillMd)
    }
  }
  return out
}

export async function godotPortabilityReport(projectRoot: string, opts: { census?: GodotProcess[] } = {}): Promise<PortabilityReport> {
  const report: PortabilityReport = {
    absolutePaths: [],
    controlDiscrepancies: [],
    executable: await resolveGodotExecutable({ projectRoot, ...(opts.census ? { census: opts.census } : {}) }),
    semanticLaunches: [],
  }
  let live: string[] = []
  try {
    live = liveInputActions(readFileSync(join(projectRoot, 'project.godot'), 'utf8'))
  } catch {
  }
  for (const skillFile of projectSkillFiles(projectRoot)) {
    let text: string
    try {
      text = readFileSync(skillFile, 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(ABS_PATH_RE)) {
        report.absolutePaths.push({ skillFile, line: i + 1, text: m[0] })
      }
    })
    const declared = declaredControls(text)
    if (declared.length > 0) {
      const declaredNotLive = declared.filter(a => !live.includes(a))
      const liveNotDeclared = live.filter(a => !declared.includes(a))
      if (declaredNotLive.length > 0 || liveNotDeclared.length > 0) {
        report.controlDiscrepancies.push({ skillFile, declaredNotLive, liveNotDeclared })
      }
    }
    const scene = semanticLaunchOf(text)
    if (scene) report.semanticLaunches.push({ skillFile, scene })
  }
  return report
}
