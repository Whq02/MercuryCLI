import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { getErrnoCode } from './errors.js'
import { slowLogging } from './slowOperations.js'

/**
 * The swappable filesystem facade, path/symlink safety, and ranged reads.
 * All synchronous file access goes through the active implementation so it
 * can be swapped for mocks and virtual filesystems.
 */

export interface FsOperations {
  cwd(): string
  existsSync(path: string): boolean
  stat(path: string): Promise<fs.Stats>
  readdir(path: string): Promise<fs.Dirent[]>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>
  rename(from: string, to: string): Promise<void>
  statSync(path: string): fs.Stats
  lstatSync(path: string): fs.Stats
  readFileSync(path: string, options: { encoding: BufferEncoding }): string
  readFileBytesSync(path: string): Buffer
  readSync(path: string, options: { length: number }): { buffer: Buffer; bytesRead: number }
  appendFileSync(path: string, data: string, options?: { mode?: number }): void
  copyFileSync(from: string, to: string): void
  unlinkSync(path: string): void
  renameSync(from: string, to: string): void
  linkSync(from: string, to: string): void
  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void
  readlinkSync(path: string): string
  realpathSync(path: string): string
  mkdirSync(path: string, options?: { mode?: number }): void
  readdirSync(path: string): fs.Dirent[]
  readdirStringSync(path: string): string[]
  isDirEmptySync(path: string): boolean
  rmdirSync(path: string): void
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  createWriteStream(path: string, options?: Parameters<typeof fs.createWriteStream>[1]): fs.WriteStream
  readFileBytes(path: string, maxBytes?: number): Promise<Buffer>
  /** FN-020 row 11: the file in bounded chunks through one handle, for a
   *  scan that never holds the whole file. `onChunk` receives a view of a
   *  REUSED buffer — copy what must outlive the call. Optional, so a fake
   *  implementation that lacks it falls back to readFileBytes at the
   *  caller. */
  readFileChunks?(path: string, chunkBytes: number, onChunk: (chunk: Buffer) => void): Promise<void>
}

/**
 * On Bun/Windows a recursive mkdir can throw EEXIST for a directory carrying
 * the read-only attribute (group policy, cloud-sync folders); that specific
 * code is swallowed, everything else rethrown.
 */
function swallowExistingDirectory(err: unknown): void {
  if (getErrnoCode(err) === 'EEXIST') return
  throw err
}

function withSlowLog<T>(label: string, fn: () => T): T {
  const slow = slowLogging`${label}`
  try {
    return fn()
  } finally {
    slow[Symbol.dispose]()
  }
}

