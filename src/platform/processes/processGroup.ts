import { execFile, spawnSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { win32 as pathWin32 } from 'node:path'
import { sleep } from '../async/sleep.js'
import { pollUntil, withDeadline } from '../async/deadline.js'
import { passedOver } from '../errors/passedOver.js'
import { hostEnv } from '../environment/hostEnv.js'
import { processTreeEndMethod } from '../host-os/processes.js'
import { pidAlive } from './pidAlive.js'


export type ProcessTreeKillReceipt = {
  ended: number
  survivors: number[]
}

const guardedTrees = new WeakMap<object, (signal: NodeJS.Signals) => Promise<ProcessTreeKillReceipt | null>>()

export function registerProcessTreeGuard(child: ChildProcess, end: (signal: NodeJS.Signals) => Promise<ProcessTreeKillReceipt | null>): void {
  guardedTrees.set(child, end)
}

const REAP_BOUND_MS = 800
const REAP_POLL_MS = 40
const MSYS_TABLE_BOUND_MS = 800
const MSYS_SWEEP_ROUNDS = 3

export function win32TaskkillCommand(pid: number): { file: string; args: string[] } {
  return {
    file: pathWin32.join(hostEnv().SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
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
  } catch (error) {
    passedOver(error)
  }
}

let ownProcessGroup: number | undefined

export function processStandsInTree(table: readonly { pid: number; ppid: number; pgid: number }[], rootPid: number): boolean {
  const byPid = new Map(table.map(row => [row.pid, row] as const))
  const seen = new Set<number>()
  let at: number | undefined = process.pid
  while (at !== undefined && at > 1 && !seen.has(at)) {
    if (at === rootPid) return true
    const row = byPid.get(at)
    if (row === undefined) return false
    if (row.pgid === rootPid) return true
    seen.add(at)
    at = row.ppid
  }
  return false
}

async function endPosixTree(pid: number, signal: NodeJS.Signals): Promise<ProcessTreeKillReceipt> {
  const table = await listPosixProcessTable()
  const own = table.find(row => row.pid === process.pid)
  if (own !== undefined) ownProcessGroup = own.pgid
  if (ownProcessGroup === pid || processStandsInTree(table, pid)) return { ended: 0, survivors: pidAlive(pid) ? [pid] : [] }
  const rootRow = table.find(row => row.pid === pid)
  const groupPgid = rootRow !== undefined && rootRow.pgid === pid ? pid : undefined
  const targets =
    table.length > 0
      ? collectPosixTargets(table, new Set([pid]), groupPgid)
      : new Set(pid > 1 && pid !== process.pid ? [pid] : [])

  try {
    process.kill(-pid, signal)
  } catch (error) {
    passedOver(error)
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
  let remaining = await reapRemainingPids(candidates)
  if (remaining.length > 0) remaining = await filterOutZombies(remaining)
  return { ended: candidates.length - remaining.length, survivors: remaining }
}

export type MsysProcessRow = { pid: number; ppid: number; pgid: number; winpid: number }

export type MsysTreeMemory = { pids: Set<number>; groups: Set<number> }

export function parseMsysProcessTable(stdout: string): MsysProcessRow[] {
  const rows: MsysProcessRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^[A-Z ]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/.exec(line)
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

type MsysTableReader = { file: string; args: string[] }

const MSYS_TABLE_BY_BUILTINS =
  'for d in /proc/[0-9]*; do w= pp= pg=; { read w < $d/winpid; read pp < $d/ppid; read pg < $d/pgid; } 2>/dev/null; [[ -n $w && -n $pp && -n $pg ]] && echo ${d#/proc/} $pp $pg $w; done; :'

function msysRuntimesOf(spawnfile: string, fileExists: (file: string) => boolean): string[] {
  const holder = pathWin32.dirname(spawnfile)
  return [holder, pathWin32.join(holder, '..', 'usr', 'bin')].filter(dir => fileExists(pathWin32.join(dir, 'msys-2.0.dll')) || fileExists(pathWin32.join(dir, 'cygwin1.dll')))
}

export function runsInAnMsysRuntime(spawnfile: string | undefined, fileExists: (file: string) => boolean = existsSync): boolean {
  return typeof spawnfile === 'string' && pathWin32.isAbsolute(spawnfile) && msysRuntimesOf(spawnfile, fileExists).length > 0
}

export function msysTableReaderOf(spawnfile: string | undefined, fileExists: (file: string) => boolean = existsSync): MsysTableReader | undefined {
  if (typeof spawnfile !== 'string' || !pathWin32.isAbsolute(spawnfile)) return undefined
  const runtimes = msysRuntimesOf(spawnfile, fileExists)
  const ps = runtimes.map(dir => pathWin32.join(dir, 'ps.exe')).find(file => fileExists(file))
  if (ps !== undefined) return { file: ps, args: ['-e', '-l'] }
  return runtimes.length > 0 && /^bash(?:\.exe)?$/i.test(pathWin32.basename(spawnfile)) ? { file: spawnfile, args: ['-o', 'privileged', '-c', MSYS_TABLE_BY_BUILTINS] } : undefined
}

function readersOf(shells: ReadonlyArray<string | undefined>): MsysTableReader[] {
  const readers = new Map<string, MsysTableReader>()
  for (const shell of shells) {
    const reader = msysTableReaderOf(shell)
    if (reader !== undefined) readers.set([reader.file, ...reader.args].join('\n'), reader)
  }
  return [...readers.values()]
}

function startsNode(spawnfile: string): boolean {
  return spawnfile === process.execPath || /^(?:node|bun)(?:\.exe)?$/i.test(pathWin32.basename(spawnfile))
}

function readMsysTable(reader: MsysTableReader): Promise<MsysProcessRow[]> {
  return new Promise(resolve => {
    execFile(
      reader.file,
      reader.args,
      { windowsHide: true, timeout: MSYS_TABLE_BOUND_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error || typeof stdout !== 'string' ? [] : parseMsysProcessTable(stdout))
      },
    )
  })
}

async function sweepMsysTree(
  reader: MsysTableReader,
  before: readonly MsysProcessRow[],
  rootWinpids: readonly number[],
): Promise<number[]> {
  const memory: MsysTreeMemory = { pids: new Set(), groups: new Set() }
  let found = msysTreeRows(before, memory, rootWinpids)
  const struck: number[] = []
  for (let round = 0; round < MSYS_SWEEP_ROUNDS && memory.pids.size > 0; round++) {
    const live = found.map(row => row.winpid).filter(winpid => !struck.includes(winpid) && pidAlive(winpid))
    if (live.length === 0) break
    const { file, args } = win32TaskkillSweepCommand(live)
    const [stdout, table] = await Promise.all([
      new Promise<string>(resolve => {
        execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
          resolve(typeof out === 'string' ? out : String(out ?? ''))
        })
      }),
      readMsysTable(reader),
    ])
    for (const winpid of [...live, ...taskkillActedPids(stdout)]) {
      if (!struck.includes(winpid)) struck.push(winpid)
    }
    found = msysTreeRows(table, memory)
  }
  return struck
}

export async function endMsysGroupBeside(spawnfile: string, pgid: number): Promise<number[]> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pgid) || pgid <= 1) return []
  const reader = msysTableReaderOf(spawnfile)
  if (reader === undefined) return []
  const live = (await readMsysTable(reader))
    .filter(row => row.pgid === pgid && row.winpid > 1 && row.winpid !== process.pid)
    .map(row => row.winpid)
    .filter(pidAlive)
  if (live.length === 0) return []
  const { file, args } = win32TaskkillSweepCommand(live)
  const stdout = await new Promise<string>(resolve => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
      resolve(typeof out === 'string' ? out : String(out ?? ''))
    })
  })
  return taskkillActedPids(stdout)
}

