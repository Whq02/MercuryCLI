import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import type { ProcessSweepEntry, ProcessSweepObservation, ProcessSweepTable } from './processSweep.js'
import { processSweepWindowsHost } from './processSweepWindowsHost.js'

const rawRowSchema = z.object({
  pid: z.number().int().positive().max(0xffffffff),
  ppid: z.number().int().nonnegative().max(0xffffffff),
  exe: z.string().nullable(),
  args: z.array(z.string()).nullable(),
  startedAtMs: z.number().finite().nonnegative().nullable(),
  startToken: z.string().nullable(),
  user: z.string().nullable(),
  sessionId: z.number().int().nonnegative().nullable(),
  consoleAttached: z.boolean().nullable(),
  sessionConnected: z.boolean().nullable(),
})
export type WindowsRawRow = z.infer<typeof rawRowSchema>

export function decodeWindowsProcessRows(value: unknown): WindowsRawRow[] {
  return z.object({ rows: z.array(rawRowSchema) }).parse(value).rows
}

export function windowsObservation(raw: WindowsRawRow): ProcessSweepObservation {
  const console = raw.consoleAttached === true ? 'attached' : raw.consoleAttached === false ? 'absent' : 'unknown'
  const terminalAlive = raw.consoleAttached === true
    ? true
    : raw.consoleAttached === false
      ? raw.sessionId === null ? null : false
      : raw.sessionConnected === true
        ? true
        : null
  return {
    process: {
      pid: raw.pid,
      ppid: raw.ppid,
      exe: raw.exe ?? '',
      args: raw.args ?? [],
      startedAtMs: raw.startedAtMs ?? 0,
      user: raw.user ?? '',
      terminal: raw.sessionId === null ? null : `session ${raw.sessionId} · console ${console}`,
    },
    startToken: raw.startToken,
    state: 'running',
    terminalAlive,
  }
}

type Identity = Pick<ProcessSweepEntry, 'process' | 'startToken'>

export function windowsIdentityMatches(expected: Identity, fresh: Identity): boolean {
  return expected.process.pid === fresh.process.pid &&
    expected.startToken !== null && expected.startToken === fresh.startToken &&
    expected.process.startedAtMs > 0 && expected.process.startedAtMs === fresh.process.startedAtMs &&
    expected.process.exe !== '' && expected.process.exe.toLowerCase() === fresh.process.exe.toLowerCase() &&
    expected.process.user !== '' && expected.process.user === fresh.process.user
}

export function windowsSignalRefusal(expected: Identity, fresh: ProcessSweepObservation, currentUser: string): string | null {
  if (currentUser === '' || fresh.process.user !== currentUser) return 'The process belongs to another user or its owner could not be read (not-ours)'
  if (!windowsIdentityMatches(expected, fresh)) return 'The process identity (pid, birth, executable, user) is incomplete or no longer matches'
  if (fresh.terminalAlive === true) return `A console or connected interactive session is live (${fresh.process.terminal ?? 'session unknown'})`
  if (fresh.terminalAlive === null) return `Terminal liveness is unknown (${fresh.process.terminal ?? 'session unknown'})`
  return null
}

function openHost() {
  if (process.platform !== 'win32') throw new Error('The Windows process reader requires Windows')
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(processSweepWindowsHost, 'utf16le').toString('base64')
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    env: { ...subprocessEnv() },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  const state: { failure: Error | null } = { failure: null }
  child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-8192) })
  child.on('error', error => { state.failure = error })
  child.stdin.on('error', error => { state.failure = error })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const reader = createInterface({ input: child.stdout })
  const lines = reader[Symbol.asyncIterator]()
  const endTree = (): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  }
  return {
    async ask(request: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
      if (state.failure !== null) throw state.failure
      child.stdin.write(Buffer.from(JSON.stringify(request), 'utf8').toString('base64') + '\n')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const line = await Promise.race([
          lines.next(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { endTree(); reject(new Error('The Windows process reader did not answer within its budget and was ended')) }, timeoutMs) }),
        ])
        if (line.done) throw new Error(String(state.failure ?? (stderr || 'The Windows process reader closed without a response')))
        const value: unknown = JSON.parse(line.value)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Malformed Windows process response')
        const response = value as Record<string, unknown>
        if (typeof response.error === 'string') throw new Error(response.error)
        return response
      } finally {
        clearTimeout(timer)
      }
    },
    async close(): Promise<void> {
      child.stdin.end()
      const timer = setTimeout(endTree, 3000)
      try { await closed } finally { clearTimeout(timer); reader.close() }
    },
  }
}

async function resolvedObservation(raw: WindowsRawRow): Promise<ProcessSweepObservation> {
  let exe = raw.exe
  if (exe !== null) {
    try { exe = await realpath(exe) } catch {}
  }
  return windowsObservation({ ...raw, exe })
}

export async function collectWindowsProcesses(): Promise<ProcessSweepTable> {
  let host: ReturnType<typeof openHost> | undefined
  try {
    host = openHost()
    const rows = decodeWindowsProcessRows(await host.ask({ op: 'table' }, 60_000))
    return { observations: await Promise.all(rows.map(resolvedObservation)), complete: true }
  } catch (error) {
    return { observations: [], complete: false, error: String(error) }
  } finally {
    await host?.close()
  }
}

export async function signalWindowsProcess(expected: Identity, force: boolean): Promise<{ sent: boolean; reason?: string }> {
  const target = expected.process
  if (!Number.isInteger(target.pid) || target.pid <= 0 || target.pid === process.pid) return { sent: false, reason: 'Invalid target or the current process' }
  if (target.pid === process.ppid) return { sent: false, reason: 'The target is the parent of the process asking for the stop' }
  const ownerPid = Number(process.env.MERCURY_DAEMON_OWNER_PID ?? '')
  if (Number.isInteger(ownerPid) && ownerPid > 0 && target.pid === ownerPid) return { sent: false, reason: 'The target is the owner of the process asking for the stop' }
  let host: ReturnType<typeof openHost> | undefined
  try {
    host = openHost()
    const first = await host.ask({ op: 'signal', pid: target.pid, force })
    if (first.row === null) return { sent: false, reason: 'The process has already exited' }
    const currentUser = typeof first.user === 'string' ? first.user : ''
    const fresh = await resolvedObservation(rawRowSchema.parse(first.row))
    const refusal = windowsSignalRefusal(expected, fresh, currentUser)
    if (refusal !== null) {
      await host.ask({ go: false }).catch(() => undefined)
      return { sent: false, reason: refusal }
    }
    let receipt: Record<string, unknown>
    try {
      receipt = await host.ask({ go: true }, 20_000)
    } catch (error) {
      return { sent: false, reason: `The stop gave no receipt (${String(error)}); its outcome is unknown, so re-read the process before deciding` }
    }
    const outcome = z.object({ sent: z.boolean(), reason: z.string() }).parse(receipt)
    return outcome.reason === '' ? { sent: outcome.sent } : outcome
  } catch (error) {
    return { sent: false, reason: String(error) }
  } finally {
    await host?.close()
  }
}