export const NodeFsOperations: FsOperations = {
  cwd: () => process.cwd(),
  existsSync: path => withSlowLog(`existsSync ${path}`, () => fs.existsSync(path)),
  stat: path => fs.promises.stat(path),
  readdir: path => fs.promises.readdir(path, { withFileTypes: true }),
  unlink: path => fs.promises.unlink(path),
  rmdir: path => fs.promises.rmdir(path),
  rm: (path, options) => fs.promises.rm(path, options),
  async mkdir(path, options) {
    try {
      await fs.promises.mkdir(path, { recursive: true, mode: options?.mode })
    } catch (err) {
      swallowExistingDirectory(err)
    }
  },
  readFile: (path, options) => fs.promises.readFile(path, options),
  rename: (from, to) => fs.promises.rename(from, to),
  statSync: path => withSlowLog(`statSync ${path}`, () => fs.statSync(path)),
  lstatSync: path => withSlowLog(`lstatSync ${path}`, () => fs.lstatSync(path)),
  readFileSync: (path, options) =>
    withSlowLog(`readFileSync ${path}`, () => fs.readFileSync(path, options)),
  readFileBytesSync: path => withSlowLog(`readFileBytesSync ${path}`, () => fs.readFileSync(path)),
  readSync: (path, options) =>
    withSlowLog(`readSync ${path} (${options.length} bytes)`, () => {
      // Open, allocate exactly the requested length, read from offset zero,
      // always close.
      const fd = fs.openSync(path, 'r')
      try {
        const buffer = Buffer.alloc(options.length)
        const bytesRead = fs.readSync(fd, buffer, 0, options.length, 0)
        return { buffer, bytesRead }
      } finally {
        fs.closeSync(fd)
      }
    }),
  appendFileSync: (path, data, options) =>
    withSlowLog(`appendFileSync ${path} (${data.length} chars)`, () => {
      if (options?.mode !== undefined) {
        // Create atomically with the mode (no check-then-open race); if the
        // file already exists, fall back to a plain append keeping its mode.
        try {
          fs.writeFileSync(path, data, { flag: 'wx', mode: options.mode })
          return
        } catch (err) {
          if (getErrnoCode(err) !== 'EEXIST') throw err
        }
      }
      fs.appendFileSync(path, data)
    }),
  copyFileSync: (from, to) => withSlowLog(`copyFileSync ${from}`, () => fs.copyFileSync(from, to)),
  unlinkSync: path => withSlowLog(`unlinkSync ${path}`, () => fs.unlinkSync(path)),
  renameSync: (from, to) => withSlowLog(`renameSync ${from}`, () => fs.renameSync(from, to)),
  linkSync: (from, to) => withSlowLog(`linkSync ${from}`, () => fs.linkSync(from, to)),
  symlinkSync: (target, path, type) =>
    withSlowLog(`symlinkSync ${path}`, () => fs.symlinkSync(target, path, type)),
  readlinkSync: path => withSlowLog(`readlinkSync ${path}`, () => fs.readlinkSync(path)),
  // Realpath results are NFC-normalised.
  realpathSync: path => withSlowLog(`realpathSync ${path}`, () => fs.realpathSync(path).normalize('NFC')),
  mkdirSync: (path, options) =>
    withSlowLog(`mkdirSync ${path}`, () => {
      try {
        fs.mkdirSync(path, { recursive: true, mode: options?.mode })
      } catch (err) {
        swallowExistingDirectory(err)
      }
    }),
  readdirSync: path => withSlowLog(`readdirSync ${path}`, () => fs.readdirSync(path, { withFileTypes: true })),
  readdirStringSync: path => withSlowLog(`readdirStringSync ${path}`, () => fs.readdirSync(path)),
  isDirEmptySync(path) {
    // Defined through the facade's own listing so a swapped implementation
    // stays consistent.
    return withSlowLog(`isDirEmptySync ${path}`, () => activeFs.readdirStringSync(path).length === 0)
  },
  rmdirSync: path => withSlowLog(`rmdirSync ${path}`, () => fs.rmdirSync(path)),
  rmSync: (path, options) => withSlowLog(`rmSync ${path}`, () => fs.rmSync(path, options)),
  createWriteStream: (path, options) => fs.createWriteStream(path, options),
  async readFileBytes(path, maxBytes) {
    if (maxBytes === undefined) return fs.promises.readFile(path)
    const handle = await fs.promises.open(path, 'r')
    try {
      const { size } = await handle.stat()
      const wanted = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(wanted)
      let offset = 0
      while (offset < wanted) {
        const { bytesRead } = await handle.read(buffer, offset, wanted - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      // A short read is trimmed, never padded.
      return offset === wanted ? buffer : buffer.subarray(0, offset)
    } finally {
      await handle.close()
    }
  },
  async readFileChunks(path, chunkBytes, onChunk) {
    const handle = await fs.promises.open(path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(chunkBytes)
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position)
        if (bytesRead === 0) break
        onChunk(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally {
      await handle.close()
    }
  },
}

let activeFs: FsOperations = NodeFsOperations

export function getFsImplementation(): FsOperations {
  return activeFs
}

/** Swap the implementation (mocks/virtual filesystems); the process cwd is untouched. */
export function setFsImplementation(impl: FsOperations): void {
  activeFs = impl
}

export function setOriginalFsImplementation(): void {
  activeFs = NodeFsOperations
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** A leading double separator, either slash direction. */
function isUncLikePath(path: string): boolean {
  return /^(\\\\|\/\/)/.test(path)
}

function isSpecialFile(stats: fs.Stats): boolean {
  return stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()
}

/**
 * Resolve a path safely: UNC-style paths are returned unresolved BEFORE any
 * filesystem call (touching one triggers network name resolution on
 * Windows); special files (FIFO/socket/device) are detected with a
 * non-following stat and returned unresolved (realpath can block on a FIFO
 * waiting for a writer); otherwise realpath, with "was a symlink" meaning
 * the resolved string differs from the input. Any failure returns the
 * original path so callers can proceed to create the file.
 */
export function safeResolvePath(
  fsImpl: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  if (isUncLikePath(filePath)) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
  try {
    const stats = fsImpl.lstatSync(filePath)
    if (isSpecialFile(stats)) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }
    const resolved = fsImpl.realpathSync(filePath)
    return { resolvedPath: resolved, isSymlink: resolved !== filePath, isCanonical: true }
  } catch {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

/** Resolve a path and report whether its resolved form is already loaded; adds it when not. */
export function isDuplicatePath(fsImpl: FsOperations, filePath: string, loadedPaths: Set<string>): boolean {
  const { resolvedPath } = safeResolvePath(fsImpl, filePath)
  if (loadedPaths.has(resolvedPath)) return true
  loadedPaths.add(resolvedPath)
  return false
}

/**
 * For a path that may not exist yet, the real destination of a write once
 * every symlink on the way has been honoured. Walk upward with
 * non-following stats collecting the non-existent tail; the first symlink
 * component (live or dangling) or the first existing non-symlink component
 * terminates the walk. Undefined means "no symlink was involved".
 */
export function resolveDeepestExistingAncestorSync(fsImpl: FsOperations, absolutePath: string): string | undefined {
  const tail: string[] = []
  let current = absolutePath
  for (;;) {
    let stats: fs.Stats | null = null
    try {
      stats = fsImpl.lstatSync(current)
    } catch {
      stats = null
    }
    if (stats === null) {
      const parent = dirname(current)
      if (parent === current) return undefined
      tail.unshift(current.slice(parent.length + 1))
      current = parent
      continue
    }
    if (stats.isSymbolicLink()) {
      let target: string
      try {
        target = fsImpl.realpathSync(current)
      } catch {
        try {
          const link = fsImpl.readlinkSync(current)
          target = isAbsolute(link) ? link : resolve(dirname(current), link)
        } catch {
          return undefined
        }
      }
      return tail.length > 0 ? join(target, ...tail) : target
    }
    try {
      const real = fsImpl.realpathSync(current)
      if (real === current) return undefined
      return tail.length > 0 ? join(real, ...tail) : real
    } catch {
      return undefined
    }
  }
}

const MAX_SYMLINK_HOPS = 40

/**
 * Every absolute path a permission rule should be evaluated against for an
 * input path. The security intent: a deny rule naming an INTERMEDIATE path
 * (a system file that is itself a symlink) must match even though the final
 * resolved path differs. Membership is the contract, not order; no
 * duplicates.
 */
export function getPathsForPermissionCheck(inputPath: string): string[] {
  const fsImpl = getFsImplementation()
  const home = homedir().normalize('NFC')
  let path = inputPath
  if (path === '~') path = home
  else if (path.startsWith('~/')) path = join(home, path.slice(2))

  const results = new Set<string>()
  results.add(path)
  if (isUncLikePath(path)) return [...results]

  try {
    const visited = new Set<string>()
    let current = path
    let hops = 0
    for (;;) {
      if (visited.has(current) || hops >= MAX_SYMLINK_HOPS) break
      visited.add(current)
      hops++
      // The existence probe follows links, so this also covers a dangling
      // symlink; only the ORIGINAL input gets the deepest-ancestor treatment
      // (a live parent-directory symlink or a dangling file symlink would
      // otherwise let a write escape the working directory undetected).
      if (!fsImpl.existsSync(current)) {
        if (current === path) {
          const deepest = resolveDeepestExistingAncestorSync(fsImpl, path)
          if (deepest) results.add(deepest)
        }
        break
      }
      const stats = fsImpl.lstatSync(current)
      if (isSpecialFile(stats)) break
      if (!stats.isSymbolicLink()) break
      const link = fsImpl.readlinkSync(current)
      const target = isAbsolute(link) ? link : resolve(dirname(current), link)
      results.add(target)
      current = target
    }
    // Symlinks in DIRECTORY components.
    const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, path)
    if (isSymlink && resolvedPath !== path) results.add(resolvedPath)
  } catch {
    // Keep whatever was collected.
  }
  return [...results]
}

// ---------------------------------------------------------------------------
// Ranged reads
// ---------------------------------------------------------------------------

export type ReadFileRangeResult = {
  content: string
  bytesRead: number
  bytesTotal: number
}

// A flat string, not a view into a larger buffer.
function flatString(buffer: Buffer): string {
  return buffer.toString('utf8')
}

/** Read `min(size - offset, maxBytes)` bytes from `offset`; null when the file is not longer than the offset. */
export async function readFileRange(path: string, offset: number, maxBytes: number): Promise<ReadFileRangeResult | null> {
  const handle = await fs.promises.open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= offset) return null
    const wanted = Math.min(size - offset, maxBytes)
    const buffer = Buffer.alloc(wanted)
    let read = 0
    while (read < wanted) {
      const { bytesRead } = await handle.read(buffer, read, wanted - read, offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { content: flatString(buffer.subarray(0, read)), bytesRead: read, bytesTotal: size }
  } finally {
    await handle.close()
  }
}

/** The last `maxBytes` bytes (or the whole file when smaller); empty for an empty file. */
export async function tailFile(path: string, maxBytes: number): Promise<ReadFileRangeResult> {
  const handle = await fs.promises.open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return { content: '', bytesRead: 0, bytesTotal: 0 }
    const wanted = Math.min(size, maxBytes)
    const start = size - wanted
    const buffer = Buffer.alloc(wanted)
    let read = 0
    while (read < wanted) {
      const { bytesRead } = await handle.read(buffer, read, wanted - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { content: flatString(buffer.subarray(0, read)), bytesRead: read, bytesTotal: size }
  } finally {
    await handle.close()
  }
}

/** Synchronous twin of `tailFile` for render-path callers that poll a tail
 *  and cannot take an async hop (a useState initializer, a 1 Hz interval).
 *  Reads ONLY the final `maxBytes` — never the whole file: the whole-file
 *  `readFileSync(path, 'utf8')` form re-read and re-decoded a growing task
 *  output every second, and past V8's max string length the decode threw,
 *  so the frame claimed a gigabyte-producing shell had produced nothing
 *  (TASK-017 S2, shell-detail-reads-whole-output-file-at-1hz). */
export function tailFileSync(path: string, maxBytes: number): ReadFileRangeResult {
  const fd = fs.openSync(path, 'r')
  try {
    const { size } = fs.fstatSync(fd)
    if (size === 0) return { content: '', bytesRead: 0, bytesTotal: 0 }
    const wanted = Math.min(size, maxBytes)
    const start = size - wanted
    const buffer = Buffer.alloc(wanted)
    let read = 0
    while (read < wanted) {
      const bytesRead = fs.readSync(fd, buffer, read, wanted - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { content: flatString(buffer.subarray(0, read)), bytesRead: read, bytesTotal: size }
  } finally {
    fs.closeSync(fd)
  }
}

const REVERSE_CHUNK_BYTES = 4096

/**
 * Yield lines last-to-first, reading backwards in 4 KiB chunks. The carry
 * across a chunk boundary is RAW BYTES, not a decoded string — decoding per
 * chunk turns a UTF-8 sequence split by the boundary into replacement
 * characters on both sides, which for JSON-lines history means the entry
 * silently fails to parse. Empty lines are skipped; terminators other than
 * LF are not stripped (a CRLF file yields lines ending in CR).
 */
export async function* readLinesReverse(path: string): AsyncGenerator<string, void, undefined> {
  const handle = await fs.promises.open(path, 'r')
  try {
    const { size } = await handle.stat()
    let position = size
    let remainder: Buffer = Buffer.alloc(0)
    while (position > 0) {
      const chunkSize = Math.min(REVERSE_CHUNK_BYTES, position)
      position -= chunkSize
      const chunk = Buffer.alloc(chunkSize)
      let read = 0
      while (read < chunkSize) {
        const { bytesRead } = await handle.read(chunk, read, chunkSize - read, position + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      // The chunk goes IN FRONT of the carried remainder.
      const combined = Buffer.concat([chunk.subarray(0, read), remainder])
      const firstNewline = combined.indexOf(0x0a)
      if (firstNewline === -1) {
        remainder = combined
        continue
      }
      remainder = combined.subarray(0, firstNewline)
      const decoded = combined.subarray(firstNewline + 1).toString('utf8')
      const lines = decoded.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] as string
        if (line.length > 0) yield line
      }
    }
    if (remainder.length > 0) {
      const line = remainder.toString('utf8')
      if (line.length > 0) yield line
    }
  } finally {
    await handle.close()
  }
}
