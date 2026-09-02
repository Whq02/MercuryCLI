import { whichSync } from './which.js'

export function findExecutable(exe: string, args: string[]): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
