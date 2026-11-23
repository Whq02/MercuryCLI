import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { getErrnoCode } from '../errors/errors.js'
import { slowLogging } from '../logs/slowOperations.js'
import { uncPathRisk } from '../../permissions/rules/uncPath.js'
import { isWindowsShareRooted } from '../host-os/paths.js'
import { passedOver } from '../errors/passedOver.js'

export type FsOperations = {
  appendFileSync(path: string, text: string, options?: { mode?: number }): void
  copyFileSync(source: string, destination: string): void
  createWriteStream(path: string, options?: Parameters<typeof fs.createWriteStream>[1]): fs.WriteStream
  cwd(): string
  existsSync(path: string): boolean
  isDirEmptySync(path: string): boolean
  linkSync(source: string, destination: string): void
  lstatSync(path: string): fs.Stats
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  mkdirSync(path: string, options?: { mode?: number }): void
  readdir(path: string): Promise<fs.Dirent[]>
  readdirSync(path: string): fs.Dirent[]
  readdirStringSync(path: string): string[]
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>
  readFileBytes(path: string, maxBytes?: number): Promise<Buffer>
  readFileBytesSync(path: string): Buffer
  readFileChunks?(path: string, chunkSize: number, onChunk: (chunk: Buffer) => void): Promise<void>
  readFileSync(path: string, options: { encoding: BufferEncoding }): string
  readlinkSync(path: string): string
  readSync(path: string, options: { length: number }): { buffer: Buffer; bytesRead: number }
  realpathSync(path: string): string
  rename(source: string, destination: string): Promise<void>
  renameSync(source: string, destination: string): void
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
  rmdir(path: string): Promise<void>
  rmdirSync(path: string): void
  rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void
  stat(path: string): Promise<fs.Stats>
  statSync(path: string): fs.Stats
  symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void
  unlink(path: string): Promise<void>
  unlinkSync(path: string): void
}

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

async function readWindow(handle: fs.promises.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let used = 0
  while (used < length) {
    const { bytesRead } = await handle.read(buffer, used, length - used, offset + used)
    if (bytesRead === 0) break
    used += bytesRead
  }
  return buffer.subarray(0, used)
}

