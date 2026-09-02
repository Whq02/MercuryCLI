// ============================================================================
//  src/constants/files.ts — the binary-extension table plus extension and
//  content binary detection. Set membership is contract data — a divergence
//  changes which files the diff, read and search paths treat as text.
// ============================================================================

export const BINARY_EXTENSIONS: Set<string> = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  // Video
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.z', '.tgz', '.iso',
  // Executables / libraries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.lib', '.app', '.msi', '.deb', '.rpm',
  // Documents — .pdf is deliberately here; the file-read tool excludes it
  // again at its own call site.
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Bytecode / VM artifacts
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear', '.node', '.wasm', '.rlib',
  // Databases
  '.sqlite', '.sqlite3', '.db', '.mdb', '.idx',
  // Design / 3D
  '.psd', '.ai', '.eps', '.sketch', '.fig', '.xd', '.blend', '.3ds', '.max',
  // Flash
  '.swf', '.fla',
  // Lock / profiling data
  '.lockb', '.dat', '.data',
])

/**
 * Extension check: everything from the last dot to the end, lowercased,
 * tested for membership. A dotless name is never binary-by-extension (the
 * old slice(-1) tested the LAST CHARACTER — not the whole name its docs
 * claimed — and could never match the dotted members either way, FC-091).
 */
export function hasBinaryExtension(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1) return false
  const extension = filePath.slice(dotIndex).toLowerCase()
  return BINARY_EXTENSIONS.has(extension)
}

/**
 * Content check over the first 8192 bytes (or the whole buffer if smaller):
 * true immediately on a NUL byte; otherwise true when the fraction of bytes
 * below 32 that are not tab (9), newline (10) or carriage return (13) is
 * strictly greater than 0.1. An empty buffer divides zero by zero — the
 * NaN comparison is false, which is the desired "not binary" answer, made
 * explicit here rather than left accidental.
 */
export function isBinaryContent(buffer: Uint8Array): boolean {
  const checkSize = Math.min(buffer.length, 8192)
  if (checkSize === 0) return false
  let suspicious = 0
  for (let index = 0; index < checkSize; index++) {
    const byte = buffer[index]!
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) suspicious++
  }
  return suspicious / checkSize > 0.1
}
