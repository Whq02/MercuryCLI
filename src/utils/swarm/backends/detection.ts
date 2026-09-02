import { env } from '../../env.js'
import { execFileNoThrow } from '../../execFileNoThrow.js'
import { TMUX_COMMAND } from '../constants.js'

/**
 * Environment detection for the pane backends.
 *
 * `TMUX` and `TMUX_PANE` are captured ONCE at module load, before anything
 * can mutate them: Mercury's persistent-shell subsystem overwrites `TMUX`
 * later with its own socket (a late read would misreport), and capturing
 * `TMUX_PANE` at load keeps the lead's ORIGINAL pane known even after the
 * user moves focus to another pane.
 */
const capturedTmux = process.env.TMUX
const capturedTmuxPane = process.env.TMUX_PANE

let insideTmuxMemo: boolean | null = null
let insideITerm2Memo: boolean | null = null

/**
 * Inside tmux iff the captured TMUX value is non-empty. Asking a tmux server
 * anything at all is forbidden here: a server responds while it is up
 * regardless of whether THIS process is attached, so a probe would report
 * true for a plain terminal on a machine that merely has a session running
 * somewhere. Recomputes from the captured value (which cannot change).
 */
export function isInsideTmuxSync(): boolean {
  return typeof capturedTmux === 'string' && capturedTmux.length > 0
}

/** The async accessor memoises its answer for the process lifetime. */
export async function isInsideTmux(): Promise<boolean> {
  if (insideTmuxMemo === null) insideTmuxMemo = isInsideTmuxSync()
  return insideTmuxMemo
}

/** The captured TMUX_PANE, or null — falsy semantics: an empty string is no pane (L3). */
export function getLeaderPaneId(): string | null {
  return capturedTmuxPane || null
}

/**
 * `TMUX` has the form `socket,pid,session`; the socket is the first
 * comma-separated segment. This is a socket PATH, addressed with `-S`, not
 * the name-form `-L` used for the private swarm socket.
 */
export function getUserTmuxSocket(): string | null {
  if (!isInsideTmuxSync() || capturedTmux === undefined) return null
  const socket = capturedTmux.split(',')[0]
  return socket !== undefined && socket.length > 0 ? socket : null
}

/**
 * List the user's own tmux sessions. Runs during init, so the process cwd is
 * deliberately NOT resolved (resolving it would re-enter the
 * persistent-shell subsystem).
 */
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

/** Not cached — every call runs the probe. */
export async function isTmuxAvailable(): Promise<boolean> {
  return (await execFileNoThrow(TMUX_COMMAND, ['-V'])).code === 0
}

/**
 * Inside iTerm2 when any of: TERM_PROGRAM is iTerm.app, ITERM_SESSION_ID is
 * set, or the shared terminal-detection utility reports iTerm.app. Read live
 * on the first call, then memoised for the process lifetime.
 */
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

/**
 * it2 reachability: list sessions and require exit 0. A version probe must
 * not be used — it reports success on an installed CLI whose iTerm2 Python
 * API is switched off, and the split would then fail later with no fallback
 * path left. (The setup module's same-named export answers a DIFFERENT
 * question — binary presence on PATH — and the two must stay distinct;
 * risk R1.)
 */
export async function isIt2CliAvailable(): Promise<boolean> {
  return (await execFileNoThrow(IT2_COMMAND, ['session', 'list'])).code === 0
}

/** Tests only: clears the inside-tmux and inside-iTerm2 memos. */
export function resetDetectionCache(): void {
  insideTmuxMemo = null
  insideITerm2Memo = null
}
