import { moveOf } from './layers.js'
import type { ReadCommand } from './reading.js'

const WRITES_OLD_FOLDER = /(?<![$\w{])OLDPWD\b|\$\{OLDPWD:?=/
const NAMES_OLD_FOLDER = /\bOLDPWD\b|~-/
const WRITTEN_WORD = /(?<![$\w{])OLDPWD=(['"]?)([^\s;|&()<>`$'"\\*?[\]{}!]+)\1(?=[\s;|&)]|$)/g

export type OldFolderReturn = { from: number; written: readonly string[] | undefined }

export function oldFolderReturn(commands: ReadonlyArray<Pick<ReadCommand, 'argv' | 'dialect' | 'text'>>, text: string): OldFolderReturn | undefined {
  const writes = WRITES_OLD_FOLDER.test(text)
  if (!writes && !text.includes('~-')) return undefined
  const from = commands.findIndex(turn => {
    if (turn.dialect !== 'posix') return false
    const move = moveOf(turn)
    if (move === undefined) return false
    const target = move.operands[0]
    return target === '-' || (target !== undefined && /^~-(?=\/|$)/.test(target)) || NAMES_OLD_FOLDER.test(turn.text)
  })
  if (from < 0) return undefined
  return { from, written: writes ? [...text.matchAll(WRITTEN_WORD)].map(found => found[2]!) : undefined }
}
