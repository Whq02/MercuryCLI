
const DRIVE_PATH = /^[A-Za-z]:\\/
const UNC_PATH = /^\\\\/

export function isBackslashContinuation(value: string, offset: number): boolean {
  if (offset <= 0 || value[offset - 1] !== '\\') return false
  const lineStart = value.lastIndexOf('\n', offset - 1) + 1
  const line = value.slice(lineStart, offset)
  const word = line.slice(line.search(/\S+$/) === -1 ? line.length : line.search(/\S+$/))
  if (DRIVE_PATH.test(word) || UNC_PATH.test(word)) return false
  return !word.slice(0, -1).includes('\\')
}
