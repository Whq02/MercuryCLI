// ============================================================================
//  substrate/invocationRecord —
//  the TYPED invocation-capability record across shells. The Windows lanes
//  drill the BEHAVIOR matrix (hostile argv, CRLF/BOM receipts, redirection,
//  caller-state restoration — boot-drill-win.py); this
//  module records WHAT invoked us as a typed, durable, redaction-safe fact
//  so a field packet or doctor read can bind an observed behavior to its
//  exact invocation class instead of guessing from symptoms.
//
//  Pure capture (process/env reads only) + one bounded persisted ring;
//  fail-soft — never a boot dependency. Consumed by the doctor report.
// ============================================================================
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'

export type ShellHint = 'powershell' | 'cmd' | 'posix-sh' | 'unknown'

export interface InvocationCapabilityRecordV1 {
  schema: 1
  pid: number
  recordedAtMs: number
  platform: NodeJS.Platform
  /** basename only — never a full user path (redaction floor). */
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

/** The closed shell classification over ambient facts (pure). */
export function classifyShellHint(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellHint {
  if (platform === 'win32') {
    // PSModulePath is present for BOTH Windows PowerShell and pwsh child
    // environments; ComSpec alone means cmd-family.
    if (typeof env.PSModulePath === 'string' && env.PSModulePath.length > 0) return 'powershell'
    if (typeof env.ComSpec === 'string') return 'cmd'
    return 'unknown'
  }
  if (typeof env.SHELL === 'string' && env.SHELL.length > 0) return 'posix-sh'
  return 'unknown'
}

/** The typed capture — pure reads, redaction-safe by construction. */
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

/** Persist this process's record into the bounded ring (fail-soft). */
export function recordInvocation(): InvocationCapabilityRecordV1 {
  const rec = captureInvocationRecord()
  try {
    let rows: InvocationCapabilityRecordV1[] = []
    try {
      const raw = JSON.parse(readFileSync(invocationRecordPath(), 'utf8')) as InvocationFileV1
      if (raw && raw.version === 1 && Array.isArray(raw.rows)) rows = raw.rows
    } catch {
      /* fresh */
    }
    rows = [...rows, rec].slice(-MAX_ROWS)
    const path = invocationRecordPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, rows } satisfies InvocationFileV1, null, 1)}\n`)
    renameSync(tmp, path)
  } catch {
    /* telemetry only */
  }
  return rec
}

/** The bounded read (doctor + provers). */
export function readInvocationRecords(): InvocationCapabilityRecordV1[] {
  try {
    const raw = JSON.parse(readFileSync(invocationRecordPath(), 'utf8')) as InvocationFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
    return raw.rows
  } catch {
    return []
  }
}
