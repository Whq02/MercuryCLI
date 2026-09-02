
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'fs'
import { delimiter, join } from 'path'
import { projectConfigCandidates } from '../../utils/projectConfig.js'

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
  source: 'PATH' | 'well-known-location' | 'not-found'
  note: string
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

function resolveGodotExecutable(): ExecutableReceipt {
  const names = process.platform === 'win32' ? ['godot.exe', 'godot4.exe'] : ['godot', 'godot4']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return { resolved: candidate, source: 'PATH', note: `resolved via PATH (${dir})` }
      } catch {
      }
    }
  }
  const wellKnown =
    process.platform === 'darwin'
      ? ['/Applications/Godot.app/Contents/MacOS/Godot']
      : process.platform === 'win32'
        ? ['C:\\Program Files\\Godot\\godot.exe']
        : ['/usr/local/bin/godot', '/usr/bin/godot']
  for (const candidate of wellKnown) {
    try {
      accessSync(candidate, constants.X_OK)
      return { resolved: candidate, source: 'well-known-location', note: `resolved at ${candidate}` }
    } catch {
    }
  }
  return { source: 'not-found', note: 'no godot executable on PATH or in well-known locations — install Godot or add it to PATH' }
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

export function godotPortabilityReport(projectRoot: string): PortabilityReport {
  const report: PortabilityReport = {
    absolutePaths: [],
    controlDiscrepancies: [],
    executable: resolveGodotExecutable(),
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
