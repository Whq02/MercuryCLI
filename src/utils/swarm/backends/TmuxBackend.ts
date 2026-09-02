import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../debug.js'
import { execFileNoThrow } from '../../execFileNoThrow.js'
import { sleep } from '../../sleep.js'
import {
  HIDDEN_SESSION_NAME,
  SWARM_SESSION_NAME,
  SWARM_VIEW_WINDOW_NAME,
  TMUX_COMMAND,
  getSwarmSocketName,
} from '../constants.js'
import { getLeaderPaneId, isInsideTmux, isInsideTmuxSync, isTmuxAvailable } from './detection.js'
import { registerBackendResetter, registerTmuxBackend } from './registry.js'
import type { CreatePaneResult, PaneBackend, PaneId } from './types.js'

/**
 * tmux pane management. Two topologies: with a leader (this process is
 * inside tmux, teammates split the leader's own window over the user's
 * server) and without one (all traffic goes to a private per-process socket
 * so the user's own sessions are untouched and concurrent Mercury instances
 * do not collide).
 */

/**
 * Agent colour → tmux colour (contract data — tmux parses these).
 */
const TMUX_COLOR_MAP: Record<AgentColorName, string> = {
  red: 'red',
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  purple: 'magenta',
  orange: 'colour208',
  pink: 'colour205',
  cyan: 'cyan',
}

// Module-level state (backends are constructed per call; instances share it).
let initialExternalPaneConsumed = false
let cachedLeaderWindowId: string | null = null
// The creation queue is in-flight state and is NOT cleared by the reset.
let paneCreationQueue: Promise<void> = Promise.resolve()

registerBackendResetter(() => {
  initialExternalPaneConsumed = false
  cachedLeaderWindowId = null
})

async function tmux(useSwarmSocket: boolean, args: string[]) {
  const fullArgs = useSwarmSocket ? ['-L', getSwarmSocketName(), ...args] : args
  return execFileNoThrow(TMUX_COMMAND, fullArgs)
}

/**
 * Pane creation is serialised: parallel spawns otherwise interleave their
 * list-panes/split calls and corrupt the layout decision. Each caller waits
 * on the previous creation's completion; the release runs even on a throw.
 */
async function withCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = paneCreationQueue
  let release!: () => void
  paneCreationQueue = new Promise(resolve => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Injection guard: ASCII control characters (≤ 0x1F or 0x7F) act as command
 * separators when fed to a shell. All other Unicode — CJK, emoji, accented
 * Latin — is accepted.
 */
function assertNoControlCharacters(command: string): void {
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(
        `Command contains an ASCII control character (0x${code.toString(16)}) at index ${index} — control characters are rejected because they act as command separators`,
      )
    }
  }
}

/** Always "failed to create teammate pane" + stderr; space errors add the three remedies. */
function formatCreateError(stderr: string): string {
  const base = `Failed to create teammate pane: ${stderr}`
  const lower = stderr.toLowerCase()
  if (lower.includes('no space') || lower.includes('too small')) {
    return `${base}\nThe window has no room for another pane. Try one of: spawn fewer concurrent teammates, enlarge the terminal, or switch to in-process teammates via /config.`
  }
  return base
}

/** The captured TMUX_PANE, with a dynamic query fallback that should never be needed. */
async function getLeaderPane(): Promise<string | null> {
  const captured = getLeaderPaneId()
  if (captured !== null) return captured
  const shown = await tmux(false, ['display-message', '-p', '#{pane_id}'])
  if (shown.code !== 0) return null
  const paneId = shown.stdout.trim()
  return paneId.length > 0 ? paneId : null
}

/**
 * The leader's window, resolved by the STABLE `#{window_id}` of the leader's
 * pane — not a `session:index` pair, whose index drifts when windows are
 * renumbered, moved, or renamed. Cached for the process; a failed query logs
 * and yields null (uncached).
 */
async function getLeaderWindowId(): Promise<string | null> {
  if (cachedLeaderWindowId !== null) return cachedLeaderWindowId
  const leaderPane = await getLeaderPane()
  if (leaderPane === null) return null
  const outcome = await tmux(false, ['display-message', '-t', leaderPane, '-p', '#{window_id}'])
  if (outcome.code !== 0) {
    logForDebugging(`tmux: could not resolve the leader window: ${outcome.stderr}`)
    return null
  }
  const windowId = outcome.stdout.trim()
  if (windowId.length === 0) return null
  cachedLeaderWindowId = windowId
  return windowId
}

async function listPanes(useSwarmSocket: boolean, target: string): Promise<string[] | null> {
  const outcome = await tmux(useSwarmSocket, ['list-panes', '-t', target, '-F', '#{pane_id}'])
  if (outcome.code !== 0) return null
  return outcome.stdout.split('\n').filter(line => line.length > 0)
}

