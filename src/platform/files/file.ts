import {
  chmodSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path'

import { isRemotePath } from '../remote-file-target/target.js'
import { faultPoint, isTransientWin32FsCode, renameWithWin32RetrySync, WIN32_RENAME_RETRY_DELAYS_MS } from '../substrate/durablePublish.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from '../logs/debugLog.js'
import { errorMessage, isENOENT, getErrnoCode } from '../errors/errors.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { detectLineEndingsForString, type LineEndingType } from './syncFileRead.js'
import { fileReadCache } from './fileReadCache.js'
import { logError } from '../logs/errorLog.js'
import { expandPath } from './path.js'
import { needsPowerShellBom } from './fileEncoding.js'
import { isTransientHeldFileCode } from '../host-os/files.js'
import { foldPathCase, toNativeSeparators } from '../host-os/paths.js'
import { passedOver } from '../errors/passedOver.js'
import { sleepSync } from '../async/timers.js'

export { detectFileEncoding, needsPowerShellBom } from './fileEncoding.js'

export type File = { content: string; filename: string }

export const MAX_OUTPUT_SIZE = 262_144

export const FILE_NOT_FOUND_CWD_NOTE = 'Note: your current working directory is'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await getFsImplementation().stat(path)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function readFileSafe(path: string): string | null {
  try {
    return getFsImplementation().readFileSync(path, { encoding: 'utf8' })
  } catch (err) {
    logError(err)
    return null
  }
}

export function readFileSyncCached(path: string): string {
  return fileReadCache.readFile(path).content
}

export function getFileModificationTime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return 0
  }
}

export function getCheckedFileModificationTime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs)
  } catch (error) {
    if (isENOENT(error)) return 0
    throw new Error(`${path} could not be checked for changes since it was read (${errorMessage(error)}) — read it again, then retry`)
  }
}

export async function getFileModificationTimeAsync(path: string): Promise<number> {
  try {
    return Math.floor((await stat(path)).mtimeMs)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return 0
  }
}

const ALIGNMENT_CELL_BUDGET = 4_000_000

function alignReplacedLines(rawNormalized: string[], updated: string[]): number[] {
  const owner = new Array<number>(updated.length).fill(-1)
  const n = rawNormalized.length
  const m = updated.length
  if (n === 0 || m === 0) return owner
  if (n * m > ALIGNMENT_CELL_BUDGET) {
    if (n === m) for (let i = 0; i < m; i++) owner[i] = i
    return owner
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        rawNormalized[i] === updated[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number)
    }
  }
  let i = 0
  let j = 0
  let rawGapStart = 0
  let updatedGapStart = 0
  const pairGap = (rawEnd: number, updatedEnd: number): void => {
    if (rawEnd - rawGapStart === updatedEnd - updatedGapStart) {
      for (let k = 0; k < updatedEnd - updatedGapStart; k++) owner[updatedGapStart + k] = rawGapStart + k
    }
  }
  while (i < n && j < m) {
    if (rawNormalized[i] === updated[j]) {
      pairGap(i, j)
      owner[j] = i
      i++
      j++
      rawGapStart = i
      updatedGapStart = j
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      i++
    } else {
      j++
    }
  }
  pairGap(n, m)
  return owner
}

function linesWithEndings(text: string): string[] {
  const lines: string[] = []
  let start = 0
  let end: number
  while ((end = text.indexOf('\n', start)) !== -1) {
    lines.push(text.slice(start, end + 1))
    start = end + 1
  }
  if (start < text.length || lines.length === 0) lines.push(text.slice(start))
  return lines
}