type LeftBehind = { shell: string; pgid: number; members: Array<[number, number]> }

const leftBehindHere: LeftBehind[] = []
const shellsNotedHere = new Set<string>()
let recordKeptHere = false
let saysWhatEnded: ((line: string) => void) | undefined
let shellThatServes: (() => string | undefined) | undefined

export function tellWhatProcessGroupEnds(say: (line: string) => void): void {
  saysWhatEnded = say
}

export function tellProcessGroupTheShell(read: () => string | undefined): void {
  shellThatServes = read
}

function leftBehindFile(winpid: number): string {
  return pathWin32.join(tmpdir(), `mercury-jobs-${winpid}`)
}

function readRecord(text: string): LeftBehind[] {
  const entries: LeftBehind[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let read: unknown
    try {
      read = JSON.parse(line)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      saysWhatEnded?.(`a line of a jobs record is no record and is passed over: ${line.slice(0, 120)}`)
      continue
    }
    const entry = (typeof read === 'object' && read !== null ? read : {}) as Partial<LeftBehind>
    if (typeof entry.shell !== 'string' || !Number.isSafeInteger(entry.pgid) || (entry.pgid as number) < 0 || !Array.isArray(entry.members)) continue
    const members = entry.members.filter((pair): pair is [number, number] => Array.isArray(pair) && Number.isSafeInteger(pair[0]) && Number.isSafeInteger(pair[1]))
    entries.push({ shell: entry.shell, pgid: entry.pgid as number, members })
  }
  return entries
}

