
export const BINARY_EXTENSIONS: Set<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.z', '.tgz', '.iso',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.lib', '.app', '.msi', '.deb', '.rpm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear', '.node', '.wasm', '.rlib',
  '.sqlite', '.sqlite3', '.db', '.mdb', '.idx',
  '.psd', '.ai', '.eps', '.sketch', '.fig', '.xd', '.blend', '.3ds', '.max',
  '.swf', '.fla',
  '.lockb', '.dat', '.data',
])

export function hasBinaryExtension(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1) return false
  const extension = filePath.slice(dotIndex).toLowerCase()
  return BINARY_EXTENSIONS.has(extension)
}

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
