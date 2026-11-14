import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, lutimesSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { subprocessEnv } from './subprocessEnv.js'

export type CloneOutcome = 'cloned' | 'present' | 'missing' | 'outside' | 'unsupported' | 'failed'

type ClonePair = { source: string; target: string }

type AdmittedPair = { index: number; source: string; target: string; device: number }

const CLONE_ANSWER_BOUND_MS = 120_000
const OSASCRIPT = '/usr/bin/osascript'
const EEXIST = 17
const EXDEV = 18
const ENOTSUP = 45

const CLONEFILE_SCRIPT = [
  'function run() {',
  "  ObjC.import('Foundation')",
  "  ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'int']])",
  "  ObjC.bindFunction('__error', ['int *', []])",
  '  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile',
  '  var pairs = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))',
  '  var codes = []',
  '  for (var i = 0; i < pairs.length; i++) codes.push($.clonefile(pairs[i][0], pairs[i][1], 1) === 0 ? 0 : ($.__error()[0] || -1))',
  '  return JSON.stringify(codes)',
  '}',
].join('\n')

const devicesThatCannotClone = new Set<number>()

function cloneRoadOpen(): boolean {
  return process.env.MERCURY_WORKTREE_CLONE !== 'off' && process.platform === 'darwin'
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function pathWithin(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function admitPair(pair: ClonePair, index: number, checkout: string): Promise<AdmittedPair | CloneOutcome> {
  let source: string
  try {
    source = await realpath(pair.source)
  } catch {
    return 'missing'
  }
  const sourceStat = await stat(source)
  if (!sourceStat.isDirectory()) return 'missing'
  if (!pathWithin(source, checkout)) return 'outside'
  if (await pathPresent(pair.target)) return 'present'
  await mkdir(dirname(pair.target), { recursive: true })
  const parent = await realpath(dirname(pair.target))
  if (parent === source || pathWithin(parent, source)) return 'unsupported'
  const device = (await stat(parent)).dev
  if (device !== sourceStat.dev || devicesThatCannotClone.has(device)) return 'unsupported'
  return { index, source, target: pair.target, device }
}

async function clonefileEach(admitted: readonly AdmittedPair[]): Promise<number[] | null> {
  const answer = await execFileNoThrowWithCwd(OSASCRIPT, ['-l', 'JavaScript', '-e', CLONEFILE_SCRIPT], {
    input: JSON.stringify(admitted.map(pair => [pair.source, pair.target])),
    timeout: CLONE_ANSWER_BOUND_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (answer.code !== 0) {
    logForDebugging(`worktree clone: osascript gave no answer (${answer.error ?? answer.code}): ${answer.stderr.trim().split('\n')[0] ?? ''}`, { level: 'warn' })
    return null
  }
  try {
    const codes: unknown = JSON.parse(answer.stdout.trim())
    if (Array.isArray(codes) && codes.length === admitted.length && codes.every(code => Number.isInteger(code))) return codes as number[]
  } catch {
  }
  logForDebugging(`worktree clone: osascript answered something else than its codes: ${answer.stdout.trim().slice(0, 120)}`, { level: 'warn' })
  return null
}

export async function cloneIntoWorktree(pairs: readonly ClonePair[], checkoutRoot: string): Promise<CloneOutcome[]> {
  if (pairs.length === 0) return []
  if (!cloneRoadOpen()) return pairs.map(() => 'unsupported')
  const outcomes: CloneOutcome[] = pairs.map(() => 'failed')
  const admitted: AdmittedPair[] = []
  let checkout: string
  try {
    checkout = await realpath(checkoutRoot)
  } catch {
    return outcomes
  }
  for (const [index, pair] of pairs.entries()) {
    try {
      const verdict = await admitPair(pair, index, checkout)
      if (typeof verdict === 'string') outcomes[index] = verdict
      else admitted.push(verdict)
    } catch (error) {
      logForDebugging(`worktree clone: ${pair.source} could not be read for cloning: ${String(error)}`, { level: 'warn' })
    }
  }
  if (admitted.length === 0) return outcomes
  const codes = await clonefileEach(admitted)
  for (const [at, pair] of admitted.entries()) {
    const code = codes === null ? null : (codes[at] as number)
    if (code === 0 && (await pathPresent(pair.target).catch(() => false))) {
      outcomes[pair.index] = 'cloned'
      continue
    }
    if (code === EEXIST) {
      outcomes[pair.index] = 'present'
      continue
    }
    await rm(pair.target, { recursive: true, force: true }).catch(() => {})
    if (code === ENOTSUP || code === EXDEV) {
      if (code === ENOTSUP) devicesThatCannotClone.add(pair.device)
      outcomes[pair.index] = 'unsupported'
      logForDebugging(`worktree clone: the volume of ${pair.source} cannot clone (errno ${code}); the folder is linked as before`)
      continue
    }
    logForDebugging(`worktree clone: ${pair.source} was not cloned (${code === null ? 'no answer' : `errno ${code}`}); the folder is linked as before`, { level: 'warn' })
  }
  return outcomes
}

const CLONES_FILENAME = 'WORKTREE_CLONES'
const SET_ASIDE_MARK = '.removing-'
const SET_ASIDE_HOME = 'worktrees'
const SET_ASIDE_GRACE_MS = 60 * 60 * 1000
const DISCARD_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const root = process.argv[1]',
  'const isFolder = entry => {',
  '  try { return fs.lstatSync(entry).isDirectory() } catch { return false }',
  '}',
  'const open = dir => {',
  '  if (!isFolder(dir)) return',
  '  try { fs.chmodSync(dir, 0o700) } catch {}',
  '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) open(path.join(dir, entry.name))',
  '}',
  `if (path.basename(root).startsWith('${SET_ASIDE_MARK}') && path.basename(path.dirname(root)) === '${SET_ASIDE_HOME}') {`,
  '  if (!isFolder(root)) {',
  '    try { fs.unlinkSync(root) } catch {}',
  '  } else {',
  '    try {',
  '      fs.rmSync(root, { recursive: true, force: true })',
  '    } catch {',
  '      try { open(root); fs.rmSync(root, { recursive: true, force: true }) } catch {}',
  '    }',
  '  }',
  '}',
].join('\n')

function worktreeAdminDir(worktreePath: string): string | null {
  try {
    const pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim()
    return pointer.startsWith('gitdir:') ? resolve(worktreePath, pointer.slice('gitdir:'.length).trim()) : null
  } catch {
    return null
  }
}

export function recordWorktreeClones(worktreePath: string, relPaths: readonly string[]): void {
  const adminDir = worktreeAdminDir(worktreePath)
  if (adminDir === null || relPaths.length === 0) return
  try {
    appendFileSync(join(adminDir, CLONES_FILENAME), relPaths.map(relPath => `${relPath}\n`).join(''))
  } catch (error) {
    logForDebugging(`worktree clone: the record of what ${worktreePath} holds as clones was not written: ${String(error)}`, { level: 'warn' })
  }
}

export function worktreeHoldsClones(worktreePath: string): boolean {
  const adminDir = worktreeAdminDir(worktreePath)
  return adminDir !== null && existsSync(join(adminDir, CLONES_FILENAME))
}

function isSetAside(path: string): boolean {
  return basename(path).startsWith(SET_ASIDE_MARK) && basename(dirname(path)) === SET_ASIDE_HOME
}

export function setWorktreeAside(worktreePath: string): string | null {
  const aside = join(dirname(worktreePath), `${SET_ASIDE_MARK}${basename(worktreePath)}-${process.pid}-${Date.now().toString(36)}`)
  if (!isSetAside(aside)) return null
  try {
    renameSync(worktreePath, aside)
    return aside
  } catch (error) {
    logForDebugging(`worktree clone: ${worktreePath} could not be set aside and is removed in place: ${String(error)}`)
    return null
  }
}

export function returnWorktreeFromAside(aside: string, worktreePath: string): void {
  try {
    renameSync(aside, worktreePath)
  } catch (error) {
    logForDebugging(`worktree clone: ${aside} could not be moved back to ${worktreePath}: ${String(error)}`, { level: 'warn' })
  }
}

export function discardSetAside(aside: string): void {
  if (!isSetAside(aside)) return
  const inProcess = (): void => {
    void rm(aside, { recursive: true, force: true }).catch(() => {})
  }
  try {
    const now = new Date()
    lutimesSync(aside, now, now)
  } catch {
  }
  try {
    const child = spawn(process.execPath, ['-e', DISCARD_SCRIPT, aside], { detached: true, stdio: 'ignore', windowsHide: true, env: subprocessEnv() })
    child.on('error', inProcess)
    child.unref()
  } catch {
    inProcess()
  }
}

export function sweepSetAside(home: string): number {
  let entries: string[]
  try {
    entries = readdirSync(home)
  } catch {
    return 0
  }
  let swept = 0
  for (const entry of entries) {
    if (!entry.startsWith(SET_ASIDE_MARK)) continue
    try {
      if (Date.now() - lstatSync(join(home, entry)).mtimeMs < SET_ASIDE_GRACE_MS) continue
    } catch {
      continue
    }
    discardSetAside(join(home, entry))
    swept++
  }
  return swept
}
