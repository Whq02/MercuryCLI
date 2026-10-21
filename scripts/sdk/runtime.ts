import { spawnSync } from 'node:child_process'

export const BUN = process.execPath

export function resolvePython(env: NodeJS.ProcessEnv = process.env): string {
  for (const [cmd, ...lead] of [['python3'], ['python'], ['py', '-3']] as const) {
    const probe = spawnSync(cmd, [...lead, '-c', 'import sys; print(sys.executable)'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true })
    if (probe.status === 0) return lead.length ? probe.stdout.trim() || cmd : cmd
  }
  return 'python3'
}

export const PYTHON = resolvePython()