function recordOf(winpid: number): LeftBehind[] {
  try {
    return readRecord(readFileSync(leftBehindFile(winpid), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') saysWhatEnded?.(`the jobs record of process ${winpid} was not read: ${String(error)}`)
    return []
  }
}

function keepRecordHere(entry: LeftBehind): void {
  appendFileSync(leftBehindFile(process.pid), `${JSON.stringify(entry)}\n`)
  if (!recordKeptHere) process.once('exit', endLeftBehindHereNow)
  recordKeptHere = true
}

export function noteShellOfThisProcess(shellPath: string): void {
  if (process.platform !== 'win32' || shellsNotedHere.has(shellPath) || msysTableReaderOf(shellPath) === undefined) return
  shellsNotedHere.add(shellPath)
  keepRecordHere({ shell: shellPath, pgid: 0, members: [] })
}

function stillLeftBehind(table: readonly MsysProcessRow[], entry: LeftBehind): number[] {
  const group = table.filter(row => row.pgid === entry.pgid)
  if (!entry.members.some(([pid, winpid]) => group.some(row => row.pid === pid && row.winpid === winpid))) return []
  return msysTreeRows(table, { pids: new Set(group.map(row => row.pid)), groups: new Set([entry.pgid]) })
    .map(row => row.winpid)
    .filter(winpid => winpid !== process.pid && pidAlive(winpid))
}

function endLeftBehindHereNow(): void {
  for (const entry of leftBehindHere) {
    const reader = msysTableReaderOf(entry.shell)
    if (reader === undefined) continue
    const said = spawnSync(reader.file, reader.args, { windowsHide: true, timeout: MSYS_TABLE_BOUND_MS, encoding: 'utf8' })
    const live = stillLeftBehind(parseMsysProcessTable(typeof said.stdout === 'string' ? said.stdout : ''), entry)
    if (live.length === 0) continue
    const { file, args } = win32TaskkillSweepCommand(live)
    spawnSync(file, args, { windowsHide: true, timeout: 5_000, stdio: 'ignore' })
    saysWhatEnded?.(`ended with this process, left running by a finished command (MSYS group ${entry.pgid}): Windows pid ${live.join(', ')}`)
  }
  try {
    rmSync(leftBehindFile(process.pid), { force: true })
  } catch (error) {
    saysWhatEnded?.(`the jobs record of this process was not removed: ${String(error)}`)
  }
}

export async function noteMsysGroupLeftBehind(shellPath: string, pgid: number): Promise<number[]> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pgid) || pgid <= 1) return []
  const reader = msysTableReaderOf(shellPath)
  if (reader === undefined) return []
  const members = (await readMsysTable(reader)).filter(row => row.pgid === pgid && row.winpid > 1 && row.winpid !== process.pid)
  if (members.length === 0) return []
  const entry: LeftBehind = { shell: shellPath, pgid, members: members.map(row => [row.pid, row.winpid]) }
  keepRecordHere(entry)
  leftBehindHere.push(entry)
  return members.map(row => row.winpid)
}

async function endLeftBehindOf(winpids: readonly number[]): Promise<number[]> {
  const struck: number[] = []
  for (const winpid of winpids) {
    for (const entry of recordOf(winpid)) {
      const reader = entry.pgid > 1 ? msysTableReaderOf(entry.shell) : undefined
      if (reader === undefined) continue
      const live = stillLeftBehind(await readMsysTable(reader), entry)
      if (live.length === 0) continue
      const { file, args } = win32TaskkillSweepCommand(live)
      const stdout = await new Promise<string>(resolve => {
        execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
          resolve(typeof out === 'string' ? out : String(out ?? ''))
        })
      })
      for (const ended of [...live, ...taskkillActedPids(stdout)]) {
        if (!struck.includes(ended)) struck.push(ended)
      }
      saysWhatEnded?.(`ended with process ${winpid}, left running by a finished command of it (MSYS group ${entry.pgid}): Windows pid ${live.join(', ')}`)
    }
    try {
      rmSync(leftBehindFile(winpid), { force: true })
    } catch (error) {
      saysWhatEnded?.(`the jobs record of process ${winpid} was not removed: ${String(error)}`)
    }
  }
  return struck
}

