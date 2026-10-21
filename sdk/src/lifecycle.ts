import type { ChildProcess } from 'node:child_process'
import { setMaxListeners } from 'node:events'
import { statSync } from 'node:fs'
import type { StreamRow } from './parse.js'

const live = new Set<ChildProcess>()
let hooked = false

export function unlimitedSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined) try { setMaxListeners(0, signal) } catch {}
}

export function capRows(rows: StreamRow[], max: number | undefined): void {
  if (max === undefined) return
  if (max <= 0) { rows.length = 0; return }
  const drop = rows[0]?.type === 'session' && max > 1 ? 1 : 0
  while (rows.length > max) rows.splice(drop, 1)
}

export function missingCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  try {
    if (statSync(cwd).isDirectory()) return undefined
  } catch {}
  return `the working directory does not exist: ${cwd}`
}

export function track(child: ChildProcess): void {
  if (!hooked) {
    hooked = true
    process.once('exit', () => {
      for (const child of live) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    })
  }
  live.add(child)
  child.once('close', () => live.delete(child))
}

export async function endChild(child: ChildProcess, exit: Promise<unknown>): Promise<void> {
  child.stdin?.end()
  const terminate = setTimeout(() => child.kill('SIGTERM'), 5000)
  const kill = setTimeout(() => child.kill('SIGKILL'), 10000)
  try { await exit } finally { clearTimeout(terminate); clearTimeout(kill) }
}
