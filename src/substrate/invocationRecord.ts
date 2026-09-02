import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'

export type ShellHint = 'powershell' | 'cmd' | 'posix-sh' | 'unknown'

export interface InvocationCapabilityRecordV1 {
  schema: 1
  pid: number
  recordedAtMs: number
  platform: NodeJS.Platform
  argv0: string
  execBasename: string
  stdinTTY: boolean
  stdoutTTY: boolean
  stderrTTY: boolean
  shellHint: ShellHint
  termProgram?: string
}

interface InvocationFileV1 {
  version: 1
  rows: InvocationCapabilityRecordV1[]
}

const MAX_ROWS = 10

export function classifyShellHint(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellHint {
  if (platform === 'win32') {
    if (typeof env.PSModulePath === 'string' && env.PSModulePath.length > 0) return 'powershell'
    if (typeof env.ComSpec === 'string') return 'cmd'
    return 'unknown'
  }
  if (typeof env.SHELL === 'string' && env.SHELL.length > 0) return 'posix-sh'
  return 'unknown'
}

export function captureInvocationRecord(): InvocationCapabilityRecordV1 {
  return {
    schema: 1,
    pid: process.pid,
    recordedAtMs: Date.now(),
    platform: process.platform,
    argv0: basename(process.argv[0] ?? ''),
    execBasename: basename(process.execPath ?? ''),
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    stderrTTY: process.stderr.isTTY === true,
    shellHint: classifyShellHint(),
    ...(typeof process.env.TERM_PROGRAM === 'string' && process.env.TERM_PROGRAM
      ? { termProgram: process.env.TERM_PROGRAM }
      : {}),
  }
}

export function invocationRecordPath(): string {
  return join(getMercuryHome(), 'invocation-record.json')
}

export function recordInvocation(): InvocationCapabilityRecordV1 {
  const rec = captureInvocationRecord()
  try {
    let rows: InvocationCapabilityRecordV1[] = []
    try {
      const raw = JSON.parse(readFileSync(invocationRecordPath(), 'utf8')) as InvocationFileV1
      if (raw && raw.version === 1 && Array.isArray(raw.rows)) rows = raw.rows
    } catch {
    }
    rows = [...rows, rec].slice(-MAX_ROWS)
    const path = invocationRecordPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, rows } satisfies InvocationFileV1, null, 1)}\n`)
    renameSync(tmp, path)
  } catch {
  }
  return rec
}

export function readInvocationRecords(): InvocationCapabilityRecordV1[] {
  try {
    const raw = JSON.parse(readFileSync(invocationRecordPath(), 'utf8')) as InvocationFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
    return raw.rows
  } catch {
    return []
  }
}
