import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { getErrnoCode } from './errors.js'
import { slowLogging } from './slowOperations.js'
import { uncPathRisk } from './permissions/uncPath.js'
import { isWindowsShareRooted } from './platform/paths.js'
import { passedOver } from './passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


export type FsOperations = Unbuilt

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

const NodeFsOperations: FsOperations = unbuilt('src/utils/fsOperations.ts:61')

let activeFs: FsOperations = unbuilt('src/utils/fsOperations.ts:165')

export function getFsImplementation(): FsOperations {
  return notBuilt('src/utils/fsOperations.ts:167')
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

export function safeResolvePath(
  fsImpl: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  return notBuilt('src/utils/fsOperations.ts:188')
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
  return notBuilt('src/utils/fsOperations.ts:253')
}


export type ReadFileRangeResult = Unbuilt

function flatString(buffer: Buffer): string {
  return notBuilt('src/utils/fsOperations.ts:310')
}

export async function readFileRange(path: string, offset: number, maxBytes: number): Promise<ReadFileRangeResult | null> {
  return notBuilt('src/utils/fsOperations.ts:314')
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
