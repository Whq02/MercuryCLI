import { execFile } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'

type ProcessTreeRow = { pid: number; ppid: number; pgid: number }

export function parseProcessTreeRows(text: string): ProcessTreeRow[] {
  const rows: ProcessTreeRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (match !== null) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) })
  }
  return rows
}

export function processTreeUnder(rows: readonly ProcessTreeRow[], rootPid: number): number[] {
  const byParent = new Map<number, number[]>()
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row.pid])
  const members = new Set<number>()
  const queue = [...(byParent.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (pid === rootPid || members.has(pid)) continue
    members.add(pid)
    queue.push(...(byParent.get(pid) ?? []))
  }
  if (rows.some(row => row.pid === rootPid && row.pgid === rootPid)) {
    for (const row of rows) if (row.pgid === rootPid && row.pid !== rootPid) members.add(row.pid)
  }
  return [...members].filter(pid => pid > 1 && pid !== process.pid)
}

export function readProcessTreeUnder(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return Promise.resolve([])
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid='],
      { env: { ...subprocessEnv(), LC_ALL: 'C' }, timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(error || typeof stdout !== 'string' ? [] : processTreeUnder(parseProcessTreeRows(stdout), rootPid)),
    )
  })
}
