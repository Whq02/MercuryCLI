import type { ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'

const live = new Set<ChildProcess>()
let hooked = false

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
