import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const OWN_GROUP = process.platform !== 'win32'

export function spawnInOwnGroup(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, [...args], { ...options, detached: OWN_GROUP })
}

export function endProcessGroup(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined) return
  if (OWN_GROUP) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
    }
  }
  try {
    child.kill(signal)
  } catch {
  }
}
