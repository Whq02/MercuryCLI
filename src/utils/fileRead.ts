import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'


export type LineEndingType = 'CRLF' | 'LF'

const SNIFF_BYTES = 4096

export function detectEncodingForResolvedPath(resolvedPath: string): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, { length: SNIFF_BYTES })
  if (bytesRead === 0) return 'utf8'
  if (bytesRead >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  if (bytesRead >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf8'
  return 'utf8'
}

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

export function readFileSyncWithMetadata(filePath: string): {
  content: string
  rawContent: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
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

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
