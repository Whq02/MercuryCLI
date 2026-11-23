import { isAbsolute, normalize } from 'node:path'
import { logForDebugging } from '../debug.js'
import { containsPathTraversal } from '../path.js'

const MAX_FILES = 100_000
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 50
const MIB = 1024 * 1024

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const EOCD_MIN_LEN = 22
const MAX_ZIP_COMMENT_LEN = 65_535

type ZipRun = {
  count: number
  sum: number
  readonly archiveBytes: number
}

function entryFailure(run: ZipRun, name: string, size: number): string | undefined {
  run.count += 1
  let reason: string | undefined
  if (run.count > MAX_FILES) {
    reason = `Zip contains too many files (${run.count} > 100000)`
  }
  if (containsPathTraversal(name) || isAbsolute(normalize(name))) {
    reason = `Zip entry has an unsafe path: ${name} (path traversal and absolute paths are not allowed)`
  }
  if (size > MAX_ENTRY_BYTES) {
    reason = `Zip entry ${name} is too large (${Math.round(size / MIB)}MB > 512MB)`
  }
  run.sum += size
  if (run.sum > MAX_TOTAL_BYTES) {
    reason = `Zip uncompressed total is too large (${Math.round(run.sum / MIB)}MB > 1024MB)`
  }
  if (run.archiveBytes > 0 && run.sum / run.archiveBytes > MAX_COMPRESSION_RATIO) {
    reason = `Zip compression ratio is suspicious (${(run.sum / run.archiveBytes).toFixed(1)}:1 > 50:1); this may be a zip bomb`
  }
  return reason
}

export async function unzipFile(zipData: Buffer): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate')
  const run: ZipRun = { count: 0, sum: 0, archiveBytes: zipData.byteLength }
  const unzipped = unzipSync(zipData, {
    filter(file) {
      const reason = entryFailure(run, file.name, file.originalSize)
      if (reason !== undefined) throw new Error(reason)
      return true
    },
  })
  logForDebugging(`unzipped ${run.count} files (${Math.round(run.sum / 1024)}KB uncompressed)`)
  return unzipped
}

export function parseZipModes(data: Uint8Array): Record<string, number> {
  const modes: Record<string, number> = {}
  if (data.byteLength < EOCD_MIN_LEN) return modes
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const minPos = Math.max(0, data.byteLength - EOCD_MIN_LEN - MAX_ZIP_COMMENT_LEN)
  let eocdOffset = -1
  for (let pos = data.byteLength - EOCD_MIN_LEN; pos >= minPos; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIGNATURE) {
      eocdOffset = pos
      break
    }
  }
  if (eocdOffset === -1) return modes

  const entryCount = view.getUint16(eocdOffset + 10, true)
  let offset = view.getUint32(eocdOffset + 16, true)
  const decoder = new TextDecoder('utf-8')

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > data.byteLength) break
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) break
    const versionMadeBy = view.getUint16(offset + 4, true)
    const fileNameLen = view.getUint16(offset + 28, true)
    const extraFieldLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const externalAttrs = view.getUint32(offset + 38, true)
    const nameStart = offset + 46
    const nameEnd = nameStart + fileNameLen
    if (nameEnd > data.byteLength) break

    const creator = versionMadeBy >>> 8
    const mode = externalAttrs >>> 16
    if (creator === 3 && mode !== 0) {
      modes[decoder.decode(data.subarray(nameStart, nameEnd))] = mode
    }
    offset = nameEnd + extraFieldLen + commentLen
  }

  return modes
}
