import { unzip } from 'fflate'
import { logForDebugging } from '../debug.js'
import { containsPathTraversal } from '../path.js'

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 500 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_COMPRESSION_RATIO = 100

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const EOCD_MIN_LEN = 22
const MAX_ZIP_COMMENT_LEN = 65_535

type ZipValidationCounts = {
  fileCount: number
  totalSize: number
}

type ZipValidationResult = { valid: true } | { valid: false; reason: string }

function hasUnsafeEntryPath(entryName: string): boolean {
  if (entryName.includes('\0')) return true
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return true
  if (/^[A-Za-z]:/.test(entryName)) return true
  return containsPathTraversal(entryName)
}

function validateZipEntry(
  name: string,
  entrySize: number,
  counts: ZipValidationCounts,
  archiveByteLength: number,
): ZipValidationResult {
  counts.fileCount += 1
  if (counts.fileCount > MAX_FILES) {
    return { valid: false, reason: `ZIP archive exceeds maximum entry count (${MAX_FILES})` }
  }
  if (hasUnsafeEntryPath(name)) {
    return { valid: false, reason: `ZIP archive contains unsafe path: ${name}` }
  }
  if (entrySize > MAX_FILE_BYTES) {
    return { valid: false, reason: `ZIP entry "${name}" exceeds maximum size (${MAX_FILE_BYTES} bytes)` }
  }
  counts.totalSize += entrySize
  if (counts.totalSize > MAX_TOTAL_BYTES) {
    return { valid: false, reason: `ZIP archive exceeds maximum uncompressed size (${MAX_TOTAL_BYTES} bytes)` }
  }
  if (archiveByteLength > 0 && counts.totalSize / archiveByteLength > MAX_COMPRESSION_RATIO) {
    return { valid: false, reason: `ZIP archive exceeds maximum compression ratio (${MAX_COMPRESSION_RATIO}:1)` }
  }
  return { valid: true }
}

export async function unzipFile(zipData: Buffer): Promise<Record<string, Uint8Array>> {
  const bytes = new Uint8Array(zipData.buffer, zipData.byteOffset, zipData.byteLength)
  const archiveByteLength = zipData.byteLength
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let rejection: Error | null = null
    const declaredCounts: ZipValidationCounts = { fileCount: 0, totalSize: 0 }

    unzip(
      bytes,
      {
        filter(file) {
          if (rejection !== null) return false
          const check = validateZipEntry(file.name, file.originalSize, declaredCounts, archiveByteLength)
          if (!check.valid) {
            rejection = new Error(check.reason)
            return false
          }
          return true
        },
      },
      (err, unzipped) => {
        if (rejection !== null) {
          reject(rejection)
          return
        }
        if (err) {
          reject(err)
          return
        }
        const actualCounts: ZipValidationCounts = { fileCount: 0, totalSize: 0 }
        for (const [name, content] of Object.entries(unzipped)) {
          const check = validateZipEntry(name, content.byteLength, actualCounts, archiveByteLength)
          if (!check.valid) {
            reject(new Error(check.reason))
            return
          }
        }
        logForDebugging(`Unzipped ${actualCounts.fileCount} files (${Math.round(actualCounts.totalSize / 1024)} KiB)`)
        resolve(unzipped)
      },
    )
  })
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
