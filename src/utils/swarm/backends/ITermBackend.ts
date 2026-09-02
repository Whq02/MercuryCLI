import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../debug.js'
import { execFileNoThrow } from '../../execFileNoThrow.js'
import { IT2_COMMAND, isInITerm2, isIt2CliAvailable } from './detection.js'
import { registerITermBackend } from './registry.js'
import type { CreatePaneResult, PaneBackend, PaneId } from './types.js'

/**
 * iTerm2 pane management via the `it2` CLI. The leader occupies the left;
 * teammates stack on the right.
 *
 * This backend deliberately registers NO module-state resetter (risk R3,
 * reproduced as shipped): after a detection reset the tracked session ids
 * and the first-pane flag survive.
 */

// Whether this is the first teammate is decided by this flag, not by the
// tracked-id list.
let iTermFirstTeammateCreated = false
let trackedSessionIds: string[] = []
let paneCreationQueue: Promise<void> = Promise.resolve()

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

/**
 * The leader session id: the portion of ITERM_SESSION_ID after the first
 * colon (the variable has the shape `wXtYpZ:UUID`); no colon ⇒ no id.
 */
function getLeaderSessionId(): string | null {
  const raw = process.env.ITERM_SESSION_ID
  if (raw === undefined) return null
  const colonIndex = raw.indexOf(':')
  if (colonIndex === -1) return null
  return raw.slice(colonIndex + 1)
}

/** The split's stdout reports `Created new pane: <id>` (the CLI's contract). */
function parseCreatedPaneId(stdout: string): string {
  const label = 'Created new pane: '
  const index = stdout.indexOf(label)
  if (index === -1) {
    throw new Error(`Could not parse the it2 split output: ${stdout}`)
  }
  return stdout.slice(index + label.length).trim()
}



export class ITermBackend implements PaneBackend {
  readonly type = 'iterm2' as const
  readonly displayName = 'iTerm2'
  readonly supportsHideShow = false

  /** Requires both: running inside iTerm2 and the it2 CLI reachable (the listing probe). */
  async isAvailable(): Promise<boolean> {
    return isInITerm2() && (await isIt2CliAvailable())
  }

  async isRunningInside(): Promise<boolean> {
    return isInITerm2()
  }

  async createTeammatePaneInSwarmView(
    _name: string,
    _color: AgentColorName,
  ): Promise<CreatePaneResult> {
    return withCreationLock(async () => {
      // Dead-target recovery: only when the session LISTING succeeds and
      // omits the target may an id be pruned and the split retried (the
      // user may have closed the pane); a still-listed target or a failed
      // listing (Python API off, it2 removed, transient socket error)
      // surfaces the split error unchanged — pruning on a
      // non-target-specific failure would empty the list of perfectly live
      // sessions. Bounded: each retry removes exactly one id, and when the
      // list empties the loop RE-ENTERS the first-teammate arm — a
      // leader-targeted vertical split reported as the first teammate, not
      // an untargeted default-orientation split with the stale pre-recovery
      // flag (L3).
      for (;;) {
        if (!iTermFirstTeammateCreated) {
          // A VERTICAL split of the leader's session; with no leader id the
          // split has no target and iTerm2 applies it to the active
          // session. A first-teammate split never enters recovery.
          const leaderId = getLeaderSessionId()
          const args =
            leaderId !== null
              ? ['session', 'split', '-v', '-s', leaderId]
              : ['session', 'split', '-v']
          const outcome = await execFileNoThrow(IT2_COMMAND, args)
          if (outcome.code !== 0) {
            throw new Error(`Failed to create iTerm2 pane: ${outcome.stderr}`)
          }
          const paneId = parseCreatedPaneId(outcome.stdout)
          iTermFirstTeammateCreated = true
          trackedSessionIds.push(paneId)
          // Creation deliberately applies no colour and no title (see the
          // no-ops below).
          return { paneId, isFirstTeammate: true }
        }

        // Later teammates split from the most recently created teammate
        // session with NO orientation flag (the CLI's default), which keeps
        // the layout correct even if the user clicks into another pane;
        // with no tracked id, split the active session.
        const target = trackedSessionIds[trackedSessionIds.length - 1]
        const args =
          target !== undefined && target !== ''
            ? ['session', 'split', '-s', target]
            : ['session', 'split']
        const outcome = await execFileNoThrow(IT2_COMMAND, args)
        if (outcome.code === 0) {
          const paneId = parseCreatedPaneId(outcome.stdout)
          trackedSessionIds.push(paneId)
          return { paneId, isFirstTeammate: false }
        }
        if (target === undefined || target === '') {
          throw new Error(`Failed to create iTerm2 pane: ${outcome.stderr}`)
        }
        const listing = await execFileNoThrow(IT2_COMMAND, ['session', 'list'])
        if (listing.code !== 0 || listing.stdout.includes(target)) {
          throw new Error(`Failed to create iTerm2 pane: ${outcome.stderr}`)
        }
        trackedSessionIds = trackedSessionIds.filter(id => id !== target)
        if (trackedSessionIds.length === 0) {
          iTermFirstTeammateCreated = false
        }
      }
    })
  }

