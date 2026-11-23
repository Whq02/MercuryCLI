import { getCwdState, getOriginalCwd } from '../../boot/process-state/processState.js'
import { getOwnerContext, withOwnerContext } from '../../engine/run-owner/ownerContext.js'

export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return withOwnerContext({ directory: { cwd, shellCwd: null } }, fn)
}

export function runWithOwnShellCwd<T>(fn: () => T): T {
  return withOwnerContext({ directory: { cwd: getCwd(), shellCwd: null } }, fn)
}

export function contextShellCwd(): string | null | undefined {
  const store = getOwnerContext()?.directory
  return store === undefined ? undefined : store.shellCwd
}

export function setContextShellCwd(next: string | null): boolean {
  const store = getOwnerContext()?.directory
  if (store === undefined) return false
  store.shellCwd = next
  return true
}

let whereACdLeftTheShell: (() => string | null) | undefined

export function tellWhereACdLeftTheShell(read: () => string | null): void {
  whereACdLeftTheShell = read
}

let whereTheShellStands: (() => string) | undefined

export function tellWhereTheShellStands(read: () => string): void {
  whereTheShellStands = read
}

export function getStartingCwd(): string {
  return getOwnerContext()?.directory?.cwd ?? getOriginalCwd()
}

export function pwd(): string {
  return getOwnerContext()?.directory?.cwd ?? getCwdState()
}

export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}

export function shellDirectoryLeftByCd(): string | null {
  const directory = whereACdLeftTheShell === undefined ? null : whereACdLeftTheShell()
  if (directory === null) return null
  return `The shell's working directory is still where an earlier cd left it: ${/["\p{Cc}]/u.test(directory) ? JSON.stringify(directory) : directory}`
}

export function directoryTheShellStandsIn(): string {
  return whereTheShellStands === undefined ? getCwd() : whereTheShellStands()
}
