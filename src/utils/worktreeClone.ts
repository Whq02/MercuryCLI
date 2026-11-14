import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'

import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

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