const NodeFsOperations: FsOperations = {
  appendFileSync: (path, text, options) => withSlowLog(`appendFileSync ${path} (${text.length} chars)`, () => {
    if (options?.mode !== undefined) {
      try {
        return fs.writeFileSync(path, text, { flag: 'wx', mode: options.mode })
      } catch (error) {
        if (getErrnoCode(error) !== 'EEXIST') throw error
      }
    }
    fs.appendFileSync(path, text)
  }),
  copyFileSync: (source, destination) => withSlowLog(`copyFileSync ${source}`, () => fs.copyFileSync(source, destination)),
  createWriteStream: fs.createWriteStream,
  cwd: () => process.cwd(),
  existsSync: path => withSlowLog(`existsSync ${path}`, () => fs.existsSync(path)),
  isDirEmptySync: path => withSlowLog(`isDirEmptySync ${path}`, () => getFsImplementation().readdirStringSync(path).length === 0),
  linkSync: (source, destination) => withSlowLog(`linkSync ${source}`, () => fs.linkSync(source, destination)),
  lstatSync: path => withSlowLog(`lstatSync ${path}`, () => fs.lstatSync(path)),
  async mkdir(path, options) {
    await fs.promises.mkdir(path, { ...options, recursive: true }).catch(swallowExistingDirectory)
  },
  mkdirSync: (path, options) => withSlowLog(`mkdirSync ${path}`, () => {
    try {
      fs.mkdirSync(path, { ...options, recursive: true })
    } catch (error) {
      swallowExistingDirectory(error)
    }
  }),
  readdir: path => fs.promises.readdir(path, { withFileTypes: true }),
  readdirSync: path => withSlowLog(`readdirSync ${path}`, () => fs.readdirSync(path, { withFileTypes: true })),
  readdirStringSync: path => withSlowLog(`readdirStringSync ${path}`, () => fs.readdirSync(path)),
  readFile: fs.promises.readFile,
  async readFileBytes(path, maxBytes) {
    if (maxBytes === undefined) return fs.promises.readFile(path)
    const handle = await fs.promises.open(path, 'r')
    try {
      const { size } = await handle.stat()
      return await readWindow(handle, 0, Math.min(size, maxBytes))
    } finally {
      await handle.close()
    }
  },
  readFileBytesSync: path => withSlowLog(`readFileBytesSync ${path}`, () => fs.readFileSync(path)),
  async readFileChunks(path, chunkSize, onChunk) {
    const handle = await fs.promises.open(path, 'r')
    try {
      const buffer = Buffer.alloc(chunkSize)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        onChunk(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  },
  readFileSync: (path, options) => withSlowLog(`readFileSync ${path}`, () => fs.readFileSync(path, options)),
  readlinkSync: path => withSlowLog(`readlinkSync ${path}`, () => fs.readlinkSync(path)),
  readSync: (path, { length }) => withSlowLog(`readSync ${path} (${length} bytes)`, () => {
    const fd = fs.openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      return { buffer, bytesRead: fs.readSync(fd, buffer, 0, length, 0) }
    } finally {
      fs.closeSync(fd)
    }
  }),
  realpathSync: path => withSlowLog(`realpathSync ${path}`, () => fs.realpathSync(path).normalize('NFC')),
  rename: fs.promises.rename,
  renameSync: (source, destination) => withSlowLog(`renameSync ${source}`, () => fs.renameSync(source, destination)),
  rm: fs.promises.rm,
  rmdir: fs.promises.rmdir,
  rmdirSync: path => withSlowLog(`rmdirSync ${path}`, () => fs.rmdirSync(path)),
  rmSync: (path, options) => withSlowLog(`rmSync ${path}`, () => fs.rmSync(path, options)),
  stat: fs.promises.stat,
  statSync: path => withSlowLog(`statSync ${path}`, () => fs.statSync(path)),
  symlinkSync: (target, path, type) => withSlowLog(`symlinkSync ${path}`, () => fs.symlinkSync(target, path, type)),
  unlink: fs.promises.unlink,
  unlinkSync: path => withSlowLog(`unlinkSync ${path}`, () => fs.unlinkSync(path)),
}

let activeFs: FsOperations = NodeFsOperations

export function getFsImplementation(): FsOperations {
  return activeFs
}

export function setFsImplementation(impl: FsOperations): void {
  activeFs = impl
}

export function setOriginalFsImplementation(): void {
  activeFs = NodeFsOperations
}


export function isUncLikePath(path: string): boolean {
  return uncPathRisk(path).risky || isWindowsShareRooted(path, false)
}

function isSpecialFile(stats: fs.Stats): boolean {
  return stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()
}
export function safeResolvePath(
  fsImpl: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  const unresolved = { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  if (isUncLikePath(filePath)) return unresolved
  try {
    if (isSpecialFile(fsImpl.lstatSync(filePath))) return unresolved
    const resolvedPath = fsImpl.realpathSync(filePath)
    return { resolvedPath, isSymlink: resolvedPath !== filePath, isCanonical: true }
  } catch (error) {
    passedOver(error)
    return unresolved
  }
}


function resolveDeepestExistingAncestorSync(fsImpl: FsOperations, absolutePath: string): string | undefined {
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
        } catch (error) {
          passedOver(error)
          return undefined
        }
      }
      return tail.length > 0 ? join(target, ...tail) : target
    }
    try {
      const real = fsImpl.realpathSync(current)
      if (real === current) return undefined
      return tail.length > 0 ? join(real, ...tail) : real
    } catch (error) {
      passedOver(error)
      return undefined
    }
  }
}

const MAX_SYMLINK_HOPS = 40

export function getPathsForPermissionCheck(inputPath: string, baseDir?: string): string[] {
  const fsImpl = getFsImplementation()
  let start = inputPath
  if (inputPath === '~') start = homedir().normalize('NFC')
  else if (inputPath.startsWith('~/')) start = join(homedir(), inputPath.slice(2))
  const paths = new Set([start])
  if (isUncLikePath(start)) return [...paths]
  if (baseDir !== undefined && !isAbsolute(start)) {
    start = resolve(baseDir, start)
    paths.add(start)
  }
  try {
    const visited = new Set<string>()
    let current = start
    while (visited.size < MAX_SYMLINK_HOPS && !visited.has(current)) {
      visited.add(current)
      if (!fsImpl.existsSync(current)) {
        const ancestor = resolveDeepestExistingAncestorSync(fsImpl, current)
        if (ancestor === undefined || visited.has(ancestor)) break
        current = ancestor
      } else {
        const stats = fsImpl.lstatSync(current)
        if (isSpecialFile(stats) || !stats.isSymbolicLink()) break
        const target = fsImpl.readlinkSync(current)
        current = isAbsolute(target) ? target : resolve(dirname(current), target)
      }
      paths.add(current)
      if (isUncLikePath(current)) return [...paths]
    }
    const result = safeResolvePath(fsImpl, start)
    if (result.isSymlink && result.resolvedPath !== start) paths.add(result.resolvedPath)
  } catch (error) {
    passedOver(error)
  }
  return [...paths]
}


export type ReadFileRangeResult = {
  content: string
  bytesRead: number
  bytesTotal: number
}

function flatString(buffer: Buffer): string {
  return buffer.toString('utf8')
}

export async function readFileRange(path: string, offset: number, maxBytes: number): Promise<ReadFileRangeResult | null> {
  const handle = await fs.promises.open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= offset) return null
    const bytes = await readWindow(handle, offset, Math.min(size - offset, maxBytes))
    return { content: flatString(bytes), bytesRead: bytes.length, bytesTotal: size }
  } finally {
    await handle.close()
  }
}

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
