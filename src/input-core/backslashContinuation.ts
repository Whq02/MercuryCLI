// The backslash-return idiom's ONE predicate: does ↵ after a trailing `\`
// mean "continue on the next line" (the documented fallback for terminals
// with no shift+↵) or is that `\` the last character of a Windows path?
//
// `C:\Users\` + ↵ used to eat the separator and insert a newline — the
// operator had to press ↵ twice and the path went out broken. A trailing
// backslash is a continuation only when the word it ends is not already a
// backslash path: a drive root (`C:\…`), a UNC root (`\\server\…`), or a
// word carrying an earlier backslash separator (`.\build\`, `src\lib\`).
// Prose and shell-style continuation (`text\`, `word \`) keep the idiom.

const DRIVE_PATH = /^[A-Za-z]:\\/
const UNC_PATH = /^\\\\/

/** True when the character before `offset` is a backslash that continues
 *  the line (the idiom applies); false when there is no trailing backslash
 *  or the backslash ends a Windows path (↵ submits, the separator stays). */
export function isBackslashContinuation(value: string, offset: number): boolean {
  if (offset <= 0 || value[offset - 1] !== '\\') return false
  const lineStart = value.lastIndexOf('\n', offset - 1) + 1
  const line = value.slice(lineStart, offset)
  const word = line.slice(line.search(/\S+$/) === -1 ? line.length : line.search(/\S+$/))
  if (DRIVE_PATH.test(word) || UNC_PATH.test(word)) return false
  // An earlier backslash in the same word makes the trailing one a separator.
  return !word.slice(0, -1).includes('\\')
}
