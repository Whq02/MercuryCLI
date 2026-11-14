import { spawn } from 'node:child_process'
import { appendFileSync, constants, existsSync, lstatSync, lutimesSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink, unlink, utimes } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { subprocessEnv } from './subprocessEnv.js'

export type CloneOutcome = 'cloned' | 'present' | 'missing' | 'outside' | 'unsupported' | 'failed'

type ClonePair = { source: string; target: string }

type AdmittedPair = { index: number; source: string; target: string; volumes: string }

type CloneRoad = 'clonefile' | 'files'

type FolderStamp = { path: string; mode: number; atime: number; mtime: number }

type CloneScope = { spellings: readonly string[]; worktree: string }

const CLONE_ANSWER_BOUND_MS = 120_000
const OSASCRIPT = '/usr/bin/osascript'
const EEXIST = 17
const EXDEV = 18
const ENOTSUP = 45
const REFLINKS_AT_ONCE = 16
const FOLDERS_AT_ONCE = 8
const NO_REFLINK_CODES: ReadonlySet<string> = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS', 'ENOTTY'])

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

const volumesThatCannotClone = new Set<string>()

function cloneRoad(): CloneRoad | null {
  const seam = process.env.MERCURY_WORKTREE_CLONE
  if (seam === 'off') return null
  if (seam === 'files') return 'files'
  if (process.platform === 'darwin') return 'clonefile'
  if (process.platform === 'linux') return 'files'
  return null
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

function placeInCheckout(path: string, scope: CloneScope): string | null {
  for (const root of scope.spellings) {
    if (path === root) return ''
    if (pathWithin(path, root)) return relative(root, path)
  }
  return null
}

function linkTargetInCopy(raw: string, linkInSource: string, linkInCopy: string, scope: CloneScope): string {
  const pointed = resolve(dirname(linkInSource), raw)
  const place = placeInCheckout(pointed, scope)
  if (place === null) return isAbsolute(raw) ? raw : pointed
  const wanted = join(scope.worktree, place)
  if (isAbsolute(raw)) return wanted
  if (resolve(dirname(linkInCopy), raw) === wanted) return raw
  return relative(dirname(linkInCopy), wanted) || '.'
}

async function admitPair(pair: ClonePair, index: number, checkout: string, road: CloneRoad): Promise<AdmittedPair | CloneOutcome> {
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
  if (road === 'clonefile' && device !== sourceStat.dev) return 'unsupported'
  const volumes = `${sourceStat.dev}:${device}`
  if (volumesThatCannotClone.has(volumes)) return 'unsupported'
  return { index, source, target: pair.target, volumes }
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

async function settleClone(source: string, target: string, scope: CloneScope): Promise<void> {
  let level = [{ from: source, to: target }]
  while (level.length > 0) {
    const below: Array<{ from: string; to: string }> = []
    await eachAtOnce(level, FOLDERS_AT_ONCE, async ({ from, to }) => {
      const folder = await lstat(to)
      if ((folder.mode & 0o200) === 0) await chmod(to, (folder.mode & 0o7777) | 0o200)
      for (const entry of await readdir(to, { withFileTypes: true })) {
        if (entry.isDirectory()) below.push({ from: join(from, entry.name), to: join(to, entry.name) })
        if (!entry.isSymbolicLink()) continue
        const link = join(to, entry.name)
        const raw = await readlink(link)
        const wanted = linkTargetInCopy(raw, join(from, entry.name), link, scope)
        if (wanted === raw) continue
        await unlink(link)
        await symlink(wanted, link)
      }
    })
    level = below
  }
}

async function clonefileAdmitted(admitted: readonly AdmittedPair[], outcomes: CloneOutcome[], scope: CloneScope): Promise<void> {
  const codes = await clonefileEach(admitted)
  for (const [at, pair] of admitted.entries()) {
    const code = codes === null ? null : (codes[at] as number)
    if (code === 0 && (await pathPresent(pair.target).catch(() => false))) {
      try {
        await settleClone(pair.source, pair.target, scope)
        outcomes[pair.index] = 'cloned'
      } catch (error) {
        await rm(pair.target, { recursive: true, force: true }).catch(() => {})
        logForDebugging(`worktree clone: the clone of ${pair.source} could not be settled (${String(error)}); the folder is linked as before`, { level: 'warn' })
      }
      continue
    }
    if (code === EEXIST) {
      outcomes[pair.index] = 'present'
      continue
    }
    await rm(pair.target, { recursive: true, force: true }).catch(() => {})
    if (code === ENOTSUP || code === EXDEV) {
      if (code === ENOTSUP) volumesThatCannotClone.add(pair.volumes)
      outcomes[pair.index] = 'unsupported'
      logForDebugging(`worktree clone: the volume of ${pair.source} cannot clone (errno ${code}); the folder is linked as before`)
      continue
    }
    logForDebugging(`worktree clone: ${pair.source} was not cloned (${code === null ? 'no answer' : `errno ${code}`}); the folder is linked as before`, { level: 'warn' })
  }
}

async function eachAtOnce<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failure: unknown
  const run = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next++] as T
      try {
        await work(item)
      } catch (error) {
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  if (failure !== undefined) throw failure
}

async function reflinkTree(source: string, target: string, scope: CloneScope): Promise<CloneOutcome> {
  try {
    await mkdir(target)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'present' : 'failed'
  }
  const folders: FolderStamp[] = []
  let reflinked = 0
  try {
    const pending = [{ from: source, to: target }]
    while (pending.length > 0) {
      const { from, to } = pending.pop() as { from: string; to: string }
      const folder = await lstat(from)
      if (to !== target) await mkdir(to)
      folders.push({ path: to, mode: folder.mode & 0o7777, atime: folder.atimeMs / 1000, mtime: folder.mtimeMs / 1000 })
      const files: Array<{ from: string; to: string }> = []
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const child = { from: join(from, entry.name), to: join(to, entry.name) }
        if (entry.isDirectory()) pending.push(child)
        else if (entry.isSymbolicLink()) await symlink(linkTargetInCopy(await readlink(child.from), child.from, child.to, scope), child.to)
        else if (entry.isFile()) files.push(child)
      }
      await eachAtOnce(files, REFLINKS_AT_ONCE, async file => {
        const times = await lstat(file.from)
        await copyFile(file.from, file.to, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
        await utimes(file.to, times.atimeMs / 1000, times.mtimeMs / 1000)
        reflinked++
      })
    }
    for (const folder of folders.reverse()) {
      await chmod(folder.path, folder.mode | 0o200)
      await utimes(folder.path, folder.atime, folder.mtime)
    }
    return 'cloned'
  } catch (error) {
    for (const folder of folders) await chmod(folder.path, 0o700).catch(() => {})
    await rm(target, { recursive: true, force: true }).catch(() => {})
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (reflinked === 0 && NO_REFLINK_CODES.has(code)) return 'unsupported'
    logForDebugging(`worktree clone: ${source} was not cloned file by file (${code === '' ? String(error) : code}); the folder is linked as before`, { level: 'warn' })
    return 'failed'
  }
}

async function reflinkAdmitted(admitted: readonly AdmittedPair[], outcomes: CloneOutcome[], scope: CloneScope): Promise<void> {
  for (const pair of admitted) {
    if (volumesThatCannotClone.has(pair.volumes)) {
      outcomes[pair.index] = 'unsupported'
      continue
    }
    const outcome = await reflinkTree(pair.source, pair.target, scope)
    outcomes[pair.index] = outcome
    if (outcome !== 'unsupported') continue
    volumesThatCannotClone.add(pair.volumes)
    logForDebugging(`worktree clone: the filesystem of ${pair.source} cannot reflink into ${dirname(pair.target)}; the folder is linked as before`)
  }
}

export async function cloneIntoWorktree(pairs: readonly ClonePair[], checkoutRoot: string, worktreeRoot: string): Promise<CloneOutcome[]> {
  if (pairs.length === 0) return []
  const road = cloneRoad()
  if (road === null) return pairs.map(() => 'unsupported')
  const outcomes: CloneOutcome[] = pairs.map(() => 'failed')
  const admitted: AdmittedPair[] = []
  let checkout: string
  try {
    checkout = await realpath(checkoutRoot)
  } catch {
    return outcomes
  }
  const scope: CloneScope = { spellings: [...new Set([checkout, resolve(checkoutRoot)])], worktree: resolve(worktreeRoot) }
  for (const [index, pair] of pairs.entries()) {
    try {
      const verdict = await admitPair(pair, index, checkout, road)
      if (typeof verdict === 'string') outcomes[index] = verdict
      else admitted.push(verdict)
    } catch (error) {
      logForDebugging(`worktree clone: ${pair.source} could not be read for cloning: ${String(error)}`, { level: 'warn' })
    }
  }
  if (admitted.length === 0) return outcomes
  if (road === 'clonefile') await clonefileAdmitted(admitted, outcomes, scope)
  else await reflinkAdmitted(admitted, outcomes, scope)
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