  async sendCommandToPane(paneId: PaneId, command: string, _useExternalSession = false): Promise<void> {
    try {
      assertNoControlCharacters(command)
    } catch (error) {
      logForDebugging(`iTerm2 pane ${paneId}: rejected a command containing a control character`)
      throw error
    }
    const args =
      paneId !== '' ? ['session', 'run', '-s', paneId, command] : ['session', 'run', command]
    const outcome = await execFileNoThrow(IT2_COMMAND, args)
    if (outcome.code !== 0) {
      throw new Error(`Failed to send command to iTerm2 pane ${paneId}: ${outcome.stderr}`)
    }
  }

  // Border colour, title, border status and rebalancing are deliberate
  // no-ops: every it2 invocation costs a Python interpreter start and an API
  // round trip, the panes work without the cosmetics, and iTerm2 already
  // labels panes in its tabs. Only the rebalance no-op logs.
  async setPaneBorderColor(_paneId: PaneId, _color: AgentColorName, _useExternalSession = false): Promise<void> {}

  async setPaneTitle(
    _paneId: PaneId,
    _name: string,
    _color: AgentColorName,
    _useExternalSession = false,
  ): Promise<void> {}

  async enablePaneBorderStatus(_windowTarget?: string, _useExternalSession = false): Promise<void> {}

  async rebalancePanes(_windowTarget: string, _hasLeader: boolean): Promise<void> {
    logForDebugging('iTerm2: pane rebalancing is a no-op')
  }

  /**
   * Force is required: unforced, the close is subject to iTerm2's "confirm
   * before closing" preference, and a session always has at least a shell
   * running, so the close either raises a dialog or is declined. Tracked
   * state is pruned regardless of the close result — an already-gone pane
   * should still lose its stale id.
   */
  async killPane(paneId: PaneId, _useExternalSession = false): Promise<boolean> {
    const outcome = await execFileNoThrow(IT2_COMMAND, ['session', 'close', '-f', '-s', paneId])
    trackedSessionIds = trackedSessionIds.filter(id => id !== paneId)
    if (trackedSessionIds.length === 0) {
      iTermFirstTeammateCreated = false
    }
    return outcome.code === 0
  }

  async hidePane(paneId: PaneId, _useExternalSession = false): Promise<boolean> {
    logForDebugging(`iTerm2: hide is unsupported (pane ${paneId})`)
    return false
  }

  async showPane(paneId: PaneId, _targetWindowOrPane: string, _useExternalSession = false): Promise<boolean> {
    logForDebugging(`iTerm2: show is unsupported (pane ${paneId})`)
    return false
  }
}

registerITermBackend(ITermBackend)
