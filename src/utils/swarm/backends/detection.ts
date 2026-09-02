import { env } from '../../env.js'
import { execFileNoThrow } from '../../execFileNoThrow.js'
import { TMUX_COMMAND } from '../constants.js'

const capturedTmux = process.env.TMUX
const capturedTmuxPane = process.env.TMUX_PANE

let insideTmuxMemo: boolean | null = null
let insideITerm2Memo: boolean | null = null

export function isInsideTmuxSync(): boolean {
  return typeof capturedTmux === 'string' && capturedTmux.length > 0
}

export async function isInsideTmux(): Promise<boolean> {
  if (insideTmuxMemo === null) insideTmuxMemo = isInsideTmuxSync()
  return insideTmuxMemo
}

export function getLeaderPaneId(): string | null {
  return capturedTmuxPane || null
}

export function getUserTmuxSocket(): string | null {
  if (!isInsideTmuxSync() || capturedTmux === undefined) return null
  const socket = capturedTmux.split(',')[0]
  return socket !== undefined && socket.length > 0 ? socket : null
}

export async function listUserTmuxSessions(): Promise<string[] | undefined> {
  if (!isInsideTmuxSync()) return undefined
  const socket = getUserTmuxSocket()
  if (socket === null) return undefined
  const outcome = await execFileNoThrow(
    TMUX_COMMAND,
    ['-S', socket, 'list-sessions', '-F', '#{session_name}'],
    { timeout: 2000, useCwd: false },
  )
  if (outcome.code !== 0) return undefined
  return outcome.stdout.split('\n').filter(line => line.length > 0)
}

export async function isTmuxAvailable(): Promise<boolean> {
  return (await execFileNoThrow(TMUX_COMMAND, ['-V'])).code === 0
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

export const IT2_COMMAND = 'it2'

export async function isIt2CliAvailable(): Promise<boolean> {
  return (await execFileNoThrow(IT2_COMMAND, ['session', 'list'])).code === 0
}

export function resetDetectionCache(): void {
  insideTmuxMemo = null
  insideITerm2Memo = null
}
