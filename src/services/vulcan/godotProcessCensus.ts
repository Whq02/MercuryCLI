
import { readlinkSync } from 'node:fs'
import * as path from 'node:path'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'

export type CensusPlatform = 'win32' | 'darwin' | 'linux'

export interface GodotProcess {
  pid: number
  executable: string
  args: string
  editor: boolean
  headless: boolean
  project?: string
}

export interface CensusRunner {
  exec(file: string, args: string[]): Promise<{ code: number; stdout: string }>
  readExeLink?(pid: number): string | undefined
}

const TABLE_TIMEOUT_MS = 8_000

export function censusPlatform(platform: NodeJS.Platform = process.platform): CensusPlatform {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'darwin'
  return 'linux'
}

export function censusCommands(platform: CensusPlatform): Array<{ file: string; args: string[] }> {
  switch (platform) {
    case 'darwin':
      return [
        { file: 'ps', args: ['-axo', 'pid=,comm='] },
        { file: 'ps', args: ['-axo', 'pid=,args='] },
      ]
    case 'linux':
      return [{ file: 'ps', args: ['-eo', 'pid=,args='] }]
    case 'win32':
      return [
        {
          file: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name LIKE 'godot%'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ExecutablePath, $_.CommandLine }",
          ],
        },
      ]
  }
}

export function isGodotExecutable(executable: string): boolean {
  const base = path.basename(executable.trim()).toLowerCase()
  if (base === 'org.godotengine.godot') return true
  return base.startsWith('godot') && !base.includes('-lsp') && !base.includes('helper')
}

function hasFlag(args: string, ...flags: string[]): boolean {
  const tokens = args.split(/\s+/)
  return flags.some(f => tokens.includes(f))
}

export function projectFromArgs(args: string): string | undefined {
  const m = /(?:^|\s)--path(?:=|\s+)(.+?)(?=\s+--?[A-Za-z]|$)/.exec(args)
  if (m?.[1]) return unquote(m[1].trim())
  const pg = /(?:^|\s)"?([^\s"]*(?:[^"]*?))project\.godot"?(?=\s|$)/.exec(args)
  if (pg && pg[0].trim().length > 0) {
    const spelled = unquote(pg[0].trim())
    return path.dirname(spelled)
  }
  return undefined
}

function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
}

function factsOf(pid: number, executable: string, args: string): GodotProcess {
  const project = projectFromArgs(args)
  return {
    pid,
    executable,
    args,
    editor: hasFlag(args, '--editor', '-e', '--import'),
    headless: hasFlag(args, '--headless'),
    ...(project ? { project } : {}),
  }
}


export function parseDarwinCensus(commTable: string, argsTable: string): GodotProcess[] {
  const exeByPid = new Map<number, string>()
  for (const line of commTable.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m && isGodotExecutable(m[2]!)) exeByPid.set(Number(m[1]), m[2]!)
  }
  const out: GodotProcess[] = []
  for (const line of argsTable.split('\n')) {
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const exe = exeByPid.get(pid)
    if (!exe) continue
    const full = m[2]!
    const args = full.startsWith(exe) ? full.slice(exe.length).trim() : full.replace(/^\S+\s*/, '')
    out.push(factsOf(pid, exe, args))
  }
  return out
}

export function parseLinuxCensus(
  argsTable: string,
  readExeLink: (pid: number) => string | undefined = pid => {
    try {
      return readlinkSync(`/proc/${pid}/exe`)
    } catch {
      return undefined
    }
  },
): GodotProcess[] {
  const out: GodotProcess[] = []
  for (const line of argsTable.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const argv0 = m[2]!
    if (!isGodotExecutable(argv0)) continue
    const exe = readExeLink(pid) ?? argv0
    if (!isGodotExecutable(exe)) continue
    out.push(factsOf(pid, exe, m[3] ?? ''))
  }
  return out
}

export function parseWin32Census(table: string): GodotProcess[] {
  const out: GodotProcess[] = []
  for (const raw of table.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const first = line.indexOf('|')
    const second = first >= 0 ? line.indexOf('|', first + 1) : -1
    if (first < 0 || second < 0) continue
    const pid = Number(line.slice(0, first))
    const exe = line.slice(first + 1, second).trim()
    const commandLine = line.slice(second + 1).trim()
    if (!Number.isInteger(pid) || !exe || !isGodotExecutable(exe)) continue
    let args = commandLine
    if (commandLine.startsWith('"')) {
      const close = commandLine.indexOf('"', 1)
      args = close > 0 ? commandLine.slice(close + 1).trim() : ''
    } else {
      args = commandLine.replace(/^\S+\s*/, '')
    }
    out.push(factsOf(pid, exe, args))
  }
  return out
}


const defaultRunner: CensusRunner = {
  async exec(file, args) {
    const r = await execFileNoThrow(file, args, { useCwd: false, timeout: TABLE_TIMEOUT_MS })
    return { code: r.code, stdout: r.stdout }
  },
}

export async function runningGodotProcesses(opts?: {
  platform?: CensusPlatform
  runner?: CensusRunner
}): Promise<GodotProcess[]> {
  const platform = opts?.platform ?? censusPlatform()
  const runner = opts?.runner ?? defaultRunner
  const commands = censusCommands(platform)
  try {
    const outputs: string[] = []
    for (const c of commands) {
      const r = await runner.exec(c.file, c.args)
      if (r.code !== 0) return []
      outputs.push(r.stdout)
    }
    switch (platform) {
      case 'darwin':
        return parseDarwinCensus(outputs[0] ?? '', outputs[1] ?? '')
      case 'linux':
        return parseLinuxCensus(outputs[0] ?? '', runner.readExeLink)
      case 'win32':
        return parseWin32Census(outputs[0] ?? '')
    }
  } catch {
    return []
  }
}

export function sameProjectPath(a: string, b: string, platform: CensusPlatform = censusPlatform()): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (platform === 'win32') s = s.toLowerCase()
    return s
  }
  return norm(a) === norm(b)
}

export function editorsForProject(
  processes: readonly GodotProcess[],
  projectRoot: string,
  platform: CensusPlatform = censusPlatform(),
): GodotProcess[] {
  return processes.filter(p => p.editor && (p.project === undefined || sameProjectPath(p.project, projectRoot, platform)))
}

export function describeGodotProcess(p: GodotProcess): string {
  const role = p.editor ? (p.headless ? 'headless editor' : 'editor') : 'game/other'
  return `pid ${p.pid} ${role}${p.project ? ` on ${p.project}` : ''} — ${p.executable}`
}
