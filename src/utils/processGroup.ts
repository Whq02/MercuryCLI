import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'


export type ProcessTreeKillReceipt = {
  ended: number
  survivors: number[]
}

const REAP_BOUND_MS = 800
const REAP_POLL_MS = 40
const MSYS_TABLE_BOUND_MS = 800
const MSYS_SWEEP_ROUNDS = 3

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function win32TaskkillCommand(pid: number): { file: string; args: string[] } {
  return {
    file: pathWin32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    args: ['/PID', String(pid), '/T', '/F'],
  }
}

export function win32TaskkillSweepCommand(pids: readonly number[]): { file: string; args: string[] } {
  return {
    file: win32TaskkillCommand(0).file,
    args: [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'],
  }
}

export function taskkillActedPids(stdout: string): number[] {
  const acted: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /\bPID\s+(\d+)/i.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (Number.isInteger(pid) && pid > 1 && !acted.includes(pid)) acted.push(pid)
  }
  return acted
}

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type PosixTableRow = { pid: number; ppid: number; pgid: number }

function listPosixProcessTable(): Promise<PosixTableRow[]> {
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid='],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolve([])
        const rows: PosixTableRow[] = []
        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 3) continue
          const pid = Number(parts[0])
          const ppid = Number(parts[1])
          const pgid = Number(parts[2])
          if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
            rows.push({ pid, ppid, pgid })
          }
        }
        resolve(rows)
      },
    )
  })
}

function collectPosixTargets(
  table: PosixTableRow[],
  roots: Set<number>,
  groupPgid: number | undefined,
): Set<number> {
  const byParent = new Map<number, number[]>()
  for (const row of table) {
    const kids = byParent.get(row.ppid)
    if (kids) kids.push(row.pid)
    else byParent.set(row.ppid, [row.pid])
  }
  const targets = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (targets.has(pid)) continue
    targets.add(pid)
    for (const kid of byParent.get(pid) ?? []) queue.push(kid)
  }
  if (groupPgid !== undefined) {
    for (const row of table) {
      if (row.pgid === groupPgid) targets.add(row.pid)
    }
  }
  targets.delete(process.pid)
  for (const pid of targets) {
    if (pid <= 1) targets.delete(pid)
  }
  return targets
}

function filterOutZombies(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return Promise.resolve([])
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-o', 'pid=,stat=', '-p', pids.join(',')],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolve(pids)
        const alive = new Set<number>()
        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 2) continue
          const pid = Number(parts[0])
          if (Number.isInteger(pid) && !parts[1]!.startsWith('Z')) alive.add(pid)
        }
        resolve(pids.filter(pid => alive.has(pid)))
      },
    )
  })
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
  }
}

async function endPosixTree(pid: number, signal: NodeJS.Signals): Promise<ProcessTreeKillReceipt> {
  const table = await listPosixProcessTable()
  const rootRow = table.find(row => row.pid === pid)
  const groupPgid = rootRow !== undefined && rootRow.pgid === pid ? pid : undefined
  const targets =
    table.length > 0
      ? collectPosixTargets(table, new Set([pid]), groupPgid)
      : new Set(pid > 1 && pid !== process.pid ? [pid] : [])

  try {
    process.kill(-pid, signal)
  } catch {
  }
  for (const target of targets) signalPid(target, signal)

  await sleep(REAP_POLL_MS)
  const second = await listPosixProcessTable()
  if (second.length > 0) {
    const late = collectPosixTargets(second, new Set([pid, ...targets]), groupPgid)
    for (const target of late) {
      if (!targets.has(target)) {
        signalPid(target, signal)
        targets.add(target)
      }
    }
  }

  const candidates = [...targets]
  let remaining = candidates.filter(isAlivePid)
  const deadline = Date.now() + REAP_BOUND_MS
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(REAP_POLL_MS)
    remaining = remaining.filter(isAlivePid)
  }
  if (remaining.length > 0) remaining = await filterOutZombies(remaining)
  return { ended: candidates.length - remaining.length, survivors: remaining }
}

export type MsysProcessRow = { pid: number; ppid: number; pgid: number; winpid: number }

export type MsysTreeMemory = { pids: Set<number>; groups: Set<number> }

export function parseMsysProcessTable(stdout: string): MsysProcessRow[] {
  const rows: MsysProcessRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^[A-Z ]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), winpid: Number(match[4]) })
  }
  return rows
}

export function msysTreeRows(
  rows: readonly MsysProcessRow[],
  memory: MsysTreeMemory,
  rootWinpids: readonly number[] = [],
): MsysProcessRow[] {
  const byPid = new Map<number, MsysProcessRow>()
  const byParent = new Map<number, MsysProcessRow[]>()
  const byGroup = new Map<number, MsysProcessRow[]>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const kids = byParent.get(row.ppid)
    if (kids) kids.push(row)
    else byParent.set(row.ppid, [row])
    const members = byGroup.get(row.pgid)
    if (members) members.push(row)
    else byGroup.set(row.pgid, [row])
  }
  for (const row of rows) {
    if (row.pid <= 1 || row.winpid === process.pid || !rootWinpids.includes(row.winpid)) continue
    memory.pids.add(row.pid)
    if (row.pgid === row.pid) memory.groups.add(row.pgid)
  }
  const found = new Map<number, MsysProcessRow>()
  const queue: number[] = []
  const claim = (row: MsysProcessRow): void => {
    if (row.pid <= 1 || row.winpid === process.pid || found.has(row.pid)) return
    found.set(row.pid, row)
    memory.pids.add(row.pid)
    queue.push(row.pid)
  }
  for (const pid of [...memory.pids]) {
    const row = byPid.get(pid)
    if (row) claim(row)
    else queue.push(pid)
  }
  for (const group of memory.groups) {
    for (const row of byGroup.get(group) ?? []) claim(row)
  }
  while (queue.length > 0) {
    const pid = queue.pop()!
    for (const kid of byParent.get(pid) ?? []) claim(kid)
  }
  return [...found.values()].filter(row => row.winpid > 1)
}

