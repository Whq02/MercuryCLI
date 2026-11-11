import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { processStandsInTree } from '../utils/processGroup.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { getProcessStartInstantAsync } from './ownerWatch.js'
import { parseProcessStartToken } from './processSweep.js'

type ProcessTreeRow = { pid: number; ppid: number; pgid: number; birth?: string; bornSecond?: number }

type ProcessTreeMember = { pid: number; birth: string }

const LINUX_CLOCK_TICKS_PER_SECOND = 100

export function parseProcessTreeRows(text: string): ProcessTreeRow[] {
  const rows: ProcessTreeRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(\S.*?))?\s*$/.exec(line)
    if (match === null) continue
    const row: ProcessTreeRow = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }
    const bornAt = match[4] === undefined ? Number.NaN : parseProcessStartToken(match[4])
    if (Number.isFinite(bornAt)) {
      row.birth = match[4]
      row.bornSecond = Math.floor(bornAt / 1000)
    }
    rows.push(row)
  }
  return rows
}

function parseLinuxProcessStat(stat: string): ProcessTreeRow | null {
  const opening = stat.indexOf('(')
  const closing = stat.lastIndexOf(')')
  if (opening < 0 || closing < opening) return null
  const pid = Number(stat.slice(0, opening).trim())
  const fields = stat.slice(closing + 1).trim().split(/\s+/)
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const ticks = fields[19]
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || ticks === undefined || !/^\d+$/.test(ticks)) return null
  return { pid, ppid, pgid, birth: ticks, bornSecond: Math.floor(Number(ticks) / LINUX_CLOCK_TICKS_PER_SECOND) }
}

export function readLinuxProcessTree(
  names: () => string[] = () => readdirSync('/proc'),
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): { rows: ProcessTreeRow[]; notedSecond: number } | null {
  try {
    const notedSecond = Math.floor(Number(read('/proc/uptime').trim().split(/\s+/)[0]))
    if (!Number.isFinite(notedSecond)) return null
    const rows: ProcessTreeRow[] = []
    for (const name of names()) {
      if (!/^\d+$/.test(name)) continue
      let stat: string
      try {
        stat = read(`/proc/${name}/stat`)
      } catch {
        continue
      }
      const row = parseLinuxProcessStat(stat)
      if (row !== null) rows.push(row)
    }
    return { rows, notedSecond }
  } catch {
    return null
  }
}

function descendantsIn(rows: readonly ProcessTreeRow[], root: number): Set<number> {
  const byParent = new Map<number, number[]>()
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row.pid])
  const found = new Set<number>()
  const queue = [...(byParent.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (pid === root || found.has(pid)) continue
    found.add(pid)
    queue.push(...(byParent.get(pid) ?? []))
  }
  return found
}

export function processTreeUnder(rows: readonly ProcessTreeRow[], rootPid: number): number[] {
  if (rootPid <= 1 || processStandsInTree(rows, rootPid)) return []
  const members = descendantsIn(rows, rootPid)
  if (rows.some(row => row.pid === rootPid && row.pgid === rootPid)) {
    for (const row of rows) if (row.pgid === rootPid && row.pid !== rootPid) members.add(row.pid)
  }
  return [...members].filter(pid => pid > 1)
}

export function processTreeMembers(rows: readonly ProcessTreeRow[], rootPid: number, notedSecond: number): ProcessTreeMember[] | null {
  if (!rows.some(row => row.pid === process.pid) || processStandsInTree(rows, rootPid)) return null
  const byPid = new Map(rows.map(row => [row.pid, row] as const))
  const members: ProcessTreeMember[] = []
  for (const pid of processTreeUnder(rows, rootPid)) {
    const row = byPid.get(pid)
    if (row?.birth !== undefined && row.bornSecond !== undefined && row.bornSecond < notedSecond) members.push({ pid, birth: row.birth })
  }
  return members
}

export function readProcessTreeUnder(rootPid: number): Promise<ProcessTreeMember[] | null> {
  if (rootPid <= 1 || rootPid === process.pid) return Promise.resolve(null)
  if (process.platform === 'win32') return Promise.resolve(process.ppid === rootPid ? null : [])
  if (process.platform === 'linux') {
    const table = readLinuxProcessTree()
    return Promise.resolve(table === null ? null : processTreeMembers(table.rows, rootPid, table.notedSecond))
  }
  return new Promise(resolve => {
    const notedSecond = Math.floor(Date.now() / 1000)
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid=,lstart='],
      { env: { ...subprocessEnv(), LC_ALL: 'C' }, timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(processTreeMembers(error || typeof stdout !== 'string' ? [] : parseProcessTreeRows(stdout), rootPid, notedSecond)),
    )
  })
}

export function readProcessBirth(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return getProcessStartInstantAsync(pid)
  try {
    return Promise.resolve(parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.birth ?? null)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return Promise.resolve(code === 'ENOENT' || code === 'ESRCH' ? '' : null)
  }
}