export function preserveUntouchedLineEndings(
  raw: string,
  updated: string,
  majority: LineEndingType,
): string {
  if (majority === 'LF' && !raw.includes('\r\n')) return updated
  const rawLines = linesWithEndings(raw)
  const updatedLines = linesWithEndings(updated)
  const normalize = (line: string): string => line.replace(/\r\n$/, '\n')
  let top = 0
  while (
    top < rawLines.length &&
    top < updatedLines.length &&
    normalize(rawLines[top] as string) === (updatedLines[top] as string)
  ) {
    top++
  }
  let bottomRaw = rawLines.length - 1
  let bottomUpdated = updatedLines.length - 1
  while (
    bottomRaw >= top &&
    bottomUpdated >= top &&
    normalize(rawLines[bottomRaw] as string) === (updatedLines[bottomUpdated] as string)
  ) {
    bottomRaw--
    bottomUpdated--
  }
  const rawMiddle = rawLines.slice(top, bottomRaw + 1)
  const updatedMiddle = updatedLines.slice(top, bottomUpdated + 1)
  const owner = alignReplacedLines(rawMiddle.map(normalize), updatedMiddle)
  const middleStyled = updatedMiddle.map((line, index) => {
    const own = owner[index] === -1 ? '' : (rawMiddle[owner[index] as number] as string)
    const ending = own.endsWith('\r\n') ? 'CRLF' : own.endsWith('\n') ? 'LF' : majority
    return ending === 'CRLF' ? line.replace(/\n$/, '\r\n') : line
  })
  return [
    ...rawLines.slice(0, top),
    ...middleStyled,
    ...rawLines.slice(bottomRaw + 1),
  ].join('')
}

export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
  options?: { keepBom?: boolean },
): void {
  let text = endings === 'CRLF' ? content.replace(/\r?\n/g, '\r\n') : content
  if (!text.startsWith('\uFEFF') && (options?.keepBom === true || (encoding === 'utf8' && needsPowerShellBom(filePath)))) {
    text = '\uFEFF' + text
  }
  writeFileAndFlushAtomically(filePath, text, { encoding })
}

export class AtomicWriteRefusal extends Error {
  readonly code: string | undefined
  readonly targetPath: string
  readonly phase: AtomicWritePhase
  constructor(phase: AtomicWritePhase, targetPath: string, cause: unknown) {
    const code = getErrnoCode(cause)
    super(
      `the write to ${targetPath} was refused at the ${phase} step${code ? ` (${code})` : ''}: the file keeps its previous contents — ${atomicWriteRemedy(code)}`,
    )
    this.name = 'AtomicWriteRefusal'
    this.code = code
    this.targetPath = targetPath
    this.phase = phase
  }
}

export type AtomicWritePhase = 'temp-write' | 'rename' | 'direct-write'
export type AtomicWriteFallback = 'retry-atomic' | 'direct-write' | 'refuse'

