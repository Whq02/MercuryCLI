import { spawn } from 'node:child_process'
import { appendFileSync, constants, existsSync, lstatSync, lutimesSync, readdirSync, readFileSync, renameSync, type Dirent } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, utimes } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { subprocessEnv } from './subprocessEnv.js'

export type CloneOutcome = 'cloned' | 'present' | 'missing' | 'outside' | 'held' | 'unsupported' | 'failed'

export type HeldBack = (path: string) => boolean

type ClonePair = { source: string; target: string; leaveOut?: boolean }

type AdmittedPair = { index: number; source: string; target: string; staged: string; volumes: string; leaveOut: boolean }

type CloneRoad = 'clonefile' | 'cp' | 'walk'

type FolderStamp = { path: string; mode: number; atime: number; mtime: number }

type Quiet = 'quiet'

type CloneCalls = { folders: string[]; clones: string[]; links: string[] }

type HelperJob = { from: string; to: string; folders: readonly string[]; clones: readonly string[]; loose?: true }

type ListedFolder = { rel: string; parent: number; direct: number; total: number; folders: number[]; holdsBack: boolean; kept: boolean }

type CloneScope = { spellings: readonly string[]; worktree: string }

const CLONE_ANSWER_BOUND_MS = 120_000
const WALK_QUIET_BOUND_MS = 10_000
const OSASCRIPT = '/usr/bin/osascript'
const EXDEV = 18
const ENOTSUP = 45
const REFLINKS_AT_ONCE = 16
const FOLDERS_AT_ONCE = 8
const ENTRIES_A_CALL = 4096
const DIRECT_SHARE = 8
const PAIRS_AT_ONCE = 16
const SMALL_FOLDER_ENTRIES = 256
const POINTER_NAME = '.git'
const SOURCE_BOUND_NAMES: ReadonlySet<string> = new Set(['pyvenv.cfg', 'CMakeCache.txt'])
const NO_REFLINK_CODES: ReadonlySet<string> = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS', 'ENOTTY'])
const NAME_TAKEN_CODES: ReadonlySet<string> = new Set(['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'])
const STAGING_MARK = '.cloning-'
const SET_ASIDE_MARK = '.removing-'
const DEBRIS_HOME = 'worktrees'
const DEBRIS_GRACE_MS = 60 * 60 * 1000

const CLONEFILE_SCRIPT = [
  'function run() {',
  "  ObjC.import('Foundation')",
  "  ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'int']])",
  "  ObjC.bindFunction('copyfile', ['int', ['char *', 'char *', 'void *', 'int']])",
  "  ObjC.bindFunction('mkdir', ['int', ['char *', 'int']])",
  "  ObjC.bindFunction('__error', ['int *', []])",
  '  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile',
  '  var jobs = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))',
  '  var codes = []',
  '  for (var i = 0; i < jobs.length; i++) {',
  '    var job = jobs[i], code = 0, at',
  '    for (at = 0; code === 0 && at < job.folders.length; at++) if ($.mkdir(job.to + job.folders[at], 448) !== 0) code = $.__error()[0] || -1',
  '    for (at = 0; (job.loose || code === 0) && at < job.clones.length; at++) if ($.clonefile(job.from + job.clones[at], job.to + job.clones[at], 1) !== 0) { var failed = $.__error()[0] || -1; if (code === 0 && !(job.loose && failed === 17)) code = failed }',
  '    for (at = 0; code === 0 && at < job.folders.length; at++) if ($.copyfile(job.from + job.folders[at], job.to + job.folders[at], null, 262151) !== 0) code = $.__error()[0] || -1',
  '    codes.push(code)',
  '  }',
  '  return JSON.stringify(codes)',
  '}',
].join('\n')

const volumesThatCannotClone = new Set<string>()
const volumesThatClone = new Set<string>()
const cpAnswers = new Map<string, Promise<boolean>>()
let stagings = 0
let helperTurn: Promise<void> = Promise.resolve()

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = helperTurn.then(work)
  helperTurn = mine.then(
    () => {},
    () => {},
  )
  return mine
}

function cloneRoad(): CloneRoad | null {
  const seam = process.env.MERCURY_WORKTREE_CLONE
  if (seam === 'off') return null
  if (seam === 'files') return 'walk'
  if (seam === 'cp') return 'cp'
  if (process.platform === 'darwin') return 'clonefile'
  if (process.platform === 'linux') return 'cp'
  return null
}

