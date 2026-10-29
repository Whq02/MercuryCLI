import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { MERCURY_PROJECT_DIR } from '../projectConfig.js'
import { preparedSecurityParse, type SimpleCommand } from './decision/commandAnalysis.js'
import { getProjectTempDir, getScratchpadDir, MERCURY_WORKING_FOLDERS, pathInWorkingPath } from './filesystem.js'

const OWN_GROUND_SCRATCHPAD = "the session's scratchpad"
const OWN_GROUND_CREATED = 'a path this session created'
const OWN_GROUND_WORKING_FILES = "Mercury's own working files"

const LEDGER_FILE = 'created-paths.txt'
const ledgers = new Map<string, Set<string>>()

function canonical(path: string, cwd: string = getOriginalCwd()): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    return safeResolvePath(getFsImplementation(), absolute).resolvedPath
  } catch {
    return absolute
  }
}

function ledgerPath(): string {
  return join(getProjectTempDir(), String(getSessionId()), LEDGER_FILE)
}

function ledger(): Set<string> {
  const path = ledgerPath()
  const cached = ledgers.get(path)
  if (cached !== undefined) return cached
  const loaded = new Set<string>()
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) if (line !== '') loaded.add(line)
  } catch {
    loaded.clear()
  }
  ledgers.set(path, loaded)
  return loaded
}

function recordCreatedPaths(paths: readonly string[], cwd?: string): void {
  if (paths.length === 0) return
  const store = ledger()
  const added: string[] = []
  for (const path of paths) {
    const resolved = canonical(path, cwd)
    if (resolved === '/' || store.has(resolved)) continue
    store.add(resolved)
    added.push(resolved)
  }
  if (added.length === 0) return
  try {
    const file = ledgerPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, added.map(path => `${path}\n`).join(''))
  } catch {
    return
  }
}

export function createdByThisRun(path: string): boolean {
  const resolved = canonical(path)
  for (const created of ledger()) if (pathInWorkingPath(resolved, created)) return true
  return false
}

export function ownGroundCategory(path: string): string | null {
  const resolved = canonical(path)
  if (pathInWorkingPath(resolved, getScratchpadDir())) return OWN_GROUND_SCRATCHPAD
  if (createdByThisRun(resolved)) return OWN_GROUND_CREATED
  const estate = join(getOriginalCwd(), MERCURY_PROJECT_DIR)
  for (const folder of MERCURY_WORKING_FOLDERS) {
    if (pathInWorkingPath(resolved, join(estate, folder))) return OWN_GROUND_WORKING_FILES
  }
  return null
}

function isOwnGround(path: string, cwd?: string): boolean {
  return ownGroundCategory(canonical(path, cwd)) !== null
}

function pathOperands(args: readonly string[]): string[] {
  const operands: string[] = []
  let optionsEnded = false
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (optionsEnded || !arg.startsWith('-')) operands.push(arg)
  }
  return operands
}

const OWN_GROUND_VERBS: ReadonlySet<string> = new Set(['mkdir', 'rmdir', 'touch', 'rm', 'mv', 'cp'])

export function ownGroundCommand(command: SimpleCommand, cwd: string): boolean {
  const [name, ...args] = command.argv
  if (name === undefined || !OWN_GROUND_VERBS.has(name)) return false
  const operands = pathOperands(args)
  if (operands.length === 0) return false
  if (command.redirects.some(redirect => redirect.op !== '<' && !/^\d+$/.test(redirect.target) && !isOwnGround(redirect.target, cwd))) return false
  return operands.every(operand => isOwnGround(operand, cwd))
}

type CreationSnapshot = { cwd: string; targets: string[] }

function topmostMissing(path: string): string | null {
  let current = path
  let topmost: string | null = null
  while (!existsSync(current)) {
    topmost = current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return topmost
}

export function snapshotCreations(command: string, cwd: string): CreationSnapshot {
  const snapshot: CreationSnapshot = { cwd, targets: [] }
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple') return snapshot
  let current: string | null = cwd
  for (const simple of parsed.commands) {
    const [name, ...args] = simple.argv
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const operands = pathOperands(args)
      current = name === 'cd' && operands.length === 1 && current !== null && !operands[0]!.startsWith('~') && !operands[0]!.includes('$') ? resolve(current, operands[0]!) : null
      continue
    }
    if (name !== 'mkdir' || current === null) continue
    for (const operand of pathOperands(args)) {
      const absolute = resolve(current, operand)
      const created = topmostMissing(absolute)
      if (created !== null) snapshot.targets.push(created)
    }
  }
  return snapshot
}

export function settleCreations(snapshot: CreationSnapshot, exitCode: number | null | undefined): void {
  if (exitCode !== 0 || snapshot.targets.length === 0) return
  recordCreatedPaths(snapshot.targets.filter(target => existsSync(target)), snapshot.cwd)
}

export function beginCreation(filePath: string): string | null {
  return topmostMissing(filePath)
}

export function settleCreation(created: string | null): void {
  if (created !== null && existsSync(created)) recordCreatedPaths([created])
}

function _resetOwnGroundForTesting(): void {
  ledgers.clear()
}
