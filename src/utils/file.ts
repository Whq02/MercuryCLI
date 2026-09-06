import {
  chmodSync,
  closeSync,
  existsSync,
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
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path'

import { faultPoint, isTransientWin32FsCode, renameWithWin32RetrySync, WIN32_RENAME_RETRY_DELAYS_MS } from '../substrate/durablePublish.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isENOENT, isFsInaccessible, getErrnoCode } from './errors.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { detectEncodingForResolvedPath, detectLineEndingsForString, type LineEndingType } from './fileRead.js'
import { fileReadCache } from './fileReadCache.js'
import { logError } from './log.js'
import { expandPath } from './path.js'
import { getPlatform } from './platform.js'


export type File = {
  filename: string
  content: string
}

export const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024

export const FILE_NOT_FOUND_CWD_NOTE = 'Note: your current working directory is'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await getFsImplementation().stat(path)
    return true
  } catch {
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
  } catch {
    return 0
  }
}

export async function getFileModificationTimeAsync(path: string): Promise<number> {
  try {
    return Math.floor((await stat(path)).mtimeMs)
  } catch {
    return 0
  }
}

export function needsPowerShellBom(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  return /\.(ps1|psm1|psd1)$/i.test(filePath)
}

export function preserveUntouchedLineEndings(
  raw: string,
  updated: string,
  majority: LineEndingType,
): string {
  const rawLines = raw.split(/(?<=\n)/)
  const updatedLines = updated.split(/(?<=\n)/)
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
  const middleStyled = updatedLines
    .slice(top, bottomUpdated + 1)
    .map(line => (majority === 'CRLF' ? line.replace(/\n$/, '\r\n') : line))
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
  options: { keepBom?: boolean } = {},
): void {
  let prepared = content
  if (endings === 'CRLF') {
    prepared = prepared.replace(/\r\n/g, '\n').split('\n').join('\r\n')
  }
  const wantsBom = options.keepBom === true || (needsPowerShellBom(filePath) && encoding === 'utf8')
  if (wantsBom && !prepared.startsWith('\uFEFF')) {
    prepared = `\uFEFF${prepared}`
  }
  writeFileSyncAndFlush_DEPRECATED(filePath, prepared, { encoding })
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
    if (platform === 'win32' && facts.attempt < ATOMIC_FRESH_TEMP_ATTEMPTS) return 'retry-atomic'
    if (facts.phase === 'rename') return 'refuse'
  }
  if (facts.isNewFile) return 'refuse'
  return 'direct-write'
}

