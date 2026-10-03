import { env } from '../../env.js'

const capturedTmux = process.env.TMUX

let insideITerm2Memo: boolean | null = null

export function isInsideTmuxSync(): boolean {
  return typeof capturedTmux === 'string' && capturedTmux.length > 0
}

export function isInITerm2(): boolean {
  if (insideITerm2Memo === null) {
    insideITerm2Memo =
      process.env.TERM_PROGRAM === 'iTerm.app' ||
      Boolean(process.env.ITERM_SESSION_ID) ||
      env.terminal === 'iTerm.app'
  }
  return insideITerm2Memo
}
