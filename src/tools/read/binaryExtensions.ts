const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mpeg', 'mpg',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'aiff', 'opus',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz', 'z', 'tgz', 'iso',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'obj', 'lib', 'app', 'msi', 'deb', 'rpm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'pyc', 'pyo', 'class', 'jar', 'war', 'ear', 'node', 'wasm', 'rlib',
  'sqlite', 'sqlite3', 'db', 'mdb', 'idx',
  'psd', 'ai', 'eps', 'sketch', 'fig', 'xd', 'blend', '3ds', 'max', 'swf', 'fla', 'lockb', 'dat', 'data',
])

export function hasBinaryExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return false
  return BINARY_EXTENSIONS.has(filePath.slice(dot + 1).toLowerCase())
}
