import { env } from './env.js'
import { hostEnv } from './hostEnv.js'

const capturedTmux = hostEnv().TMUX

let insideITerm2Memo: boolean | null = null

export function isInsideTmuxSync(): boolean {
  return typeof capturedTmux === 'string' && capturedTmux.length > 0
}

export function isInITerm2(): boolean {
  if (insideITerm2Memo === null) {
    insideITerm2Memo =
      hostEnv().TERM_PROGRAM === 'iTerm.app' ||
      Boolean(hostEnv().ITERM_SESSION_ID) ||
      env.terminal === 'iTerm.app'
  }
  return insideITerm2Memo
}
