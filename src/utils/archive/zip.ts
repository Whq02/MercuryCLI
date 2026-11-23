import { unzip } from 'fflate'

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 500 * 1024 * 1024
const MAX_FILES = 10_000

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const EOCD_MIN_LEN = 22
const MAX_ZIP_COMMENT_LEN = 65_535

function hasUnsafeEntryPath(entryName: string): boolean {
  if (entryName.includes('\0')) return true
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return true
  if (/^[A-Za-z]:/.test(entryName)) return true
  const segments = entryName.split(/[\\/]/)
  return segments.some(segment => segment === '..')
}

export async function unzipFile(zipData: Buffer): Promise<Record<string, Uint8Array>> {
  const bytes = new Uint8Array(zipData.buffer, zipData.byteOffset, zipData.byteLength)
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let rejection: Error | null = null
    let declaredTotal = 0
    let entryCount = 0

    unzip(
      bytes,
      {
        filter(file) {
          if (rejection !== null) return false
          entryCount += 1
          if (entryCount > MAX_FILES) {
            rejection = new Error(`ZIP archive exceeds maximum entry count (${MAX_FILES})`)
            return false
          }
          if (hasUnsafeEntryPath(file.name)) {
            rejection = new Error(`ZIP archive contains unsafe path: ${file.name}`)
            return false
          }
          if (file.originalSize > MAX_FILE_BYTES) {
            rejection = new Error(`ZIP entry "${file.name}" exceeds maximum size (${MAX_FILE_BYTES} bytes)`)
            return false
          }
          declaredTotal += file.originalSize
          if (declaredTotal > MAX_TOTAL_BYTES) {
            rejection = new Error(`ZIP archive exceeds maximum uncompressed size (${MAX_TOTAL_BYTES} bytes)`)
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
        let actualTotal = 0
        for (const [name, content] of Object.entries(unzipped)) {
          if (hasUnsafeEntryPath(name)) {
            reject(new Error(`ZIP archive contains unsafe path: ${name}`))
            return
          }
          if (content.byteLength > MAX_FILE_BYTES) {
            reject(new Error(`ZIP entry "${name}" exceeds maximum size (${MAX_FILE_BYTES} bytes)`))
            return
          }
          actualTotal += content.byteLength
          if (actualTotal > MAX_TOTAL_BYTES) {
            reject(new Error(`ZIP archive exceeds maximum uncompressed size (${MAX_TOTAL_BYTES} bytes)`))
            return
          }
        }
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

  const cdSize = view.getUint32(eocdOffset + 12, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const cdEnd = Math.min(data.byteLength, cdOffset + cdSize)
  const decoder = new TextDecoder('utf-8')
  let offset = cdOffset

  while (offset + 46 <= cdEnd) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) break
    const versionMadeBy = view.getUint16(offset + 4, true)
    const fileNameLen = view.getUint16(offset + 28, true)
    const extraFieldLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const externalAttrs = view.getUint32(offset + 38, true)
    const nameStart = offset + 46
    const nameEnd = nameStart + fileNameLen
    if (nameEnd > cdEnd) break

    const hostOs = versionMadeBy >>> 8
    if (hostOs === 3 || hostOs === 19) {
      const unixMode = (externalAttrs >>> 16) & 0xffff
      if ((unixMode & 0o777) !== 0) {
        const name = decoder.decode(data.subarray(nameStart, nameEnd))
        modes[name] = unixMode
      }
    }
    offset = nameEnd + extraFieldLen + commentLen
  }

  return modes
}