/** The shared later-teammate split rule: parity picks orientation, the middle teammate is the target. */
function pickSplitTarget(teammatePanes: string[]): { target: string; orientation: '-v' | '-h' } {
  const n = teammatePanes.length
  const orientation = n % 2 === 1 ? '-v' : '-h'
  const target =
    teammatePanes[Math.floor((n - 1) / 2)] ?? (teammatePanes[teammatePanes.length - 1] as string)
  return { target, orientation }
}

export class TmuxBackend implements PaneBackend {
  readonly type = 'tmux' as const
  readonly displayName = 'tmux'
  readonly supportsHideShow = true

  async isAvailable(): Promise<boolean> {
    return isTmuxAvailable()
  }

  async isRunningInside(): Promise<boolean> {
    return isInsideTmux()
  }

  async createTeammatePaneInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult> {
    return withCreationLock(async () => {
      const result = isInsideTmuxSync()
        ? await this.createPaneInLeaderWindow(name, color)
        : await this.createPaneInExternalSession(name, color)
      // Shell warm-up: a slow interactive shell (rc files, prompt
      // frameworks) must finish starting so it does not eat the command
      // about to be sent.
      await sleep(200)
      return result
    })
  }

  private async createPaneInLeaderWindow(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult> {
    const leaderPane = await getLeaderPane()
    const windowId = await getLeaderWindowId()
    if (leaderPane === null || windowId === null) {
      throw new Error('Could not determine the current tmux pane/window')
    }
    const panes = await listPanes(false, windowId)
    if (panes === null) {
      throw new Error('Could not count the panes in the current tmux window')
    }
    const isFirstTeammate = panes.length === 1

    let split
    if (isFirstTeammate) {
      // The new pane gets 70% so the leader keeps 30%.
      split = await tmux(false, [
        'split-window',
        '-t',
        leaderPane,
        '-h',
        '-l',
        '70%',
        '-P',
        '-F',
        '#{pane_id}',
      ])
    } else {
      // Drop the first pane (the leader); parity and the middle-teammate
      // index decide the split (risk R11: transcribed faithfully — the
      // intended geometry is documented nowhere; do not "improve" it).
      const { target, orientation } = pickSplitTarget(panes.slice(1))
      split = await tmux(false, ['split-window', '-t', target, orientation, '-P', '-F', '#{pane_id}'])
    }
    if (split.code !== 0) throw new Error(formatCreateError(split.stderr))
    const paneId = split.stdout.trim()

    await this.setPaneBorderColor(paneId, color, false)
    await this.setPaneTitle(paneId, name, color, false)
    await this.rebalancePanes(windowId, true)
    return { paneId, isFirstTeammate }
  }

  private async createPaneInExternalSession(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult> {
    const windowTarget = `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`
    let initialPaneId = ''

    const hasSession = await tmux(true, ['has-session', '-t', SWARM_SESSION_NAME])
    if (hasSession.code !== 0) {
      const created = await tmux(true, [
        'new-session',
        '-d',
        '-s',
        SWARM_SESSION_NAME,
        '-n',
        SWARM_VIEW_WINDOW_NAME,
        '-P',
        '-F',
        '#{pane_id}',
      ])
      if (created.code !== 0) {
        throw new Error(`Failed to create swarm session: ${created.stderr}`)
      }
      initialPaneId = created.stdout.trim()
    } else {
      const windows = await tmux(true, ['list-windows', '-t', SWARM_SESSION_NAME, '-F', '#{window_name}'])
      const windowNames = windows.stdout.split('\n').filter(line => line.length > 0)
      if (windowNames.includes(SWARM_VIEW_WINDOW_NAME)) {
        const panes = await listPanes(true, windowTarget)
        initialPaneId = panes?.[0] ?? ''
      } else {
        const createdWindow = await tmux(true, [
          'new-window',
          '-t',
          SWARM_SESSION_NAME,
          '-n',
          SWARM_VIEW_WINDOW_NAME,
          '-P',
          '-F',
          '#{pane_id}',
        ])
        if (createdWindow.code !== 0) {
          throw new Error(`Failed to create swarm window: ${createdWindow.stderr}`)
        }
        initialPaneId = createdWindow.stdout.trim()
      }
    }

    const panes = await listPanes(true, windowTarget)
    if (panes === null) {
      // Proceeding with an empty list would feed an undefined split target
      // (L3).
      throw new Error('Could not count the panes in the swarm window')
    }
    const isFirstTeammate = !initialExternalPaneConsumed && panes.length === 1

    let paneId: string
    if (isFirstTeammate) {
      // Reuse the initial pane — at most once per process.
      paneId = initialPaneId
      initialExternalPaneConsumed = true
      await this.enablePaneBorderStatus(windowTarget, true)
    } else {
      // No leader pane to skip: ALL panes participate in the parity rule.
      const { target, orientation } = pickSplitTarget(panes)
      const split = await tmux(true, ['split-window', '-t', target, orientation, '-P', '-F', '#{pane_id}'])
      if (split.code !== 0) throw new Error(formatCreateError(split.stderr))
      paneId = split.stdout.trim()
    }

    await this.setPaneBorderColor(paneId, color, true)
    await this.setPaneTitle(paneId, name, color, true)
    await this.rebalancePanes(windowTarget, false)
    return { paneId, isFirstTeammate }
  }

  async sendCommandToPane(paneId: PaneId, command: string, useExternalSession = false): Promise<void> {
    try {
      assertNoControlCharacters(command)
    } catch (error) {
      logForDebugging(`tmux pane ${paneId}: rejected a command containing a control character`)
      throw error
    }
    // Literal mode so the text can never be interpreted as tmux key names;
    // Enter is delivered as a SEPARATE call.
    const literal = await tmux(useExternalSession, ['send-keys', '-t', paneId, '-l', '--', command])
    if (literal.code !== 0) {
      throw new Error(`Failed to send command to pane ${paneId}: ${literal.stderr}`)
    }
    const enter = await tmux(useExternalSession, ['send-keys', '-t', paneId, 'Enter'])
    if (enter.code !== 0) {
      throw new Error(`Failed to send Enter to pane ${paneId}: ${enter.stderr}`)
    }
  }

  /** Three calls, none of whose exit codes are checked (pane-scoped options need tmux 3.2+). */
  async setPaneBorderColor(paneId: PaneId, color: AgentColorName, useExternalSession = false): Promise<void> {
    const tmuxColor = TMUX_COLOR_MAP[color] ?? color
    await tmux(useExternalSession, ['select-pane', '-t', paneId, '-P', `bg=default,fg=${tmuxColor}`])
    await tmux(useExternalSession, ['set-option', '-p', '-t', paneId, 'pane-border-style', `fg=${tmuxColor}`])
    await tmux(useExternalSession, [
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-active-border-style',
      `fg=${tmuxColor}`,
    ])
  }

  async setPaneTitle(
    paneId: PaneId,
    name: string,
    color: AgentColorName,
    useExternalSession = false,
  ): Promise<void> {
    const tmuxColor = TMUX_COLOR_MAP[color] ?? color
    await tmux(useExternalSession, ['select-pane', '-t', paneId, '-T', name])
    await tmux(useExternalSession, [
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-border-format',
      `#[fg=${tmuxColor},bold] #{pane_title} #[default]`,
    ])
  }

  /** A window option; with no target the leader's window; unknown window ⇒ silent no-op. */
  async enablePaneBorderStatus(windowTarget?: string, useExternalSession = false): Promise<void> {
    const target = windowTarget ?? (await getLeaderWindowId())
    if (target === null || target === undefined) return
    await tmux(useExternalSession, ['set-option', '-w', '-t', target, 'pane-border-status', 'top'])
  }

  async rebalancePanes(windowTarget: string, hasLeader: boolean): Promise<void> {
    if (hasLeader) {
      const panes = await listPanes(false, windowTarget)
      if (panes === null || panes.length <= 2) return
      await tmux(false, ['select-layout', '-t', windowTarget, 'main-vertical'])
      await tmux(false, ['resize-pane', '-t', panes[0] as string, '-x', '30%'])
    } else {
      const panes = await listPanes(true, windowTarget)
      if (panes === null || panes.length <= 1) return
      await tmux(true, ['select-layout', '-t', windowTarget, 'tiled'])
    }
  }

  async killPane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
    const outcome = await tmux(useExternalSession, ['kill-pane', '-t', paneId])
    return outcome.code === 0
  }

  /**
   * Break the pane out into a detached holding session — the teammate keeps
   * running; it is just not visible. The session creation is fire-and-forget
   * (an existing session is harmless).
   */
  async hidePane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
    await tmux(useExternalSession, ['new-session', '-d', '-s', HIDDEN_SESSION_NAME])
    const broke = await tmux(useExternalSession, ['break-pane', '-d', '-s', paneId, '-t', HIDDEN_SESSION_NAME])
    if (broke.code === 0) {
      logForDebugging(`tmux: hid pane ${paneId} in ${HIDDEN_SESSION_NAME}`)
      return true
    }
    logForDebugging(`tmux: failed to hide pane ${paneId}: ${broke.stderr}`)
    return false
  }

  async showPane(paneId: PaneId, targetWindowOrPane: string, useExternalSession = false): Promise<boolean> {
    const joined = await tmux(useExternalSession, ['join-pane', '-h', '-s', paneId, '-t', targetWindowOrPane])
    if (joined.code !== 0) {
      logForDebugging(`tmux: failed to show pane ${paneId}: ${joined.stderr}`)
      return false
    }
    await tmux(useExternalSession, ['select-layout', '-t', targetWindowOrPane, 'main-vertical'])
    const panes = await listPanes(useExternalSession, targetWindowOrPane)
    const first = panes?.[0]
    if (first !== undefined) {
      await tmux(useExternalSession, ['resize-pane', '-t', first, '-x', '30%'])
    }
    return true
  }
}

registerTmuxBackend(TmuxBackend)
