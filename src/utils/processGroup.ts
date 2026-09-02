import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'


export type ProcessTreeKillReceipt = {
  ended: number
  survivors: number[]
}

const REAP_BOUND_MS = 800
const REAP_POLL_MS = 40

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function win32TaskkillCommand(pid: number): { file: string; args: string[] } {
  return { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
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

async function endWin32Tree(pid: number): Promise<ProcessTreeKillReceipt> {
  const { file, args } = win32TaskkillCommand(pid)
  const stdout = await new Promise<string>(resolve => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, out) => {
      resolve(typeof out === 'string' ? out : String(out ?? ''))
    })
  })
  const acted = taskkillActedPids(stdout)
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
  target: Pick<ChildProcess, 'pid' | 'kill'> | number,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<ProcessTreeKillReceipt> {
  const pid = typeof target === 'number' ? target : target.pid
  if (!pid || pid <= 0) return { ended: 0, survivors: [] }
  try {
    return process.platform === 'win32' ? await endWin32Tree(pid) : await endPosixTree(pid, signal)
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
