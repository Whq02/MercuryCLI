// The shared memory-path display helper: a path renders as the SHORTER of
// its home-relative (~/…) and cwd-relative (./…) forms, falling back to the
// absolute path when neither prefix applies.
//
// There is no "memory updated in <path>" notification component here —
// nothing calls one; the helper is
// the file's one live export (/memory imports it).

import { sep } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { toTildePath } from '../../utils/path.js'

export function getRelativeMemoryPath(filePath: string): string {
  const candidates: string[] = []

  const tilde = toTildePath(filePath)
  if (tilde !== filePath) candidates.push(tilde)

  const cwd = getCwd()
  if (filePath === cwd) {
    candidates.push('.')
  } else if (filePath.startsWith(cwd + sep)) {
    candidates.push(`.${filePath.slice(cwd.length)}`)
  }

  if (candidates.length === 0) return filePath
  candidates.sort((a, b) => a.length - b.length)
  return candidates[0]!
}
