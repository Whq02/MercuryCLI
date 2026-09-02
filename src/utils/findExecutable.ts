import { whichSync } from './which.js'

/**
 * PATH lookup for an executable, returned in a spawn-shaped record (the
 * shape of the process-spawning helper this replaced, kept to avoid a large
 * reactive-streams dependency). A failed lookup keeps the original name.
 */
export function findExecutable(exe: string, args: string[]): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
