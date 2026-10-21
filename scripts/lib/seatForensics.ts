import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

const readProc = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

export function threadTable(pid: number): string[] {
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

export function nativeStacks(pid: number): string {
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
