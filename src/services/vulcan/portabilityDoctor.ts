// ============================================================================
//  portabilityDoctor — project-skill portability diagnosis (,
//  field row: a project skill hard-coded machine-B absolute paths and
//  carried a control table that drifted from the live project.godot
//  [input] section; the launch failed on machine A with no diagnosis).
//
//  Laws:
//   · SEMANTIC launch profile is separate from MACHINE resolution — the
//     scene/mode a skill launches derives without its absolute paths, so
//     two machines with different roots produce the SAME semantic launch;
//   · per-host executable resolution carries a RECEIPT (path + source);
//   · absolute machine paths in project skills are REPORTED (file + line),
//     never rewritten — third-party skills are read-only to Mercury;
//   · declared controls are compared against the LIVE project.godot
//     [input] section — an exact discrepancy list, both directions.
// ============================================================================

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
  /** Actions the skill declares that project.godot does NOT define. */
  declaredNotLive: string[]
  /** Actions project.godot defines that the skill's table omits. */
  liveNotDeclared: string[]
}

export interface ExecutableReceipt {
  resolved?: string
  source: 'PATH' | 'well-known-location' | 'not-found'
  note: string
}

export interface SemanticLaunch {
  skillFile: string
  /** The machine-independent launch fact (scene / mode tokens). */
  scene?: string
}

export interface PortabilityReport {
  absolutePaths: AbsolutePathFinding[]
  controlDiscrepancies: ControlDiscrepancy[]
  executable: ExecutableReceipt
  semanticLaunches: SemanticLaunch[]
}

// Machine-absolute path shapes (POSIX homes + win32 drives + UNC).
const ABS_PATH_RE = /(?:\/(?:Users|home|Volumes)\/[^\s"'`)\]]+|[A-Za-z]:\\[^\s"'`)\]]+|\\\\[^\s"'`)\]]+)/g

/** Parse the [input] section's action names from project.godot text. */
export function liveInputActions(projectGodotText: string): string[] {
  const m = /\[input\]([^]*?)(?:\n\[[^\]]+\]|$)/.exec(projectGodotText)
  if (!m) return []
  return [...m[1]!.matchAll(/^([A-Za-z0-9_.]+)\s*=/gm)].map(x => x[1]!)
}

/** Extract a skill's DECLARED control table: markdown rows `| action | … |`
 *  under a heading mentioning controls/input (the field skill's shape). */
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

/** The machine-independent launch fact: a scene reference survives the
 *  removal of any absolute prefix (res:// or a bare .tscn name). */
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
        /* next */
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
      /* next */
    }
  }
  return { source: 'not-found', note: 'no godot executable on PATH or in well-known locations — install Godot or add it to PATH' }
}

/** Every SKILL.md under the project's skills homes (the one project-config seam). */
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

/** The portability diagnosis. Read-only — never rewrites a skill. */
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
    /* no project file — control comparison silently empty */
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