function guardedDirectWriteSync(target: string, content: string, encoding: BufferEncoding, oldBytes: Buffer): void {
  const fd = openSync(target, 'r+')
  try {
    const bytes = Buffer.from(content, encoding)
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

export function writeFileSyncAndFlush_DEPRECATED(
  filePath: string,
  content: string,
  options: { encoding?: BufferEncoding; mode?: number } = { encoding: 'utf-8' as BufferEncoding },
): void {
  const encoding = options.encoding ?? ('utf-8' as BufferEncoding)
  let target = filePath
  try {
    const linkStat = lstatSync(filePath, { throwIfNoEntry: false })
    if (linkStat?.isSymbolicLink()) {
      const linkTarget = readlinkSync(filePath)
      target = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(filePath), linkTarget)
      logForDebugging(`atomic write: ${filePath} is a symlink; writing through to ${target}`)
    }
  } catch {
  }

  let existingMode: number | undefined
  let isNewFile = false
  try {
    existingMode = statSync(target).mode
  } catch (err) {
    if (!isENOENT(err)) throw err
    isNewFile = true
    existingMode = options.mode
  }

  for (let attempt = 1; ; attempt++) {
    const temporaryPath = `${target}.tmp.${process.pid}.${Date.now()}.${attempt}`
    let phase: AtomicWritePhase = 'temp-write'
    try {
      logForDebugging(`atomic write: writing ${temporaryPath}`)
      faultPoint('temp-write', target)
      writeFileSync(temporaryPath, content, {
        encoding,
        flush: true,
        ...(isNewFile && existingMode !== undefined ? { mode: existingMode } : {}),
      })
      if (!isNewFile && existingMode !== undefined) {
        chmodSync(temporaryPath, existingMode)
      }
      phase = 'rename'
      renameWithWin32RetrySync(temporaryPath, target)
      logForDebugging(`atomic write: published ${target}`)
      return
    } catch (err) {
      logForDebugging(`atomic write failed for ${target} at ${phase}: ${String(err)}`, { level: 'error' })
      try {
        unlinkSync(temporaryPath)
      } catch (cleanupErr) {
        if (!isENOENT(cleanupErr)) logForDebugging(`atomic write: temp cleanup failed: ${String(cleanupErr)}`)
      }
      const verdict = classifyAtomicWriteFailure(getErrnoCode(err), { isNewFile, phase, attempt })
      if (verdict === 'retry-atomic') {
        sleepSyncMs(WIN32_RENAME_RETRY_DELAYS_MS[Math.min(attempt, WIN32_RENAME_RETRY_DELAYS_MS.length) - 1] ?? 50)
        continue
      }
      if (verdict === 'refuse') {
        const refusal = new AtomicWriteRefusal(phase, target, err)
        logError(refusal)
        throw refusal
      }
      let oldBytes: Buffer
      try {
        oldBytes = readFileSync(target)
      } catch (readErr) {
        const refusal = new AtomicWriteRefusal(phase, target, readErr)
        logError(refusal)
        throw refusal
      }
      logForDebugging(`atomic write: guarded direct write to ${target} (the directory refused a sibling)`)
      try {
        guardedDirectWriteSync(target, content, encoding, oldBytes)
      } catch (directErr) {
        logError(directErr)
        throw directErr
      }
      return
    }
  }
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
    return detectEncodingForResolvedPath(resolvedPath)
  } catch (err) {
    if (isFsInaccessible(err)) {
      logForDebugging(`detectFileEncoding: inaccessible (${getErrnoCode(err) ?? 'unknown'}): ${filePath}`)
    } else {
      logError(err)
    }
    return 'utf8'
  }
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
  if (!content.includes('\t')) return content
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

export function getDisplayPath(filePath: string): string {
  if (typeof filePath !== 'string') {
    return filePath === undefined || filePath === null ? '' : String(filePath)
  }
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
  const normalized = normalize(filePath)
  if (process.platform === 'win32') {
    return normalized.replace(/\//g, '\\').toLowerCase()
  }
  return normalized
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizePathForComparison(a) === normalizePathForComparison(b)
}

export function isDirEmpty(dirPath: string): boolean {
  try {
    return getFsImplementation().isDirEmptySync(dirPath)
  } catch (err) {
    return isENOENT(err)
  }
}

export function findSimilarFile(filePath: string): string | undefined {
  try {
    const directory = dirname(filePath)
    const wantedBase = parse(filePath).name
    for (const entry of readdirSync(directory)) {
      if (parse(entry).name !== wantedBase) continue
      if (join(directory, entry) === filePath) continue
      return entry
    }
    return undefined
  } catch (err) {
    if (!isENOENT(err)) logError(err)
    return undefined
  }
}

export async function suggestPathUnderCwd(requestedPath: string): Promise<string | undefined> {
  try {
    let resolvedParent: string
    try {
      resolvedParent = await realpath(dirname(requestedPath))
    } catch {
      return undefined
    }
    const rebuilt = join(resolvedParent, basename(requestedPath))
    const cwd = getCwd()
    const cwdParent = dirname(cwd)
    const parentPrefix = cwdParent.endsWith(sep) ? cwdParent : cwdParent + sep
    const underParent = rebuilt.startsWith(parentPrefix)
    const underCwd = rebuilt === cwd || rebuilt.startsWith(cwd + sep)
    if (!underParent || underCwd) return undefined
    const relativeToParent = relative(cwdParent, rebuilt)
    const rerooted = join(cwd, relativeToParent)
    return (await pathExists(rerooted)) ? rerooted : undefined
  } catch {
    return undefined
  }
}

export function isCompactLinePrefixEnabled(): boolean {
  return true
}

export function addLineNumbers({ content, startLine }: { content: string; startLine: number }): string {
  if (content === '') return ''
  const compact = isCompactLinePrefixEnabled()
  return content
    .split(/\r\n|\r|\n/)
    .map((line, index) => {
      const lineNumber = startLine + index
      if (compact) return `${lineNumber}\t${line}`
      const rendered = String(lineNumber)
      return rendered.length >= 6 ? `${rendered}→${line}` : `${rendered.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

export function stripLineNumberPrefix(line: string): string {
  const match = /^\s*\d+(?:#[0-9a-f]+)?(?:→|\t)([\s\S]*)$/.exec(line)
  return match ? (match[1] as string) : line
}

export function isFileWithinReadSizeLimit(filePath: string, maxSizeBytes: number = MAX_OUTPUT_SIZE): boolean {
  try {
    return statSync(filePath).size <= maxSizeBytes
  } catch {
    return false
  }
}

const WINDOWS_SYSTEM_USER_DIRS = new Set(['Public', 'Default', 'Default User', 'All Users'])

export function getDesktopPath(): string {
  const platform = getPlatform()
  if (platform === 'macos') {
    return join(homedir(), 'Desktop')
  }
  if (platform === 'windows') {
    const userProfile = process.env.USERPROFILE
    if (userProfile) {
      const withoutDrive = userProfile.replace(/\\/g, '/').replace(/^[A-Z]:/, '')
      const candidate = join(`/mnt/c${withoutDrive}`, 'Desktop')
      if (existsSync(candidate)) return candidate
    }
    try {
      for (const entry of readdirSync('/mnt/c/Users')) {
        if (WINDOWS_SYSTEM_USER_DIRS.has(entry)) continue
        const candidate = join('/mnt/c/Users', entry, 'Desktop')
        if (existsSync(candidate)) return candidate
      }
    } catch (err) {
      logError(err)
    }
  }
  const fallback = join(homedir(), 'Desktop')
  return existsSync(fallback) ? fallback : homedir()
}
