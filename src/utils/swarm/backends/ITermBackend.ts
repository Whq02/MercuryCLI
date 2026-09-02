import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../debug.js'
import { execFileNoThrow } from '../../execFileNoThrow.js'
import { IT2_COMMAND, isInITerm2, isIt2CliAvailable } from './detection.js'
import { registerITermBackend } from './registry.js'
import type { CreatePaneResult, PaneBackend, PaneId } from './types.js'


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

function getLeaderSessionId(): string | null {
  const raw = process.env.ITERM_SESSION_ID
  if (raw === undefined) return null
  const colonIndex = raw.indexOf(':')
  if (colonIndex === -1) return null
  return raw.slice(colonIndex + 1)
}

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
      for (;;) {
        if (!iTermFirstTeammateCreated) {
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
          return { paneId, isFirstTeammate: true }
        }

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
