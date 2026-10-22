import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const readProc = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

const ran = (cmd: string, args: string[], timeout = 5_000): string => {
  try {
    return (spawnSync(cmd, args, { encoding: 'utf8', timeout }).stdout ?? '').trim()
  } catch {
    return ''
  }
}

function threadTable(pid: number): string[] {
  if (process.platform !== 'linux') return []
  let tids: string[] = []
  try {
    tids = readdirSync(`/proc/${pid}/task`)
  } catch {
    return []
  }
  return tids.map(tid => {
    const stat = readProc(`/proc/${pid}/task/${tid}/stat`)
    const name = /\((.*)\)/.exec(stat)?.[1] ?? '?'
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '?'
    const wchan = readProc(`/proc/${pid}/task/${tid}/wchan`) || '?'
    const syscall = readProc(`/proc/${pid}/task/${tid}/syscall`).split(' ').slice(0, 4).join(' ') || '?'
    return `tid ${tid} "${name}" ${state} · wchan ${wchan} · syscall ${syscall}`
  })
}

function nativeStacks(pid: number): string {
  if (process.platform !== 'linux') return ''
  const gdb = (spawnSync('which', ['gdb'], { encoding: 'utf8', timeout: 5_000 }).stdout ?? '').trim()
  if (gdb === '') return 'no gdb on this box'
  const asRoot = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 5_000 }).status === 0
  const argv = [...(asRoot ? ['-n', gdb] : []), '-p', String(pid), '-batch', '-ex', 'set pagination off', '-ex', 'thread apply all bt 40']
  const run = spawnSync(asRoot ? 'sudo' : gdb, argv, { encoding: 'utf8', timeout: 90_000 })
  const lines = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').filter(line => /^(Thread \d|#\d+ )/.test(line))
  return lines.length === 0 ? `gdb printed no frames (rc ${run.status}): ${(run.stderr ?? '').trim().slice(0, 300)}` : lines.slice(0, 200).join('\n')
}

export function seatForensics(pid: number): string {
  const threads = threadTable(pid)
  if (threads.length === 0) return ''
  return `threads of ${pid}:\n    ${threads.join('\n    ')}\n  native stacks of ${pid}:\n    ${nativeStacks(pid).split('\n').join('\n    ')}`
}

export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  if (process.platform === 'linux') {
    const stat = readProc(`/proc/${pid}/stat`)
    if (stat === '') return true
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? ''
    return state === 'Z' || state === 'X'
  }
  const stat = ran('ps', ['-o', 'stat=', '-p', String(pid)]).trim()
  return stat === '' || stat.startsWith('Z')
}

export function seatState(pid: number): string {
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/status`)) {
    const status = readProc(`/proc/${pid}/status`).split('\n').filter(l => /^(State|VmRSS|Threads):/.test(l)).map(l => l.replace(/\s+/g, ' ')).join(' · ')
    const wchan = readProc(`/proc/${pid}/wchan`) || '?'
    const exe = ran('readlink', [`/proc/${pid}/exe`]) || '?'
    return `the seat ${pid} (${exe}) waits in ${wchan} · ${status}`
  }
  const line = ran('ps', ['-o', 'stat=,rss=,etime=,wchan=,comm=', '-p', String(pid)]).replace(/\s+/g, ' ')
  if (line === '') return `the seat ${pid}: gone (ps names no such process)`
  const [stat = '?', rss = '?', etime = '?', wchan = '?', ...comm] = line.split(' ')
  return `the seat ${pid} (${comm.join(' ') || '?'}) waits in ${wchan} · State: ${stat} · RSS: ${rss} kB · elapsed ${etime}`
}

function seatChildren(pid: number): string[] {
  return ran('ps', ['-eo', 'pid,ppid,stat,args'])
    .split('\n')
    .filter(l => l.trim().split(/\s+/)[1] === String(pid))
    .map(l => l.trim().slice(0, 160))
}

function seatSockets(pid: number): string[] {
  if (process.platform === 'linux') {
    return ran('ss', ['-tanp'])
      .split('\n')
      .filter(l => l.includes(`pid=${pid},`))
      .map(l => l.split(/\s+/).slice(0, 5).join(' '))
      .slice(0, 8)
  }
  return ran('lsof', ['-nP', '-a', '-p', String(pid), '-i'], 10_000)
    .split('\n')
    .slice(1)
    .map(l => l.split(/\s+/).slice(4).join(' ').slice(0, 120))
    .filter(l => l !== '')
    .slice(0, 8)
}

function seatThreads(pid: number): string[] {
  if (process.platform === 'linux') return threadTable(pid)
  const rows = ran('ps', ['-M', '-p', String(pid)]).split('\n').slice(1).map(l => l.trim().replace(/\s+/g, ' ').slice(0, 120)).filter(l => l !== '')
  return rows.slice(0, 16)
}

function logTail(path: string | undefined, keep = 25): string {
  if (path === undefined) return '(no seat log was asked for: launch with --log-file)'
  if (!existsSync(path)) return `(no seat log at ${path})`
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '')
  return lines.length === 0 ? `(the seat log ${path} is empty)` : lines.slice(-keep).join('\n')
}

export function silentSeatReport(pid: number, opts: { logFile?: string; logLines?: number } = {}): string {
  const indent = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n    '))
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  const tail = `the seat's own log (last lines):\n    ${logTail(opts.logFile, opts.logLines).split('\n').join('\n    ')}`
  if (!alive) return `the seat ${pid} is gone already\n  ${tail}`
  const parts = [seatState(pid), `threads:\n    ${indent(seatThreads(pid))}`, `children:\n    ${indent(seatChildren(pid))}`, `sockets:\n    ${indent(seatSockets(pid))}`]
  if (process.platform === 'linux') parts.push(`native stacks:\n    ${nativeStacks(pid).split('\n').join('\n    ')}`)
  parts.push(tail)
  return parts.join('\n  ')
}
