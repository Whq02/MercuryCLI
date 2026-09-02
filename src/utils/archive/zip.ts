import { isAbsolute, normalize } from 'node:path'

import { logForDebugging } from '../debug.js'
import { containsPathTraversal } from '../path.js'


const MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_SIZE_BYTES = 1024 * 1024 * 1024
const MAX_FILE_COUNT = 100_000
const MAX_COMPRESSION_RATIO = 50
const MIN_COMPRESSION_RATIO = 0.5
void MIN_COMPRESSION_RATIO

export function isPathSafe(filePath: string): boolean {
  if (containsPathTraversal(filePath)) return false
  return !isAbsolute(normalize(filePath))
}

export type ZipValidationState = {
  fileCount: number
  totalUncompressedSize: number
  compressedSize: number
  errors: string[]
}

export function validateZipFile(
  file: { name: string; originalSize?: number },
  state: ZipValidationState,
): { isValid: boolean; error?: string } {
  state.fileCount++
  const size = file.originalSize ?? 0
  let isValid = true
  let error: string | undefined

  if (state.fileCount > MAX_FILE_COUNT) {
    isValid = false
    error = `Zip contains too many files (${state.fileCount} > ${MAX_FILE_COUNT})`
  }
  if (!isPathSafe(file.name)) {
    isValid = false
    error = `Zip entry has an unsafe path: ${file.name} (path traversal and absolute paths are not allowed)`
  }
  if (size > MAX_FILE_SIZE_BYTES) {
    isValid = false
    error = `Zip entry ${file.name} is too large (${Math.round(size / 1024 / 1024)}MB > ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB)`
  }
  state.totalUncompressedSize += size
  if (state.totalUncompressedSize > MAX_TOTAL_SIZE_BYTES) {
    isValid = false
    error = `Zip uncompressed total is too large (${Math.round(state.totalUncompressedSize / 1024 / 1024)}MB > ${Math.round(MAX_TOTAL_SIZE_BYTES / 1024 / 1024)}MB)`
  }
  if (state.compressedSize > 0) {
    const ratio = state.totalUncompressedSize / state.compressedSize
    if (ratio > MAX_COMPRESSION_RATIO) {
      isValid = false
      error = `Zip compression ratio is suspicious (${ratio.toFixed(1)}:1 > ${MAX_COMPRESSION_RATIO}:1); this may be a zip bomb`
    }
  }
  return isValid ? { isValid } : { isValid, error }
}

export async function unzipFile(zipData: Buffer): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate')
  const state: ZipValidationState = {
    fileCount: 0,
    totalUncompressedSize: 0,
    compressedSize: zipData.byteLength,
    errors: [],
  }
  const extracted = unzipSync(new Uint8Array(zipData), {
    filter: file => {
      const result = validateZipFile({ name: file.name, originalSize: file.originalSize }, state)
      if (!result.isValid) {
        throw new Error(result.error)
      }
      return true
    },
  })
  logForDebugging(
    `unzipped ${state.fileCount} files (${Math.round(state.totalUncompressedSize / 1024)}KB uncompressed)`,
  )
  return extracted
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const EOCD_SIZE = 22
const MAX_COMMENT_LENGTH = 65_535

export function parseZipModes(data: Uint8Array): Record<string, number> {
  const modes: Record<string, number> = {}
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  let eocdOffset = -1
  const scanFloor = Math.max(0, data.byteLength - EOCD_SIZE - MAX_COMMENT_LENGTH)
  for (let offset = data.byteLength - EOCD_SIZE; offset >= scanFloor; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset === -1) return modes

  const entryCount = view.getUint16(eocdOffset + 10, true)
  let cursor = view.getUint32(eocdOffset + 16, true)

  for (let entry = 0; entry < entryCount; entry++) {
    if (cursor + 46 > data.byteLength) break
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) break
    const versionMadeBy = view.getUint16(cursor + 4, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const externalAttributes = view.getUint32(cursor + 38, true)
    const name = new TextDecoder().decode(data.subarray(cursor + 46, cursor + 46 + nameLength))
    if (versionMadeBy >> 8 === 3) {
      const mode = (externalAttributes >>> 16) & 0xffff
      if (mode !== 0) modes[name] = mode
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return modes
}