const STRUCTURAL_WRITE_CODES = new Set(['ENOSPC', 'EROFS', 'EIO', 'EDQUOT', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EXDEV', 'ENAMETOOLONG', 'ELOOP'])

const ATOMIC_FRESH_TEMP_ATTEMPTS = 2

function atomicWriteRemedy(code: string | undefined): string {
  switch (code) {
    case 'ENOSPC':
      return 'the volume is out of space; free space and retry'
    case 'EROFS':
      return 'the volume is read-only'
    case 'EIO':
      return 'the disk reported an I/O error'
    case 'EDQUOT':
      return 'the disk quota is exhausted'
    case 'ENOENT':
      return 'the directory no longer exists'
    case 'EPERM':
    case 'EBUSY':
    case 'EACCES':
      return 'another process holds the file or the directory refuses the write; retry, or check the permissions'
    default:
      return 'the filesystem refused the write'
  }
}

export function classifyAtomicWriteFailure(
  code: string | undefined,
  facts: { platform?: NodeJS.Platform; isNewFile: boolean; phase: AtomicWritePhase; attempt: number },
): AtomicWriteFallback {
  const platform = facts.platform ?? process.platform
  if (code !== undefined && STRUCTURAL_WRITE_CODES.has(code)) return 'refuse'
  if (isTransientWin32FsCode(code)) {
    if (isTransientHeldFileCode(code, platform) && facts.attempt < ATOMIC_FRESH_TEMP_ATTEMPTS) return 'retry-atomic'
    if (facts.phase === 'rename') return 'refuse'
  }
  if (facts.isNewFile) return 'refuse'
  return 'direct-write'
}

function guardedDirectWriteSync(target: string, content: string | Buffer, encoding: BufferEncoding, oldBytes: Buffer): void {
  const fd = openSync(target, 'r+')
  try {
    const bytes = typeof content === 'string' ? Buffer.from(content, encoding) : content
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset)
    faultPoint('direct-write', target)
    ftruncateSync(fd, bytes.length)
    fsyncSync(fd)
  } catch (err) {
    try {
      let offset = 0
      while (offset < oldBytes.length) offset += writeSync(fd, oldBytes, offset, oldBytes.length - offset, offset)
      ftruncateSync(fd, oldBytes.length)
      fsyncSync(fd)
    } catch (restoreErr) {
      logForDebugging(`atomic write: restoring the old bytes of ${target} failed: ${String(restoreErr)}`, { level: 'error' })
    }
    throw new AtomicWriteRefusal('direct-write', target, err)
  } finally {
    closeSync(fd)
  }
}

export function writeFileAndFlushAtomically(
  filePath: string,
  content: string | Buffer,
  options?: { encoding?: BufferEncoding; mode?: number },
): void {
  const encoding = options?.encoding ?? 'utf-8'
  let target = filePath
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      const link = readlinkSync(filePath)
      target = isAbsolute(link) ? link : resolve(dirname(filePath), link)
      logForDebugging(`atomic write: ${filePath} is a symlink; writing through to ${target}`)
    }
  } catch (error) {
    if (!isENOENT(error)) throw error
  }
  let currentMode: number | undefined
  try {
    currentMode = statSync(target).mode
  } catch (error) {
    if (!isENOENT(error)) throw error
  }
  for (let attempt = 1; ; attempt++) {
    const temp = `${target}.tmp.${process.pid}.${Date.now()}.${attempt}`
    let phase: AtomicWritePhase = 'temp-write'
    try {
      logForDebugging(`atomic write: writing ${temp}`)
      faultPoint('temp-write', target)
      writeFileSync(temp, content, { encoding, flag: 'wx', mode: currentMode ?? options?.mode, flush: true })
      if (currentMode !== undefined) chmodSync(temp, currentMode)
      phase = 'rename'
      renameWithWin32RetrySync(temp, target)
    } catch (error) {
      logForDebugging(`atomic write failed for ${target} at ${phase}: ${String(error)}`, { level: 'error' })
      const code = getErrnoCode(error)
      if (phase !== 'temp-write' || code !== 'EEXIST') {
        try {
          unlinkSync(temp)
        } catch (cleanupError) {
          if (!isENOENT(cleanupError)) logForDebugging(`atomic write: temp cleanup failed: ${String(cleanupError)}`)
        }
      }
      const next = classifyAtomicWriteFailure(code, { attempt, isNewFile: currentMode === undefined, phase })
      if (next === 'retry-atomic') {
        sleepSyncMs(WIN32_RENAME_RETRY_DELAYS_MS[Math.min(attempt, WIN32_RENAME_RETRY_DELAYS_MS.length) - 1] ?? 50)
        continue
      }
      if (next === 'refuse') {
        const refusal = new AtomicWriteRefusal(phase, target, error)
        logError(refusal)
        throw refusal
      }
      let previous: Buffer
      try {
        previous = readFileSync(target)
      } catch (readError) {
        const refusal = new AtomicWriteRefusal(phase, target, readError)
        logError(refusal)
        throw refusal
      }
      logForDebugging(`atomic write: guarded direct write to ${target} (the directory refused a sibling)`)
      try {
        return guardedDirectWriteSync(target, content, encoding, previous)
      } catch (directError) {
        logError(directError)
        throw directError
      }
    }
    logForDebugging(`atomic write: published ${target}`)
    return
  }
}

