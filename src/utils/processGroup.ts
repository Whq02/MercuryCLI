import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'

/**
 * The ONE cross-platform process-tree kill owner (truth-law 2 — every owned
 * process settles; a descendant must not escape the kill), with a counted
 * receipt: stopping a task/agent/session ends EVERY process it started, on
 * every platform, and the receipt says how many it ended.
 *
 * POSIX: a `detached: true` child leads its own process group, so
 * `process.kill(-pid, signal)` signals the WHOLE group atomically — including
 * a member spawned after the pre-kill snapshot. A descendant that leads its
 * OWN group (a helper that daemonises, a server spawning detached workers)
 * escapes the group signal; the pre-kill snapshot walks the process table's
 * parent chain and those escapees are signalled by pid. Snapshot precedes
 * strike deliberately: once the parents are dead the escapees reparent to
 * pid 1 and no walk can ever find them again.
 *
 * Windows: one `taskkill /PID <pid> /T /F` through execFile with an argv
 * array — never a shell string through cmd.exe. taskkill's own walk ends the
 * tree; each stdout line carries a `PID <n>` token for a process it acted on
 * (the token survives localised builds; failure lines land on stderr). That
 * transcript IS the descendant snapshot the walk took: the reap polls the
 * whole acted set plus the root, the receipt counts the acted pids confirmed
 * gone, and a surviving descendant is finally NAMED so the by-pid second
 * strike has a target. A true Job-Object owner needs a native binding
 * this repo deliberately does not vendor; the Windows arm is proven on the
 * hosted windows field leg, never assumed from POSIX green.
 *
 * Reap law (the PTY-teardown law, applied here): strike first, then a
 * BOUNDED non-blocking confirm — poll aliveness up to REAP_BOUND_MS, treat a
 * zombie (dead, awaiting its parent's wait) as ended, and report honest
 * survivors instead of waiting forever.
 */

/** What a tree kill settled: how many processes it ended (confirmed gone
 *  within the reap bound) and which pids were still alive when the bound
 *  expired (empty = clean sweep). */
export type ProcessTreeKillReceipt = {
  ended: number
  survivors: number[]
}

/** Total bounded-reap budget; sits well inside every caller's kill grace
 *  (2s at the shell-command owner, 3s at the task layer, 5s at the daemon). */
const REAP_BOUND_MS = 800
/** Poll step for the bounded reap. */
const REAP_POLL_MS = 40

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The exact Windows tree-kill invocation: an argv ARRAY for execFile, so no
 *  byte of the pid ever crosses a cmd.exe parse. Exported for the unit pin —
 *  the win32 arm cannot run on a POSIX host. */
export function win32TaskkillCommand(pid: number): { file: string; args: string[] } {
  return { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
}

/** Every pid a taskkill transcript says it acted on — one stdout line per
 *  process, each leading with a `PID <n>` token (localised builds keep the
 *  token; failure lines land on stderr, so they never join). The transcript
 *  IS the descendant snapshot taskkill's own walk took: the win32 reap polls
 *  this whole set plus the root, so a surviving descendant is NAMED in the
 *  receipt and endProcessTreeSurvivors has a target — the root-only probe
 *  reported survivors:[] while a descendant lived on, and the second strike
 *  could never run on the platform that needs it most (FN-015 rank 20).
 *  First PID token per line: a line names its acted process first, and the
 *  parenthesised parent that may follow never joins. */
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

/** Alive probe: signal 0 delivers nothing but reports existence. EPERM means
 *  the process exists under another owner — alive. */
function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type PosixTableRow = { pid: number; ppid: number; pgid: number }

/** One process-table snapshot (`ps -A -o pid=,ppid=,pgid=` — BSD and procps
 *  alike). Empty on any failure: the caller degrades to a strike without a
 *  walk rather than throwing. */
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

/** The owned set for a root: the ppid-closure descendants of every root pid,
 *  plus (when the root leads its own group) every member of that group.
 *  Mercury's own pid and system pids are never targets. */
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

/** Zombie amnesty for the survivor list: a state-Z process is dead and merely
 *  awaits its parent's wait — it counts as ended. ps failure keeps the pid a
 *  survivor (honest under-claim). */
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

/** Signal one pid, swallowing ESRCH (already gone) and every other refusal —
 *  the bounded reap is what reports the truth. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone, or not ours to signal */
  }
}