function msysPsBeside(spawnfile: string | undefined): string | undefined {
  if (typeof spawnfile !== 'string' || !pathWin32.isAbsolute(spawnfile)) return undefined
  const holder = pathWin32.dirname(spawnfile)
  for (const dir of [holder, pathWin32.join(holder, '..', 'usr', 'bin')]) {
    const ps = pathWin32.join(dir, 'ps.exe')
    if (existsSync(ps) && (existsSync(pathWin32.join(dir, 'msys-2.0.dll')) || existsSync(pathWin32.join(dir, 'cygwin1.dll')))) {
      return ps
    }
  }
  return undefined
}

function readMsysTable(ps: string): Promise<MsysProcessRow[]> {
  return new Promise(resolve => {
    execFile(
      ps,
      ['-e', '-l'],
      { windowsHide: true, timeout: MSYS_TABLE_BOUND_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error || typeof stdout !== 'string' ? [] : parseMsysProcessTable(stdout))
      },
    )
  })
}

async function sweepMsysTree(
  ps: string,
  before: readonly MsysProcessRow[],
  rootWinpids: readonly number[],
): Promise<number[]> {
  const memory: MsysTreeMemory = { pids: new Set(), groups: new Set() }
  let found = msysTreeRows(before, memory, rootWinpids)
  const struck: number[] = []
  for (let round = 0; round < MSYS_SWEEP_ROUNDS && memory.pids.size > 0; round++) {
    const live = found.map(row => row.winpid).filter(winpid => !struck.includes(winpid) && isAlivePid(winpid))
    if (live.length === 0) break
    const { file, args } = win32TaskkillSweepCommand(live)
    const [stdout, table] = await Promise.all([
      new Promise<string>(resolve => {
        execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
          resolve(typeof out === 'string' ? out : String(out ?? ''))
        })
      }),
      readMsysTable(ps),
    ])
    for (const winpid of [...live, ...taskkillActedPids(stdout)]) {
      if (!struck.includes(winpid)) struck.push(winpid)
    }
    found = msysTreeRows(table, memory)
  }
  return struck
}

async function endWin32Tree(pid: number, spawnfile?: string): Promise<ProcessTreeKillReceipt> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { ended: 0, survivors: [] }
  const msysPs = msysPsBeside(spawnfile)
  const before = msysPs === undefined ? [] : await readMsysTable(msysPs)
  const { file, args } = win32TaskkillCommand(pid)
  const stdout = await new Promise<string>(resolve => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
      resolve(typeof out === 'string' ? out : String(out ?? ''))
    })
  })
  const acted = taskkillActedPids(stdout)
  if (msysPs !== undefined && before.length > 0) {
    for (const swept of await sweepMsysTree(msysPs, before, [pid, ...acted])) {
      if (!acted.includes(swept)) acted.push(swept)
    }
  }
  const watched = acted.includes(pid) ? acted : [pid, ...acted]
  let remaining = watched.filter(isAlivePid)
  const deadline = Date.now() + REAP_BOUND_MS
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(REAP_POLL_MS)
    remaining = remaining.filter(isAlivePid)
  }
  const ended = acted.filter(actedPid => !remaining.includes(actedPid)).length
  return { ended, survivors: remaining }
}

export async function endProcessTree(
  target: (Pick<ChildProcess, 'pid' | 'kill'> & { spawnfile?: string }) | number,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<ProcessTreeKillReceipt> {
  const pid = typeof target === 'number' ? target : target.pid
  if (!pid || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { ended: 0, survivors: [] }
  const spawnfile = typeof target === 'number' ? undefined : target.spawnfile
  try {
    return process.platform === 'win32' ? await endWin32Tree(pid, spawnfile) : await endPosixTree(pid, signal)
  } catch {
    if (typeof target !== 'number') {
      try {
        target.kill(signal)
      } catch {
      }
    } else {
      signalPid(pid, signal)
    }
    return { ended: 0, survivors: isAlivePid(pid) ? [pid] : [] }
  }
}

export async function endProcessTreeSurvivors(
  rootPid: number,
  survivors: readonly number[],
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<ProcessTreeKillReceipt> {
  for (const pid of survivors) {
    if (pid > 1 && pid !== process.pid) signalPid(pid, signal)
  }
  const walked = await endProcessTree(rootPid, signal)
  await sleep(REAP_POLL_MS)
  const still = survivors.filter(pid => isAlivePid(pid))
  const ended = walked.ended + survivors.length - still.length
  return { ended, survivors: [...new Set([...walked.survivors, ...still])] }
}

export function killProcessGroup(
  childProcess: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  const pid = childProcess.pid
  if (!pid || pid <= 0) return
  void endProcessTree(childProcess, signal)
}

export function strikeProcessGroupNow(childProcess: Pick<ChildProcess, 'pid'>, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = childProcess.pid
  if (!pid || pid <= 1 || pid === process.pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    signalPid(pid, signal)
  }
}
