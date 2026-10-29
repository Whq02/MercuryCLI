
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