async function endWin32Tree(pid: number, spawnfile?: string): Promise<ProcessTreeKillReceipt> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { ended: 0, survivors: [] }
  const own = msysTableReaderOf(spawnfile)
  const readers = own !== undefined ? [own] : readersOf([...recordOf(pid).map(entry => entry.shell), ...(spawnfile === undefined || startsNode(spawnfile) ? [shellThatServes?.()] : [])])
  const tables = await Promise.all(readers.map(async reader => ({ reader, before: await readMsysTable(reader) })))
  const { file, args } = win32TaskkillCommand(pid)
  const stdout = await new Promise<string>(resolve => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
      resolve(typeof out === 'string' ? out : String(out ?? ''))
    })
  })
  const acted = taskkillActedPids(stdout)
  for (const { reader, before } of tables) {
    if (before.length === 0) continue
    for (const swept of await sweepMsysTree(reader, before, [pid, ...acted])) {
      if (!acted.includes(swept)) acted.push(swept)
    }
  }
  for (const left of await endLeftBehindOf([pid, ...acted])) {
    if (!acted.includes(left)) acted.push(left)
  }
  const watched = acted.includes(pid) ? acted : [pid, ...acted]
  const remaining = await reapRemainingPids(watched)
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
  if (typeof target !== 'number') {
    const end = guardedTrees.get(target)
    if (end !== undefined) {
      const receipt = await end(signal)
      if (receipt !== null) return receipt
    }
  }
  try {
    return processTreeEndMethod() === 'win32-taskkill' ? await endWin32Tree(pid, spawnfile) : await endPosixTree(pid, signal)
  } catch {
    if (typeof target !== 'number') {
      try {
        target.kill(signal)
      } catch (error) {
        passedOver(error)
      }
    } else {
      signalPid(pid, signal)
    }
    return { ended: 0, survivors: pidAlive(pid) ? [pid] : [] }
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
  const still = survivors.filter(pid => pidAlive(pid))
  const ended = walked.ended + survivors.length - still.length
  return { ended, survivors: [...new Set([...walked.survivors, ...still])] }
}

async function reapRemainingPids(pids: readonly number[]): Promise<number[]> {
  let remaining = pids.filter(pidAlive)
  if (remaining.length === 0) return remaining
  return pollUntil(
    () => {
      remaining = remaining.filter(pidAlive)
      return remaining.length === 0 ? remaining : undefined
    },
    REAP_POLL_MS,
    REAP_BOUND_MS,
    () => remaining,
  )
}

const treeEndsStarted = new Set<Promise<ProcessTreeKillReceipt>>()

export async function treeEndsSettled(boundMs: number): Promise<void> {
  if (process.platform !== 'win32' || treeEndsStarted.size === 0) return
  const deadline = Date.now() + boundMs
  while (treeEndsStarted.size > 0) {
    const left = deadline - Date.now()
    if (left <= 0) return
    const first = await withDeadline(Promise.allSettled([...treeEndsStarted]).then(() => 'ended' as const), left, () => 'bound' as const, { unref: true })
    if (first === 'bound') return
  }
}

export function killProcessGroup(
  childProcess: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  const pid = childProcess.pid
  if (!pid || pid <= 0) return
  const end = endProcessTree(childProcess, signal)
  treeEndsStarted.add(end)
  const settled = (): void => {
    treeEndsStarted.delete(end)
  }
  void end.then(settled, settled)
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

export type BirthMark = { pid: number; at: number }

const BIRTH_READ_BOUND_MS = 800
const LINUX_STAT_START_TIME = 19
const BIRTH_UNREADABLE = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])

function linuxBirth(pid: number): number | null {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (BIRTH_UNREADABLE.has((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
  const ticks = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[LINUX_STAT_START_TIME])
  return Number.isSafeInteger(ticks) ? ticks : null
}

const BIRTH_ASKED = { windowsHide: true, timeout: BIRTH_READ_BOUND_MS, env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' } }

function birthSaid(stdout: unknown): number | null {
  const at = typeof stdout !== 'string' ? Number.NaN : Date.parse(`${stdout.trim()} UTC`)
  return Number.isFinite(at) ? Math.floor(at / 1000) : null
}

function readBirth(pid: number): Promise<number | null> {
  if (process.platform === 'linux') return Promise.resolve(linuxBirth(pid))
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], BIRTH_ASKED, (error, stdout) => resolve(error ? null : birthSaid(stdout)))
  })
}

function readBirthNow(pid: number): number | null {
  if (process.platform === 'linux') return linuxBirth(pid)
  return birthSaid(spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { ...BIRTH_ASKED, windowsHide: true, timeout: BIRTH_READ_BOUND_MS, encoding: 'utf8' }).stdout)
}

export function birthMark(pid: number | undefined, askedAtMs: number): BirthMark | null {
  if (pid === undefined) return null
  const at = process.platform === 'linux' ? linuxBirth(pid) : Math.floor(askedAtMs / 1000)
  return at === null ? null : { pid, at }
}

export async function birthAfter(pid: number, mark: BirthMark | null): Promise<number | null> {
  if (mark === null || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null
  const born = await readBirth(pid)
  return born === null || born < mark.at || (born === mark.at && pid <= mark.pid) ? null : born
}

export async function endProcessBornAfter(pid: number, mark: BirthMark | null, signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
  if ((await birthAfter(pid, mark)) === null) return false
  signalPid(pid, signal)
  return true
}

export function endProcessBornAt(pid: number, at: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (readBirthNow(pid) !== at) return false
  signalPid(pid, signal)
  return true
}
