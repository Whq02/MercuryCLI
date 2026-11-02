import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const OWN_GROUP = process.platform !== 'win32'

export function requirePositivePid(pid: number | undefined): number {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Proof requires a process pid above 1; received ${String(pid)}`)
  return pid
}

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
