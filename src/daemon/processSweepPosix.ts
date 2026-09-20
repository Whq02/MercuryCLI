import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import type { ProcessSweepObservation, ProcessSweepRead, ProcessSweepTable } from './processSweep.js'
import { parseProcessStartToken, processNamesMercury } from './processSweep.js'

export { parseProcessStartToken } from './processSweep.js'

export function parsePosixProcessTable(text: string): ProcessSweepTable {
  const observations: ProcessSweepObservation[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(line)
    if (match === null) return { observations, complete: false, error: 'the process table contained an unreadable row' }
    const token = match[6]!.trim()
    const terminal = match[4] === '??' || match[4] === '?' || match[4] === '-' ? null : match[4]!
    observations.push({
      process: { pid: Number(match[1]), ppid: Number(match[2]), exe: '', args: [], startedAtMs: parseProcessStartToken(token), user: match[3]!, terminal },
      startToken: token,
      state: match[5]!,
      terminalAlive: terminal === null ? false : null,
    })
  }
  return { observations, complete: true }
}

export function parsePidColumn(text: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match !== null) out.set(Number(match[1]), match[2]!.trim())
  }
  return out
}

export const TERMINAL_FRESH_MS = 90_000

export function probePosixTerminal(terminal: string, pid: number, table: readonly ProcessSweepObservation[], nowMs: number = Date.now(), freshMs: number = TERMINAL_FRESH_MS): ProcessSweepRead {
  if (!/^(?:ttys\d+|tty[A-Za-z0-9]+|pts\/\d+)$/.test(terminal)) return null
  const otherLeader = table.some(row => row.process.pid !== pid && row.process.terminal === terminal && row.state.includes('s') && !row.state.startsWith('Z'))
  if (otherLeader) return true
  try {
    const node = statSync(`/dev/${terminal}`)
    return Number.isFinite(node.mtimeMs) && nowMs - node.mtimeMs <= freshMs ? true : null
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

export interface PosixProcessTableOptions {
  waitMs: number
  recordedPids: readonly number[]
  nowMs?: number
  ps?: (args: readonly string[]) => Promise<string>
  probeTerminal?: (terminal: string, pid: number, table: readonly ProcessSweepObservation[], nowMs: number) => ProcessSweepRead
}

export async function collectPosixProcessTable(options: PosixProcessTableOptions): Promise<ProcessSweepTable> {
  const ps = options.ps ?? ((args: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile('ps', [...args], { env: { ...subprocessEnv() }, timeout: options.waitMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
      if (failed !== null && (!args.includes('-p') || failed.code === 'ENOENT' || failed.killed === true || typeof stdout !== 'string')) reject(failed)
      else resolve(stdout)
    })
  }))
  try {
    const rows = await ps(['-Aww', '-o', 'pid=,ppid=,uid=,tty=,stat=,lstart='])
    if (rows.trim() === '') return { observations: [], complete: false, error: 'the process table read answered no rows' }
    const table = parsePosixProcessTable(rows)
    if (!table.complete) return table
    const argsText = await ps(['-Aww', '-o', 'pid=,args='])
    if (argsText.trim() === '') return { observations: [], complete: false, error: 'the command-line read answered no rows' }
    const args = parsePidColumn(argsText)
    for (const row of table.observations) row.process.args = (args.get(row.process.pid) ?? '').split(' ').filter(part => part !== '')
    const recorded = new Set(options.recordedPids)
    const candidates = table.observations.filter(row => recorded.has(row.process.pid) || processNamesMercury(row.process.args))
    if (candidates.length > 0) {
      const names = parsePidColumn(await ps(['-ww', '-o', 'pid=,ucomm=', '-p', candidates.map(row => row.process.pid).join(',')]))
      for (const row of candidates) {
        row.process.exe = names.get(row.process.pid) ?? ''
        if (row.process.terminal !== null) row.terminalAlive = (options.probeTerminal ?? probePosixTerminal)(row.process.terminal, row.process.pid, table.observations, options.nowMs ?? Date.now())
      }
    }
    return table
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { observations: [], complete: false, error: `the process table could not be read (${typeof code === 'string' ? code : 'ps failed'})` }
  }
}
