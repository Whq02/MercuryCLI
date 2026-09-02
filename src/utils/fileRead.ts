import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

/**
 * Dependency-light synchronous file read returning content, encoding and
 * line-ending style. The general file module participates in a large
 * import cycle, so anything that merely needs a synchronous read must not
 * drag in the configuration/message/tool chain — this module stays on the
 * filesystem facade and a debug logger only.
 */

export type LineEndingType = 'CRLF' | 'LF'

const SNIFF_BYTES = 4096

/**
 * Encoding from the first 4096 bytes of an already-resolved path: zero bytes
 * → UTF-8 (an empty file must not be classified as ASCII — that corrupted
 * later multi-byte writes); a UTF-16LE BOM → UTF-16LE; a UTF-8 BOM → UTF-8;
 * anything else → UTF-8 (every ASCII file decodes correctly under it).
 */
export function detectEncodingForResolvedPath(resolvedPath: string): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, { length: SNIFF_BYTES })
  if (bytesRead === 0) return 'utf8'
  if (bytesRead >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  if (bytesRead >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf8'
  return 'utf8'
}

/** CRLF only when CRLF strictly outnumbers bare LF; otherwise LF. */
export function detectLineEndingsForString(content: string): LineEndingType {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++
      else lf++
    }
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * The one-pass read: resolve safely (logging a symlink traversal), detect
 * the encoding, read, and return the CRLF-normalised content, the RAW
 * decoded string (a "did this write change anything" test must see exactly
 * the string a write would emit), the encoding, and the line-ending style
 * computed from the first 4096 code units of the raw string.
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string
  rawContent: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  /** Whether re-encoding the decoded string reproduces the on-disk bytes.
   *  False for a legacy ANSI/cp1252 file, UTF-16BE, or torn UTF-8: the
   *  decode holds U+FFFD where bytes were, so a write-back would destroy
   *  content the caller never touched (TASK-017 supplement, S1) — write
   *  doors must refuse on false. */
  losslessDecode: boolean
} {
  const fsImpl = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, filePath)
  if (isSymlink) {
    logForDebugging(`fileRead: reading ${filePath} through symlink at ${resolvedPath}`)
  }
  const encoding = detectEncodingForResolvedPath(resolvedPath)
  const bytes = fsImpl.readFileBytesSync(resolvedPath)
  const rawContent = bytes.toString(encoding)
  const losslessDecode = Buffer.from(rawContent, encoding).equals(bytes)
  const lineEndings = detectLineEndingsForString(rawContent.slice(0, SNIFF_BYTES))
  return {
    content: rawContent.replaceAll('\r\n', '\n'),
    rawContent,
    encoding,
    lineEndings,
    losslessDecode,
  }
}

/** The normalised content only. */
export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
