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

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
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

/**
 * File read/write/path utilities: encoding and line-ending detection,
 * atomic writes, display paths and line numbering.
 */

export type File = {
  filename: string
  content: string
}

/** The shared maximum output size (0.25 MiB). */
export const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024

/**
 * Embedded in not-found error messages that carry a working-directory note;
 * renderers substring-match it to substitute a short message.
 */
export const FILE_NOT_FOUND_CWD_NOTE = 'Note: your current working directory is'

/** Async existence probe: any stat error is "does not exist". */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await getFsImplementation().stat(path)
    return true
  } catch {
    return false
  }
}

/** UTF-8 contents or null, with the error logged through the facade. */
export function readFileSafe(path: string): string | null {
  try {
    return getFsImplementation().readFileSync(path, { encoding: 'utf8' })
  } catch (err) {
    logError(err)
    return null
  }
}

/** The preferred read path for the edit tool: the shared file-read cache. */
export function readFileSyncCached(path: string): string {
  return fileReadCache.readFile(path).content
}

/**
 * Modification time floored to whole milliseconds. Without the floor, a
 * tool that opens and re-saves a file without altering a byte can shift the
 * timestamp by a fraction of a millisecond, and change detection reads that
 * as an edit.
 */
export function getFileModificationTime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs)
  } catch {
    return 0
  }
}

/**
 * Async variant: the per-turn changed-file scan visits every tracked file,
 * and doing that with blocking stats raises the slow-operation indicator on
 * a network mount.
 */
export async function getFileModificationTimeAsync(path: string): Promise<number> {
  try {
    return Math.floor((await stat(path)).mtimeMs)
  } catch {
    return 0
  }
}

/**
 * The three PowerShell script extensions written on native Windows need a
 * byte-order mark: the older Windows shell cannot tell a UTF-8 script from
 * a legacy-code-page one without it and guesses the legacy page, decoding
 * every non-ASCII literal to the wrong glyph.
 */
export function needsPowerShellBom(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  return /\.(ps1|psm1|psd1)$/i.test(filePath)
}

/**
 * Write text content with the requested endings and encoding. CRLF requests
 * first normalise any existing CRLF to LF and then join with CRLF —
 * otherwise a value already containing CRLF gains doubled carriage returns.
 * The PowerShell BOM is prepended only when the encoding argument is
 * exactly the spelling `utf8` (the hyphenated spelling does not qualify)
 * and the content does not already start with one.
 *
 * `keepBom`: the file being replaced opened with a byte-order mark (the
 * caller reads that off the raw decoded content). The model's content
 * arrives BOM-stripped \u2014 the ranged Read drops the mark \u2014 so a plain write
 * rewrote a UTF-16LE file headerless and a UTF-8-BOM file without its BOM
 * (TASK-014 w4-f02-02); the mark is re-applied in the file's own encoding
 * (U+FEFF encodes as FF FE under utf16le, EF BB BF under utf8).
 */
/**
 * Rebuild a written file's line endings from its ORIGINAL raw spelling: a
 * line the edit never touched keeps its exact terminator; only lines inside
 * the changed region take the file's majority style. A mixed-endings file
 * used to be silently homogenised — one LineEndingType for the whole file
 * meant a six-character edit deleted or injected carriage returns on lines
 * the patch showed as unchanged context (FC-017). Top/bottom alignment:
 * walk raw and updated lines from both ends while their normalized forms
 * agree; with replace_all across several spans, unchanged lines BETWEEN
 * spans take the majority style (a bounded imperfection the single-span
 * case never hits). The result carries its endings literally — write it
 * with endings 'LF' (the pass-through arm).
 */
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

/**
 * A write the atomic path could not land and no fallback may attempt: the
 * destination keeps its previous contents. The message names the file, the
 * phase, the code and the remedy — it is what the file tools hand the model
 * and what the operator reads.
 */
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

/** Codes under which a direct write would fail the same way the atomic path
 *  did — after truncating the destination — or would land somewhere else
 *  than the caller meant. Never a fallback, always a typed refusal. */
