import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { logForDebugging } from '../logs/debugLog.js'
import { getMercuryHome } from '../environment/envUtils.js'
import { errorMessage } from '../errors/errors.js'
import { passedOver } from '../errors/passedOver.js'
import { hostEnv } from '../environment/hostEnv.js'
import { hostShellHint, type HostShellHint } from '../host-os/spawn.js'

type ShellHint = HostShellHint

interface InvocationCapabilityRecordV1 {
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

export function classifyShellHint(env: NodeJS.ProcessEnv = hostEnv(), platform: NodeJS.Platform = process.platform): ShellHint {
  return hostShellHint(env, platform)
}

function captureInvocationRecord(): InvocationCapabilityRecordV1 {
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
    ...(typeof hostEnv().TERM_PROGRAM === 'string' && hostEnv().TERM_PROGRAM!
      ? { termProgram: hostEnv().TERM_PROGRAM! }
      : {}),
  }
}

function invocationRecordPath(): string {
  return join(getMercuryHome(), 'invocation-record.json')
}

export function recordInvocation(): InvocationCapabilityRecordV1 {
  const rec = captureInvocationRecord()
  try {
    let rows: InvocationCapabilityRecordV1[] = []
    let text: string | null = null
    try {
      text = readFileSync(invocationRecordPath(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text !== null) {
      try {
        const raw = JSON.parse(text) as InvocationFileV1
        if (raw && raw.version === 1 && Array.isArray(raw.rows)) rows = raw.rows
      } catch (error) {
        passedOver(error)
        logForDebugging(`[invocation-record] replacing corrupt record: ${errorMessage(error)}`, { level: 'warn' })
      }
    }
    rows = [...rows, rec].slice(-MAX_ROWS)
    const path = invocationRecordPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, rows } satisfies InvocationFileV1, null, 1)}\n`)
    renameSync(tmp, path)
  } catch (error) {
    passedOver(error)
    logForDebugging(`[invocation-record] skipped recording invocation: ${errorMessage(error)}`, { level: 'warn' })
  }
  return rec
}

export function readInvocationRecords(): InvocationCapabilityRecordV1[] {
  let text: string
  try {
    text = readFileSync(invocationRecordPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const raw = JSON.parse(text) as InvocationFileV1
  if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) {
    throw new SyntaxError('invalid invocation-record.json')
  }
  return raw.rows
}