async function endPosixTree(pid: number, signal: NodeJS.Signals): Promise<ProcessTreeKillReceipt> {
  const table = await listPosixProcessTable()
  const rootRow = table.find(row => row.pid === pid)
  // Group semantics only when the root LEADS its group: a non-leader shares
  // Mercury's own group, and sweeping that would kill Mercury itself.
  const groupPgid = rootRow !== undefined && rootRow.pgid === pid ? pid : undefined
  const targets =
    table.length > 0
      ? collectPosixTargets(table, new Set([pid]), groupPgid)
      : new Set(pid > 1 && pid !== process.pid ? [pid] : [])

  // Strike: the atomic group signal first (it also reaches a member spawned
  // after the snapshot), then every walked target by pid.
  try {
    process.kill(-pid, signal)
  } catch {
    /* not a group leader, or the group is already gone */
  }
  for (const target of targets) signalPid(target, signal)

  // One re-walk after a poll step: a child spawned between snapshot and
  // strike whose parent is still winding down is caught here; a descendant
  // that daemonised inside that window has no parent chain left to find —
  // the one honest residue this owner cannot reach (taskkill /T shares it).
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

  // Bounded reap: non-blocking aliveness polls, then zombie amnesty.
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
      // A nonzero exit still carries the per-process lines for what DID die;
      // "no such process" reports zero lines and the reap below tells the truth.
      resolve(typeof out === 'string' ? out : String(out ?? ''))
    })
  })
  // Bounded reap over the WHOLE acted set plus the root — the transcript is
  // the descendant snapshot taskkill's walk took, and a root-only probe told
  // no truth about the tree (FN-015 rank 20). No extra process spawns: the
  // snapshot was already in hand.
  const acted = taskkillActedPids(stdout)
  const watched = acted.includes(pid) ? acted : [pid, ...acted]
  let remaining = watched.filter(isAlivePid)
  const deadline = Date.now() + REAP_BOUND_MS
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(REAP_POLL_MS)
    remaining = remaining.filter(isAlivePid)
  }
  // Ended = acted pids confirmed gone. A root taskkill refused and never
  // acted on ("no such process", access denied) is not a kill this owner
  // may claim: that case keeps ended 0 with the honest survivor list.
  const ended = acted.filter(actedPid => !remaining.includes(actedPid)).length
  return { ended, survivors: remaining }
}

/**
 * End a whole process tree and report what settled. The receipt counts every
 * process the kill saw alive and confirmed gone within the reap bound;
 * survivors are reported, never waited on forever. Never rejects.
 */
export async function endProcessTree(
  target: Pick<ChildProcess, 'pid' | 'kill'> | number,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<ProcessTreeKillReceipt> {
  const pid = typeof target === 'number' ? target : target.pid
  if (!pid || pid <= 0) return { ended: 0, survivors: [] }
  try {
    return process.platform === 'win32' ? await endWin32Tree(pid) : await endPosixTree(pid, signal)
  } catch {
    // Last resort: signal the direct target so at least the leader dies.
    if (typeof target !== 'number') {
      try {
        target.kill(signal)
      } catch {
        /* already dead */
      }
    } else {
      signalPid(pid, signal)
    }
    return { ended: 0, survivors: isAlivePid(pid) ? [pid] : [] }
  }
}

/**
 * THE SECOND STRIKE: kill the FIRST phase's survivors BY PID, then walk the
 * root again for late children. A graceful phase that killed the root
 * reparents its detached descendants to pid 1 — a fresh walk from the dead
 * root finds nothing, and a never-connected server's grandchild lived on
 * (prove-connect-deadline §1, the mcp run-2 red). The receipt's own survivor
 * list is the one truth that outlives the root, so it is struck first.
 */
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

/**
 * The fire-and-forget door every non-stop caller uses: same owner, same
 * snapshot-walk-strike-reap sequence, receipt discarded. Callers that owe
 * the operator a count (the task stop path) call endProcessTree directly.
 */
export function killProcessGroup(
  childProcess: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  const pid = childProcess.pid
  if (!pid || pid <= 0) return
  void endProcessTree(childProcess, signal)
}