function machineCpTakesReflink(): Promise<boolean> {
  const path = process.env.PATH ?? ''
  let answer = cpAnswers.get(path)
  if (answer === undefined) {
    answer = execFileNoThrowWithCwd('cp', ['--reflink=always', '--version'], { timeout: 10_000, maxBuffer: 64 * 1024 }).then(asked => asked.code === 0)
    cpAnswers.set(path, answer)
  }
  return answer
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

function staysBehind(entries: readonly Dirent[], leaveOut: boolean): boolean {
  return entries.some(entry => entry.isFile() && (entry.name === POINTER_NAME || (leaveOut && SOURCE_BOUND_NAMES.has(entry.name))))
}

async function admitPair(pair: ClonePair, index: number, checkout: string, road: CloneRoad, stage: string, held: HeldBack | undefined): Promise<AdmittedPair | CloneOutcome> {
  let source: string
  try {
    source = await realpath(pair.source)
  } catch {
    return 'missing'
  }
  const sourceStat = await stat(source)
  if (!sourceStat.isDirectory()) return 'missing'
  if (!pathWithin(source, checkout)) return 'outside'
  if (held?.(source) === true) return 'held'
  if (staysBehind(await readdir(source, { withFileTypes: true }), pair.leaveOut === true)) return 'held'
  if (await pathPresent(pair.target)) return 'present'
  await mkdir(dirname(pair.target), { recursive: true })
  const parent = await realpath(dirname(pair.target))
  const stageHome = await realpath(dirname(stage))
  if ([parent, stageHome].some(place => place === source || pathWithin(place, source))) return 'unsupported'
  const device = (await stat(parent)).dev
  if (road === 'clonefile' && device !== sourceStat.dev) return 'unsupported'
  const volumes = `${sourceStat.dev}:${device}`
  if (volumesThatCannotClone.has(volumes)) return 'unsupported'
  return { index, source, target: pair.target, staged: join(stage, String(index)), volumes, leaveOut: pair.leaveOut === true }
}

export async function planCloneCalls(source: string, held?: HeldBack, leaveOut = false): Promise<CloneCalls> {
  const listed: ListedFolder[] = [{ rel: '', parent: -1, direct: 0, total: 1, folders: [], holdsBack: false, kept: false }]
  let level = [0]
  while (level.length > 0) {
    const below: number[] = []
    await eachAtOnce(level, FOLDERS_AT_ONCE, async at => {
      const folder = listed[at] as ListedFolder
      const entries = await readdir(source + folder.rel, { withFileTypes: true })
      if (at !== 0 && staysBehind(entries, leaveOut)) {
        folder.kept = true
        return
      }
      for (const entry of entries) {
        const rel = `${folder.rel}/${entry.name}`
        if (held?.(source + rel) === true) {
          folder.holdsBack = true
          continue
        }
        folder.direct++
        if (!entry.isDirectory()) {
          folder.total++
          continue
        }
        folder.folders.push(listed.push({ rel, parent: at, direct: 0, total: 1, folders: [], holdsBack: false, kept: false }) - 1)
        below.push(listed.length - 1)
      }
    })
    level = below
  }
  for (let at = listed.length - 1; at > 0; at--) {
    const folder = listed[at] as ListedFolder
    const above = listed[folder.parent] as ListedFolder
    if (folder.kept) {
      above.holdsBack = true
      continue
    }
    above.total += folder.total
    if (folder.holdsBack) above.holdsBack = true
  }
  const calls: CloneCalls = { folders: [], clones: [], links: [] }
  const pending = [0]
  while (pending.length > 0) {
    const folder = listed[pending.pop() as number] as ListedFolder
    if (!folder.holdsBack && (folder.total <= ENTRIES_A_CALL || folder.direct * DIRECT_SHARE > folder.total)) {
      calls.clones.push(folder.rel)
      continue
    }
    calls.folders.push(folder.rel)
    for (const entry of await readdir(source + folder.rel, { withFileTypes: true })) {
      const rel = `${folder.rel}/${entry.name}`
      if (held?.(source + rel) === true) calls.links.push(rel)
      else if (entry.isFile() || entry.isSymbolicLink()) calls.clones.push(rel)
    }
    for (const child of folder.folders) {
      if ((listed[child] as ListedFolder).kept) calls.links.push((listed[child] as ListedFolder).rel)
      else pending.push(child)
    }
  }
  return calls
}

async function linkHeldBack(pair: AdmittedPair, rels: readonly string[]): Promise<void> {
  for (const rel of rels) await symlink(pair.source + rel, pair.staged + rel)
}

async function clonefileEach(jobs: readonly HelperJob[], answerBoundMs: number): Promise<number[] | null> {
  const answer = await execFileNoThrowWithCwd(OSASCRIPT, ['-l', 'JavaScript', '-e', CLONEFILE_SCRIPT], {
    input: JSON.stringify(jobs),
    timeout: answerBoundMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (answer.code !== 0) {
    logForDebugging(`worktree clone: osascript gave no answer (${answer.error ?? answer.code}): ${answer.stderr.trim().split('\n')[0] ?? ''}`, { level: 'warn' })
    return null
  }
  try {
    const codes: unknown = JSON.parse(answer.stdout.trim())
    if (Array.isArray(codes) && codes.length === jobs.length && codes.every(code => Number.isInteger(code))) return codes as number[]
  } catch {
  }
  logForDebugging(`worktree clone: osascript answered something else than its codes: ${answer.stdout.trim().slice(0, 120)}`, { level: 'warn' })
  return null
}

async function openFolders(folder: string): Promise<void> {
  if (!(await lstat(folder)).isDirectory()) return
  await chmod(folder, 0o700).catch(() => {})
  for (const entry of await readdir(folder, { withFileTypes: true })) if (entry.isDirectory()) await openFolders(join(folder, entry.name))
}

async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
    return
  } catch {
  }
  await openFolders(path)
  await rm(path, { recursive: true, force: true })
}

async function removeStaging(stage: string): Promise<void> {
  try {
    await removeTree(stage)
  } catch (error) {
    logForDebugging(`worktree clone: what was staged at ${stage} could not be removed: ${String(error)}`, { level: 'warn' })
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

async function settleClone(pair: AdmittedPair, scope: CloneScope): Promise<void> {
  let level = [{ from: pair.source, at: pair.staged, to: pair.target }]
  while (level.length > 0) {
    const below: Array<{ from: string; at: string; to: string }> = []
    await eachAtOnce(level, FOLDERS_AT_ONCE, async ({ from, at, to }) => {
      const folder = await lstat(at)
      if (!folder.isDirectory()) throw new Error('the staged folder is no longer a directory')
      if ((folder.mode & 0o200) === 0) await chmod(at, (folder.mode & 0o7777) | 0o200)
      const entries = await readdir(at, { withFileTypes: true })
      if (at !== pair.staged && staysBehind(entries, pair.leaveOut)) {
        await removeTree(at)
        if (!pair.leaveOut) await symlink(from, at)
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) below.push({ from: join(from, entry.name), at: join(at, entry.name), to: join(to, entry.name) })
        if (!entry.isSymbolicLink()) continue
        const link = join(at, entry.name)
        const raw = await readlink(link)
        const wanted = linkTargetInCopy(raw, join(from, entry.name), join(to, entry.name), scope)
        if (wanted === raw) continue
        await unlink(link)
        await symlink(wanted, link)
      }
    })
    level = below
  }
}

async function clonefileAdmitted(admitted: readonly AdmittedPair[], outcomes: CloneOutcome[], scope: CloneScope, answerBoundMs: number, held: HeldBack | undefined): Promise<void> {
  const planned: Array<{ pair: AdmittedPair; calls: CloneCalls }> = []
  await Promise.all(
    admitted.map(async pair => {
      try {
        planned.push({ pair, calls: await planCloneCalls(pair.source, held, pair.leaveOut) })
      } catch (error) {
        logForDebugging(`worktree clone: ${pair.source} could not be listed for cloning (${String(error)}); the folder is linked as before`, { level: 'warn' })
      }
    }),
  )
  if (planned.length === 0) return
  const codes = await inTurn(() => clonefileEach(planned.map(({ pair, calls }) => ({ from: pair.source, to: pair.staged, folders: calls.folders, clones: calls.clones })), answerBoundMs))
  await eachAtOnce([...planned.entries()], FOLDERS_AT_ONCE, async ([at, { pair, calls }]) => {
    const code = codes === null ? null : (codes[at] as number)
    if (code === 0) {
      try {
        await settleClone(pair, scope)
        if (!pair.leaveOut) await linkHeldBack(pair, calls.links)
        outcomes[pair.index] = 'cloned'
      } catch (error) {
        logForDebugging(`worktree clone: the clone of ${pair.source} could not be settled (${String(error)}); the folder is linked as before`, { level: 'warn' })
      }
      return
    }
    if (code === ENOTSUP || code === EXDEV) {
      if (code === ENOTSUP) volumesThatCannotClone.add(pair.volumes)
      outcomes[pair.index] = 'unsupported'
      logForDebugging(`worktree clone: the volume of ${pair.source} cannot clone (errno ${code}); the folder is linked as before`)
      return
    }
    logForDebugging(`worktree clone: ${pair.source} was not cloned (${code === null ? 'no answer' : `errno ${code}`}); the folder is linked as before`, { level: 'warn' })
  })
}

async function unlessQuiet<T>(work: (moved: () => void) => Promise<T>, quietBoundMs: number): Promise<T | Quiet> {
  let last = Date.now()
  let left = false
  let watch: ReturnType<typeof setInterval> | undefined
  const quiet = new Promise<Quiet>(resolve => {
    watch = setInterval(() => {
      if (Date.now() - last >= quietBoundMs) resolve('quiet')
    }, Math.max(20, Math.min(1000, quietBoundMs / 4)))
  })
  const moved = (): void => {
    if (left) throw new Error('given up after it went quiet')
    last = Date.now()
  }
  try {
    const answer = await Promise.race([work(moved), quiet])
    left = answer === 'quiet'
    return answer
  } finally {
    clearInterval(watch)
  }
}

async function reflinkTree(pair: AdmittedPair, scope: CloneScope, moved: () => void, held: HeldBack | undefined): Promise<CloneOutcome> {
  const folders: FolderStamp[] = []
  let reflinked = 0
  try {
    const pending = [{ from: pair.source, at: pair.staged, to: pair.target }]
    while (pending.length > 0) {
      const { from, at, to } = pending.pop() as { from: string; at: string; to: string }
      const folder = await lstat(from)
      if (!folder.isDirectory()) {
        if (at === pair.staged || !folder.isSymbolicLink()) return 'failed'
        await symlink(linkTargetInCopy(await readlink(from), from, to, scope), at)
        moved()
        continue
      }
      const entries = await readdir(from, { withFileTypes: true })
      if (at !== pair.staged && staysBehind(entries, pair.leaveOut)) {
        if (!pair.leaveOut) await symlink(from, at)
        continue
      }
      if (at !== pair.staged) await mkdir(at)
      moved()
      folders.push({ path: at, mode: folder.mode & 0o7777, atime: folder.atimeMs / 1000, mtime: folder.mtimeMs / 1000 })
      const files: Array<{ from: string; at: string }> = []
      for (const entry of entries) {
        const child = { from: join(from, entry.name), at: join(at, entry.name), to: join(to, entry.name) }
        if (held?.(child.from) === true) {
          if (!pair.leaveOut) await symlink(child.from, child.at)
        } else if (entry.isDirectory()) pending.push(child)
        else if (entry.isSymbolicLink()) await symlink(linkTargetInCopy(await readlink(child.from), child.from, child.to, scope), child.at)
        else if (entry.isFile()) files.push(child)
      }
      await eachAtOnce(files, REFLINKS_AT_ONCE, async file => {
        const times = await lstat(file.from)
        await copyFile(file.from, file.at, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
        await utimes(file.at, times.atimeMs / 1000, times.mtimeMs / 1000)
        reflinked++
        moved()
      })
    }
    for (const folder of folders.reverse()) {
      await chmod(folder.path, folder.mode | 0o200)
      await utimes(folder.path, folder.atime, folder.mtime)
      moved()
    }
    return 'cloned'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (reflinked === 0 && NO_REFLINK_CODES.has(code)) return 'unsupported'
    logForDebugging(`worktree clone: ${pair.source} was not cloned file by file (${code === '' ? String(error) : code}); the folder is linked as before`, { level: 'warn' })
    return 'failed'
  }
}

async function holdsAtMost(folder: string, limit: number): Promise<boolean> {
  let seen = 0
  const pending = [folder]
  while (pending.length > 0) {
    const here = pending.pop() as string
    for (const entry of await readdir(here, { withFileTypes: true })) {
      if (++seen > limit) return false
      if (entry.isDirectory()) pending.push(join(here, entry.name))
    }
  }
  return true
}

async function firstFileOf(folder: string): Promise<string | null> {
  const pending = [folder]
  while (pending.length > 0) {
    const here = pending.pop() as string
    for (const entry of await readdir(here, { withFileTypes: true })) {
      if (entry.isFile()) return join(here, entry.name)
      if (entry.isDirectory()) pending.push(join(here, entry.name))
    }
  }
  return null
}

async function reflinkRefused(pair: AdmittedPair): Promise<boolean | null> {
  const file = await firstFileOf(pair.source)
  if (file === null) return null
  const probe = join(pair.staged, `.clone-probe-${process.pid}`)
  try {
    await copyFile(file, probe, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
    return false
  } catch (error) {
    if (NO_REFLINK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return true
    throw error
  } finally {
    await rm(probe, { force: true }).catch(() => {})
  }
}

async function cpTree(pair: AdmittedPair, scope: CloneScope, answerBoundMs: number): Promise<CloneOutcome> {
  const answer = await execFileNoThrowWithCwd('cp', ['-a', '--reflink=always', '-T', '--', pair.source, pair.staged], { timeout: answerBoundMs, maxBuffer: 1024 * 1024 })
  if (answer.code !== 0) {
    logForDebugging(`worktree clone: cp did not clone ${pair.source} (${answer.error ?? answer.code}): ${answer.stderr.trim().split('\n')[0] ?? ''}; the folder is linked as before`, { level: 'warn' })
    return 'failed'
  }
  await settleClone(pair, scope)
  return 'cloned'
}

async function reflinkAdmitted(admitted: readonly AdmittedPair[], outcomes: CloneOutcome[], scope: CloneScope, road: 'cp' | 'walk', answerBoundMs: number, held: HeldBack | undefined): Promise<boolean> {
  const quietBoundMs = Math.min(answerBoundMs, WALK_QUIET_BOUND_MS)
  let wentQuiet = false
  for (const pair of admitted) {
    if (volumesThatCannotClone.has(pair.volumes)) {
      outcomes[pair.index] = 'unsupported'
      continue
    }
    let outcome: CloneOutcome | Quiet = 'failed'
    try {
      await mkdir(pair.staged)
      const refused = volumesThatClone.has(pair.volumes) ? false : await unlessQuiet(() => reflinkRefused(pair), quietBoundMs)
      if (refused === false) volumesThatClone.add(pair.volumes)
      if (refused === 'quiet') outcome = 'quiet'
      else if (refused === true) outcome = 'unsupported'
      else if (road === 'cp' && refused === false && !(pair.leaveOut && (await holdsAtMost(pair.source, SMALL_FOLDER_ENTRIES))) && (await machineCpTakesReflink()) && !((held !== undefined || pair.leaveOut) && (await planCloneCalls(pair.source, held, pair.leaveOut)).links.length > 0)) outcome = await cpTree(pair, scope, answerBoundMs)
      else outcome = await unlessQuiet(moved => reflinkTree(pair, scope, moved, held), quietBoundMs)
    } catch (error) {
      logForDebugging(`worktree clone: ${pair.source} was not cloned (${String(error)}); the folder is linked as before`, { level: 'warn' })
    }
    if (outcome === 'quiet') {
      wentQuiet = true
      outcomes[pair.index] = 'failed'
      volumesThatCannotClone.add(pair.volumes)
      logForDebugging(`worktree clone: nothing of ${pair.source} was cloned for ${quietBoundMs} ms; it is given up, no clone is tried between these volumes again in this process, and the folder is linked as before`, { level: 'warn' })
      continue
    }
    outcomes[pair.index] = outcome
    if (outcome !== 'unsupported') continue
    volumesThatCannotClone.add(pair.volumes)
    logForDebugging(`worktree clone: the filesystem of ${pair.source} cannot reflink into ${dirname(pair.target)}; the folder is linked as before`)
  }
  return wentQuiet
}

async function moveIntoCopy(pair: AdmittedPair): Promise<CloneOutcome> {
  try {
    await rename(pair.staged, pair.target)
    return 'cloned'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (NAME_TAKEN_CODES.has(code)) return 'present'
    logForDebugging(`worktree clone: the clone of ${pair.source} could not be moved to ${pair.target} (${code === '' ? String(error) : code}); the folder is linked as before`, { level: 'warn' })
    return 'failed'
  }
}

export async function cloneIntoWorktree(pairs: readonly ClonePair[], checkoutRoot: string, worktreeRoot: string, answerBoundMs: number = CLONE_ANSWER_BOUND_MS, heldUnder?: (root: string) => HeldBack): Promise<CloneOutcome[]> {
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
  const worktree = resolve(worktreeRoot)
  const scope: CloneScope = { spellings: [...new Set([checkout, resolve(checkoutRoot)])], worktree }
  const stage = join(dirname(worktree), `${STAGING_MARK}${basename(worktree)}-${process.pid}-${Date.now().toString(36)}${(stagings++).toString(36)}`)
  const held = heldUnder?.(checkout)
  const verdicts: Array<AdmittedPair | undefined> = pairs.map(() => undefined)
  await eachAtOnce([...pairs.entries()], PAIRS_AT_ONCE, async ([index, pair]) => {
    try {
      const verdict = await admitPair(pair, index, checkout, road, stage, held)
      if (typeof verdict === 'string') outcomes[index] = verdict
      else verdicts[index] = verdict
    } catch (error) {
      logForDebugging(`worktree clone: ${pair.source} could not be read for cloning: ${String(error)}`, { level: 'warn' })
    }
  })
  for (const verdict of verdicts) if (verdict !== undefined) admitted.push(verdict)
  if (admitted.length === 0) return outcomes
  try {
    await mkdir(stage)
  } catch (error) {
    logForDebugging(`worktree clone: no folder to clone into beside ${worktree} (${String(error)}); the folders are linked as before`, { level: 'warn' })
    return outcomes
  }
  let callsUnanswered = false
  try {
    if (road === 'clonefile') await clonefileAdmitted(admitted, outcomes, scope, answerBoundMs, held)
    else callsUnanswered = await reflinkAdmitted(admitted, outcomes, scope, road, answerBoundMs, held)
    await eachAtOnce(admitted, PAIRS_AT_ONCE, async pair => {
      if (outcomes[pair.index] === 'cloned') outcomes[pair.index] = await moveIntoCopy(pair)
    })
  } finally {
    if (callsUnanswered) void removeStaging(stage)
    else await removeStaging(stage)
  }
  return outcomes
}

export function canCloneHere(): boolean {
  return cloneRoad() !== null
}

export async function cloneRefusedBetween(checkoutRoot: string, worktreeRoot: string): Promise<boolean> {
  let volumes: string
  try {
    volumes = `${(await stat(checkoutRoot)).dev}:${(await stat(worktreeRoot)).dev}`
  } catch {
    return true
  }
  if (volumesThatCannotClone.has(volumes)) return true
  if (volumesThatClone.has(volumes) || cloneRoad() === 'clonefile') return false
  const probe = join(dirname(resolve(worktreeRoot)), `${STAGING_MARK}probe-${process.pid}-${(stagings++).toString(36)}`)
  for (const known of [join(checkoutRoot, '.git', 'HEAD'), join(checkoutRoot, '.git')]) {
    try {
      await copyFile(known, probe, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
      volumesThatClone.add(volumes)
      return false
    } catch (error) {
      if (!NO_REFLINK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) continue
      volumesThatCannotClone.add(volumes)
      return true
    } finally {
      await rm(probe, { force: true }).catch(() => {})
    }
  }
  return false
}

export async function carryEntries(relPaths: readonly string[], checkoutRoot: string, worktreeRoot: string, heldUnder?: (root: string) => HeldBack): Promise<string[]> {
  const road = cloneRoad()
  if (road === null || relPaths.length === 0) return []
  let checkout: string
  try {
    checkout = await realpath(checkoutRoot)
  } catch {
    return []
  }
  const worktree = resolve(worktreeRoot)
  const scope: CloneScope = { spellings: [...new Set([checkout, resolve(checkoutRoot)])], worktree }
  const held = heldUnder?.(checkout)
  const folders: string[] = []
  const files: string[] = []
  const links: string[] = []
  await eachAtOnce(relPaths, PAIRS_AT_ONCE, async listed => {
    const rel = listed.endsWith('/') ? listed.slice(0, -1) : listed
    const source = join(checkout, rel)
    if (held?.(source) === true) return
    let entry
    try {
      entry = await lstat(source)
    } catch {
      return
    }
    if (entry.isSymbolicLink()) links.push(rel)
    else if (entry.isDirectory()) folders.push(rel)
    else if (entry.isFile()) files.push(rel)
  })
  const outcomes = await cloneIntoWorktree(folders.map(rel => ({ source: join(checkout, rel), target: join(worktree, rel), leaveOut: true })), checkoutRoot, worktreeRoot, CLONE_ANSWER_BOUND_MS, heldUnder)
  const carried = folders.filter((_, index) => outcomes[index] === 'cloned')
  if (await cloneRefusedBetween(checkout, worktree)) return carried
  for (const rel of links) {
    try {
      const target = join(worktree, rel)
      await mkdir(dirname(target), { recursive: true })
      await symlink(linkTargetInCopy(await readlink(join(checkout, rel)), join(checkout, rel), target, scope), target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') logForDebugging(`worktree carry: the link ${rel} was not made: ${String(error)}`, { level: 'warn' })
    }
  }
  if (files.length === 0) return carried
  for (const parent of new Set(files.map(rel => dirname(join(worktree, rel))))) await mkdir(parent, { recursive: true }).catch(() => {})
  if (road === 'clonefile') {
    const codes = await inTurn(() => clonefileEach([{ from: checkout, to: worktree, folders: [], clones: files.map(rel => `/${rel}`), loose: true }], CLONE_ANSWER_BOUND_MS))
    if (codes === null || codes[0] !== 0) logForDebugging(`worktree carry: some ignored files were not cloned (${codes === null ? 'no answer' : `errno ${codes[0]}`})`, { level: 'warn' })
    if (codes !== null && codes[0] === ENOTSUP) volumesThatCannotClone.add(`${(await stat(checkout)).dev}:${(await stat(worktree)).dev}`)
    return carried
  }
  let refused = false
  await eachAtOnce(files, REFLINKS_AT_ONCE, async rel => {
    if (refused) return
    try {
      const times = await lstat(join(checkout, rel))
      await copyFile(join(checkout, rel), join(worktree, rel), constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
      await utimes(join(worktree, rel), times.atimeMs / 1000, times.mtimeMs / 1000)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (NO_REFLINK_CODES.has(code)) refused = true
      else if (code !== 'EEXIST') logForDebugging(`worktree carry: ${rel} was not cloned: ${code === '' ? String(error) : code}`, { level: 'warn' })
    }
  }).catch(() => {})
  return carried
}

const CLONES_FILENAME = 'WORKTREE_CLONES'
const DISCARD_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const root = process.argv[1]',
  'const name = path.basename(root)',
  'const isFolder = entry => {',
  '  try { return fs.lstatSync(entry).isDirectory() } catch { return false }',
  '}',
  'const open = dir => {',
  '  if (!isFolder(dir)) return',
  '  try { fs.chmodSync(dir, 0o700) } catch {}',
  '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) open(path.join(dir, entry.name))',
  '}',
  `if ((name.startsWith('${SET_ASIDE_MARK}') || name.startsWith('${STAGING_MARK}')) && path.basename(path.dirname(root)) === '${DEBRIS_HOME}') {`,
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

function isWorktreeDebris(path: string): boolean {
  const name = basename(path)
  return (name.startsWith(SET_ASIDE_MARK) || name.startsWith(STAGING_MARK)) && basename(dirname(path)) === DEBRIS_HOME
}

export function setWorktreeAside(worktreePath: string): string | null {
  const aside = join(dirname(worktreePath), `${SET_ASIDE_MARK}${basename(worktreePath)}-${process.pid}-${Date.now().toString(36)}`)
  if (!isWorktreeDebris(aside)) return null
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
  if (!isWorktreeDebris(aside)) return
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
    if (!entry.startsWith(SET_ASIDE_MARK) && !entry.startsWith(STAGING_MARK)) continue
    try {
      if (Date.now() - lstatSync(join(home, entry)).mtimeMs < DEBRIS_GRACE_MS) continue
    } catch {
      continue
    }
    discardSetAside(join(home, entry))
    swept++
  }
  return swept
}