export function sleepSyncMs(ms: number): void {
  sleepSync(ms)
}

export function detectLineEndings(filePath: string, encoding: BufferEncoding = 'utf8'): LineEndingType {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
    const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, { length: 4096 })
    return detectLineEndingsForString(buffer.subarray(0, bytesRead).toString(encoding))
  } catch (err) {
    logError(err)
    return 'LF'
  }
}

export function convertLeadingTabsToSpaces(content: string): string {
  return content.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
}

export function getAbsoluteAndRelativePaths(path: string | undefined): {
  absolutePath?: string
  relativePath?: string
} {
  if (path === undefined) return { absolutePath: undefined, relativePath: undefined }
  const absolutePath = expandPath(path)
  return { absolutePath, relativePath: relative(getCwd(), absolutePath) }
}

const ADDRESS_START = /#read\?|(?<=\.(?:tar\.gz|zip|tar|tgz|sqlite3|sqlite|db))(?:::|!\/|!|:)(?=[\s\S])/i

export function splitAddressedTarget(target: string): { container: string; address: string } {
  const found = ADDRESS_START.exec(target)
  return found === null || found.index === 0 ? { container: target, address: '' } : { container: target.slice(0, found.index), address: target.slice(found.index) }
}

export function displayAddressedTarget(target: string, displayContainer: (container: string) => string): string {
  const { container, address } = splitAddressedTarget(target)
  return `${displayContainer(container)}${address}`
}

export function getDisplayPath(filePath: string): string {
  if (typeof filePath !== 'string') {
    return filePath === undefined || filePath === null ? '' : String(filePath)
  }
  if (isRemotePath(filePath)) return filePath
  if (splitAddressedTarget(filePath).address !== '') return displayAddressedTarget(filePath, getDisplayPath)
  let relativePath: string | undefined
  try {
    relativePath = getAbsoluteAndRelativePaths(filePath).relativePath
  } catch {
    relativePath = undefined
  }
  if (relativePath && !relativePath.startsWith('..')) return relativePath
  const home = homedir()
  if (filePath.startsWith(home + sep)) return `~${filePath.slice(home.length)}`
  return filePath
}

export function normalizePathForComparison(filePath: string): string {
  return foldPathCase(toNativeSeparators(normalize(filePath)))
}

export function findSimilarFile(filePath: string): string | undefined {
  const { dir, base, name } = parse(filePath)
  try {
    return readdirSync(dir || '.').find(entry => entry !== base && parse(entry).name === name)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return undefined
  }
}

export async function suggestPathUnderCwd(requestedPath: string): Promise<string | undefined> {
  try {
    const requested = join(await realpath(dirname(requestedPath)), basename(requestedPath))
    const cwd = getCwd()
    const underParent = relative(dirname(cwd), requested)
    const outside = (path: string): boolean => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
    if (!underParent || outside(underParent) || !outside(relative(cwd, requested))) return undefined
    const candidate = join(cwd, underParent)
    return await pathExists(candidate) ? candidate : undefined
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function addLineNumbers({ content, startLine }: { content: string; startLine: number }): string {
  if (content === '') return ''
  return content
    .split(/\r?\n/)
    .map((line, index) => `${startLine + index}\t${line}`)
    .join('\n')
}

export function stripLineNumberPrefix(line: string): string {
  const match = /^\d+(?:#[0-9a-f]+)?\t([\s\S]*)$/.exec(line)
  return match ? (match[1] as string) : line
}

export function isFileWithinReadSizeLimit(filePath: string, maxSizeBytes: number = MAX_OUTPUT_SIZE): boolean {
  try {
    return statSync(filePath).size <= maxSizeBytes
  } catch (error) {
    passedOver(error)
    return false
  }
}