const STRUCTURAL_WRITE_CODES = new Set(['ENOSPC', 'EROFS', 'EIO', 'EDQUOT', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EXDEV', 'ENAMETOOLONG', 'ELOOP'])

/** Fresh-temp attempts for the win32 transient class (a scanner holding the
 *  temp sibling clears for a NEW sibling; the rename ladder inside each
 *  attempt already covers a held destination). */
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

/**
 * The PURE fallback decision after the atomic path failed (table-provable on
 * every platform): the structural class refuses outright; the win32
 * transient class retries the atomic path with a fresh temp while the budget
 * lasts; a failure at the temp write on an EXISTING file takes the guarded
 * direct write (the directory refuses a sibling, the file itself may accept
 * — the one case a direct write can land where the atomic path cannot); a
 * failure at the rename on the transient class means the destination is
 * held and refuses; a new file has nothing to guard and refuses.
 */
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

/**
 * The guarded direct write: the destination is opened WITHOUT truncation,
 * the new bytes land, the file is cut to their length and flushed. A
 * failure midway rewrites the old bytes over the blocks the file already
 * holds (a same-length rewrite needs no new space, so it lands even on a
 * full volume) and refuses typed — the caller's file is never left empty
 * or torn.
 */
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

/**
 * Atomic write: resolve a symlinked target and write THROUGH it (preserving
 * the link for all users); write a temporary sibling with flush; preserve
 * an existing file's permissions and apply an explicit mode only to new
 * files; publish with the bounded Windows-retry rename. When the atomic
 * path fails, the failure is CLASSIFIED (classifyAtomicWriteFailure): the
 * structural class refuses typed with the destination untouched, the win32
 * transient class retries with a fresh temp, and only a directory that
 * refuses a sibling takes the guarded direct write — the old truncating
 * fallback left a source file at zero bytes on a full volume.
 *
 * @deprecated Prefer async writes; the semantics here are load-bearing.
 */
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
    // Keep the original target.
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
      // The guarded direct write — an existing file whose directory refused
      // a sibling. Its old bytes are held for the restore.
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

/** Symlink-aware encoding detection, falling back to UTF-8. */
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

/** Line-ending detection over the first 4 KiB, falling back to LF. */
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

/** Leading tabs become two spaces per tab; short-circuits when tab-free. */
export function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes('\t')) return content
  return content.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
}

/** Expanded absolute path and its working-directory-relative form. */
export function getAbsoluteAndRelativePaths(path: string | undefined): {
  absolutePath?: string
  relativePath?: string
} {
  if (path === undefined) return { absolutePath: undefined, relativePath: undefined }
  const absolutePath = expandPath(path)
  return { absolutePath, relativePath: relative(getCwd(), absolutePath) }
}

/**
 * Display form: the working-directory-relative path when inside the working
 * directory; else — from the ORIGINAL, unexpanded argument — a
 * tilde-contracted path when it starts with the home directory plus a
 * separator (the separator guard stops a sibling sharing the prefix from
 * matching); else the original argument.
 */
export function getDisplayPath(filePath: string): string {
  // Render-path callers hand this whatever the wire carried — a number
  // where a path was expected, a path with a NUL byte — before any schema
  // check; a display helper never throws for them (the shape the executor
  // refuses is still shown as the model spelled it).
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

/** Windows paths compare separator- and case-insensitively. */
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

/**
 * Directory-empty check: not-found counts as empty; every other error (a
 * permission error on a protected folder) counts as NOT empty.
 */
export function isDirEmpty(dirPath: string): boolean {
  try {
    return getFsImplementation().isDirEmptySync(dirPath)
  } catch (err) {
    return isENOENT(err)
  }
}

/**
 * The NAME of the first sibling whose extension-stripped base name matches
 * the requested path's, excluding the requested path itself (an entry
 * differing only in directory case still qualifies).
 */
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

/**
 * Detect the "dropped repository folder" pattern: an absolute path built
 * without the repository directory component. The requested path's PARENT
 * is canonicalised through symlinks (the working directory it is compared
 * with is already canonical), and the path is re-rooted under the working
 * directory when it lies under the working directory's parent but not
 * under (or at) the working directory itself.
 */
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
    // At the filesystem root the prefix is the root itself — appending a
    // separator would double it and never match.
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

/**
 * The compact line-prefix format is the default; the remote kill switch
 * only turns it off. Purely client-side, safe on every provider. The
 * padded-arrow format's per-line overhead measured at fleet scale as a
 * low-single-digit percentage of uncached input.
 */
export function isCompactLinePrefixEnabled(): boolean {
  return !getFeatureValue_CACHED_MAY_BE_STALE('mercury_compact_line_prefix_killswitch', false)
}

/**
 * Number lines in the active prefix format. Compact: `N<TAB>line`. Legacy:
 * the number left-padded to width 6 plus a right arrow — unpadded from six
 * digits up.
 */
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

/** Strip any numbering prefix from a single line; kept in sync with
 *  addLineNumbers AND its anchored sibling (lineAnchors.ts
 *  addAnchoredLineNumbers), whose prefix carries `#<hex>` before the
 *  separator — width-agnostic here so a hash-width change never strands
 *  this stripper. */
export function stripLineNumberPrefix(line: string): string {
  const match = /^\s*\d+(?:#[0-9a-f]+)?(?:→|\t)([\s\S]*)$/.exec(line)
  return match ? (match[1] as string) : line
}

/** True when the file's size is within the read limit; stat failure fails validation. */
export function isFileWithinReadSizeLimit(filePath: string, maxSizeBytes: number = MAX_OUTPUT_SIZE): boolean {
  try {
    return statSync(filePath).size <= maxSizeBytes
  } catch {
    return false
  }
}

// The four well-known non-user account directories under the mounted users
// root.
const WINDOWS_SYSTEM_USER_DIRS = new Set(['Public', 'Default', 'Default User', 'All Users'])

/**
 * The desktop directory, branched on the shared platform accessor. The
 * mounted-drive arm is gated on the accessor's `windows` value — which the
 * accessor reports only on native win32, where `/mnt/c` cannot exist — so
 * it is unreachable in effect on both hosts; reproduced as built (the `wsl`
 * gate is a backlog change, not an implementer's).
 */
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
