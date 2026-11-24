
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { projectConfigCandidates } from '../../platform/settings/projectConfig.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import {
  censusPlatform,
  editorsForProject,
  isGodotExecutable,
  strictGodotCensus,
  type CensusPlatform,
  type GodotProcess,
} from './godotProcessCensus.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { isDirectory } from '../../platform/files/syncFileRead.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { pathModuleFor } from '../../platform/host-os/paths.js'
import { executableName, hostPathDelimiter } from '../../platform/host-os/programs.js'
import {
  godotBinaryNeedsExeSuffix,
  godotWellKnownRootsForPlatform,
  isWinGetGodotPackageDir,
} from '../../platform/host-os/vendors.js'

interface AbsolutePathFinding {
  skillFile: string
  line: number
  text: string
}

interface ControlDiscrepancy {
  skillFile: string
  declaredNotLive: string[]
  liveNotDeclared: string[]
}

interface ExecutableReceipt {
  resolved?: string
  source: 'pin' | 'running-editor' | 'PATH' | 'well-known-location' | 'not-found'
  note: string
  probed: string[]
  censusError?: string
}

interface SemanticLaunch {
  skillFile: string
  scene?: string
}

interface PortabilityReport {
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


function joinerFor(platform: CensusPlatform): (...parts: string[]) => string {
  return pathModuleFor(platform).join
}

export function godotWellKnownRoots(platform: CensusPlatform, env: NodeJS.ProcessEnv = hostEnv()): string[] {
  return godotWellKnownRootsForPlatform(platform, env)
}

interface RootWalkFs {
  list(dir: string): string[]
  isDir(p: string): boolean
  executable(p: string): boolean
}

const realRootWalkFs: RootWalkFs = {
  list(dir) {
    try {
      return readdirSync(dir)
    } catch (error) {
      passedOver(error)
      return []
    }
  },
  isDir: isDirectory,
  executable(p) {
    try {
      accessSync(p, constants.X_OK)
      return statSync(p).isFile()
    } catch (error) {
      passedOver(error)
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

function findGodotInRoot(root: string, platform: CensusPlatform, fs: RootWalkFs = realRootWalkFs): string | undefined {
  const candidates: Array<{ name: string; path: string }> = []
  const joinPath = joinerFor(platform)
  for (const name of fs.list(root)) {
    const full = joinPath(root, name)
    const lower = name.toLowerCase()
    if (platform === 'darwin' && lower.startsWith('godot') && lower.endsWith('.app')) {
      const bin = joinPath(full, 'Contents', 'MacOS', 'Godot')
      if (fs.executable(bin)) candidates.push({ name, path: bin })
      continue
    }
    if (isWinGetGodotPackageDir(lower, platform) && fs.isDir(full)) {
      const inner = findGodotInRoot(full, platform, fs)
      if (inner) candidates.push({ name, path: inner })
      continue
    }
    if (!isGodotExecutable(name)) continue
    if (godotBinaryNeedsExeSuffix(lower, platform)) continue
    if (fs.isDir(full)) continue
    if (fs.executable(full)) candidates.push({ name, path: full })
  }
  candidates.sort(compareCandidates)
  return candidates[0]?.path
}

interface ResolveGodotOptions {
  platform?: CensusPlatform
  env?: NodeJS.ProcessEnv
  census?: GodotProcess[]
  projectRoot?: string
  fs?: RootWalkFs
}

let lastExecutableReceipt: ExecutableReceipt | null = null

function pinnedGodotExecutable(pinned: string | undefined, fs: RootWalkFs, probed: string[]): ExecutableReceipt | null {
  const pin = (pinned ?? '').trim()
  if (pin === '') return null
  if (fs.executable(pin)) return { resolved: pin, source: 'pin', note: 'pinned by MERCURY_GODOT_EXECUTABLE', probed }
  return { source: 'not-found', note: `MERCURY_GODOT_EXECUTABLE names ${pin}, which is not an executable file — fix or unset the pin`, probed }
}

function godotOnPath(platform: CensusPlatform, env: NodeJS.ProcessEnv, fs: RootWalkFs): { path: string; note: string } | undefined {
  const names = ['godot', 'godot4'].map(name => executableName(name, platform))
  const joinPath = joinerFor(platform)
  for (const dir of (env.PATH ?? '').split(hostPathDelimiter(platform)).filter(Boolean)) {
    for (const name of names) {
      const candidate = joinPath(dir, name)
      if (fs.executable(candidate)) return { path: candidate, note: `resolved via PATH (${dir})` }
    }
  }
  return undefined
}

export async function resolveGodotExecutable(opts: ResolveGodotOptions = {}): Promise<ExecutableReceipt> {
  const receipt = await resolveGodotExecutableNow(opts)
  lastExecutableReceipt = receipt
  return receipt
}

async function resolveGodotExecutableNow(opts: ResolveGodotOptions): Promise<ExecutableReceipt> {
  const platform = opts.platform ?? censusPlatform()
  const env = opts.env ?? hostEnv()
  const fs = opts.fs ?? realRootWalkFs
  const probed = godotWellKnownRoots(platform, env)
  const pinned = pinnedGodotExecutable(opts.env === undefined ? flagEnv('MERCURY_GODOT_EXECUTABLE') : flagEnv('MERCURY_GODOT_EXECUTABLE', env), fs, probed)
  if (pinned !== null) return pinned
  let census: GodotProcess[] = []
  let censusError: string | undefined
  if (opts.census !== undefined) {
    census = opts.census
  } else {
    try {
      census = await strictGodotCensus({ platform })
    } catch (error) {
      passedOver(error)
      censusError = `the running Godot processes could not be listed (${error instanceof Error ? error.message : String(error)})`
    }
  }

  const mine = opts.projectRoot ? editorsForProject(census, opts.projectRoot, platform).filter(p => p.project) : []
  if (mine[0]) {
    return { resolved: mine[0].executable, source: 'running-editor', note: `the running editor's own executable (pid ${mine[0].pid}, this project)`, probed }
  }
  const onPath = godotOnPath(platform, env, fs)
  if (onPath !== undefined) return { resolved: onPath.path, source: 'PATH', note: onPath.note, probed, ...(censusError ? { censusError } : {}) }
  for (const root of probed) {
    const found = findGodotInRoot(root, platform, fs)
    if (found) return { resolved: found, source: 'well-known-location', note: `resolved under ${root}`, probed, ...(censusError ? { censusError } : {}) }
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
    note: censusError
      ? `no godot executable on PATH or under ${probed.length} well-known root(s); ${censusError} — install Godot or add it to PATH`
      : `no godot executable on PATH, under ${probed.length} well-known root(s), or running — install Godot or add it to PATH`,
    probed,
    ...(censusError ? { censusError } : {}),
  }
}

type GodotExecutablePresence =
  | { present: true; path: string; source: ExecutableReceipt['source']; note: string }
  | { present: false; note: string; remedy: string }

const PRESENCE_MEMO_MS = 30_000
let presenceMemo: { key: string; at: number; value: GodotExecutablePresence } | null = null

export function _resetGodotExecutablePresenceForTesting(): void {
  presenceMemo = null
  lastExecutableReceipt = null
}

function godotExecutablePresenceNow(): GodotExecutablePresence {
  const platform = censusPlatform()
  const fs = realRootWalkFs
  const probed = godotWellKnownRoots(platform, hostEnv())
  const pinned = pinnedGodotExecutable(flagEnv('MERCURY_GODOT_EXECUTABLE'), fs, probed)
  if (pinned !== null) {
    return pinned.resolved !== undefined
      ? { present: true, path: pinned.resolved, source: pinned.source, note: pinned.note }
      : { present: false, note: pinned.note, remedy: 'point MERCURY_GODOT_EXECUTABLE at the Godot binary, or unset it' }
  }
  const onPath = godotOnPath(platform, hostEnv(), fs)
  if (onPath !== undefined) return { present: true, path: onPath.path, source: 'PATH', note: onPath.note }
  for (const root of probed) {
    const found = findGodotInRoot(root, platform, fs)
    if (found) return { present: true, path: found, source: 'well-known-location', note: `resolved under ${root}` }
  }
  if (lastExecutableReceipt?.resolved !== undefined) {
    return { present: true, path: lastExecutableReceipt.resolved, source: lastExecutableReceipt.source, note: lastExecutableReceipt.note }
  }
  return {
    present: false,
    note: `no Godot executable on PATH or under ${probed.length} well-known install root(s)`,
    remedy: 'install Godot, add it to PATH, or pin it with MERCURY_GODOT_EXECUTABLE',
  }
}

export function godotExecutablePresence(now: number = Date.now()): GodotExecutablePresence {
  const key = [flagEnv('MERCURY_GODOT_EXECUTABLE') ?? '', hostEnv().PATH ?? '', hostEnv().HOME ?? '', hostEnv().USERPROFILE ?? '', lastExecutableReceipt?.resolved ?? ''].join('\u0000')
  if (presenceMemo !== null && presenceMemo.key === key && now - presenceMemo.at < PRESENCE_MEMO_MS) return presenceMemo.value
  const value = godotExecutablePresenceNow()
  presenceMemo = { key, at: now, value }
  return value
}

function projectSkillFiles(projectRoot: string): string[] {
  const out: string[] = []
  for (const dir of projectConfigCandidates(projectRoot, 'skills')) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        passedOver(error)
        continue
      }
      throw error
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    passedOver(error)
  }
  for (const skillFile of projectSkillFiles(projectRoot)) {
    let text: string
    try {
      text = readFileSync(skillFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        passedOver(error)
        continue
      }
      throw error
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
