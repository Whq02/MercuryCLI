import { getSessionId } from '../../../bootstrap/state.js'
import type { ToolUseContext } from '../../../Tool.js'
import { formatAgentId, parseAgentId } from '../../agentId.js'
import { quote } from '../../bash/shellQuote.js'
import { registerCleanup } from '../../cleanupRegistry.js'
import { logForDebugging } from '../../debug.js'
import { errorMessage } from '../../errors.js'
import { logError } from '../../log.js'
import { enforceSubagentModelFloor } from '../../model/modelFloor.js'
import { createShutdownRequestMessage, writeToMailbox } from '../../teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import { buildInheritedCliFlags, buildInheritedEnvVars, getTeammateCommand } from '../spawnUtils.js'
import { assignTeammateColor } from '../teammateLayoutManager.js'
import { isInsideTmuxSync } from './detection.js'
import type {
  BackendType,
  PaneBackend,
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
} from './types.js'

/**
 * Adapts a pane backend to the common teammate-executor contract:
 * child-process command composition, mailbox messaging, kill/terminate,
 * record-based liveness.
 */

type SpawnRecord = { paneId: string; insideTmux: boolean }

export class PaneBackendExecutor implements TeammateExecutor {
  readonly type: BackendType
  private readonly backend: PaneBackend
  private context: ToolUseContext | null = null
  private readonly spawnRecords = new Map<string, SpawnRecord>()
  private exitCleanupRegistered = false

  constructor(backend: PaneBackend) {
    this.backend = backend
    this.type = backend.type
  }

  /** Must be called before spawn. */
  setContext(toolUseContext: ToolUseContext): void {
    this.context = toolUseContext
  }

  async isAvailable(): Promise<boolean> {
    return this.backend.isAvailable()
  }

  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    const agentId = formatAgentId(config.name, config.teamName)
    if (this.context === null) {
      logForDebugging(`pane executor: spawn of ${agentId} attempted before initialisation`)
      return {
        success: false,
        agentId,
        error: 'Pane executor was not initialised — call setContext() before spawn()',
      }
    }
    try {
      const color = config.color ?? assignTeammateColor(agentId)
      const { paneId, isFirstTeammate } = await this.backend.createTeammatePaneInSwarmView(
        config.name,
        color,
      )
      const insideTmux = isInsideTmuxSync()
      if (isFirstTeammate && insideTmux) {
        await this.backend.enablePaneBorderStatus()
      }

      // Identity flags, in this order (contract data — the child parses
      // these); each value shell-quoted, empty entries dropped.
      const identityFlags = [
        `--agent-id ${quote([agentId])}`,
        `--agent-name ${quote([config.name])}`,
        `--team-name ${quote([config.teamName])}`,
        color ? `--agent-color ${quote([color])}` : '',
        `--parent-session-id ${quote([config.parentSessionId || String(getSessionId())])}`,
        config.planModeRequired ? '--plan-mode-required' : '',
      ].filter(flag => flag.length > 0)

      const permissionMode = this.context.getAppState().toolPermissionContext.mode
      let inheritedFlags = buildInheritedCliFlags({
        planModeRequired: config.planModeRequired ?? false,
        permissionMode,
      })
      if (config.model) {
        // A per-teammate model REPLACES any inherited --model flag rather
        // than appending a second one: drop the flag token and the token
        // after it, then append the replacement — floored through the shared
        // subagent model floor (a teammate can never be dispatched below it).
        const tokens = inheritedFlags.split(' ')
        const modelIndex = tokens.indexOf('--model')
        if (modelIndex !== -1) tokens.splice(modelIndex, 2)
        const floored = enforceSubagentModelFloor(config.model, 'paneTeammateSpawn')
        inheritedFlags = `${tokens.join(' ')} --model ${quote([floored])}`.trim()
      }

      const command = `cd ${quote([config.cwd])} && env ${buildInheritedEnvVars()} ${quote([getTeammateCommand()])} ${identityFlags.join(' ')}${inheritedFlags.length > 0 ? ` ${inheritedFlags}` : ''}`
      // The external-socket flag is set when we are NOT inside tmux.
      await this.backend.sendCommandToPane(paneId, command, !insideTmux)

      this.spawnRecords.set(agentId, { paneId, insideTmux })
      if (!this.exitCleanupRegistered) {
        // Without this, a lead that dies on a hangup leaves live teammate
        // panes behind with nothing owning them. Registered once.
        this.exitCleanupRegistered = true
        registerCleanup(async () => {
          for (const record of this.spawnRecords.values()) {
            await this.backend.killPane(record.paneId, !record.insideTmux)
          }
          this.spawnRecords.clear()
        })
      }

      // The prompt is delivered by mailbox, not on the command line.
      await writeToMailbox(
        config.name,
        { from: TEAM_LEAD_NAME, text: config.prompt, timestamp: new Date().toISOString() },
        config.teamName,
      )
      return { success: true, agentId, paneId }
    } catch (error) {
      logError(error)
      return { success: false, agentId, error: errorMessage(error) }
    }
  }

  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    const parsed = parseAgentId(agentId)
    if (parsed === null) {
      throw new Error(`Invalid agent id "${agentId}" — expected the form name@team`)
    }
    // The pane-teammate write carries no summary member (L3).
    await writeToMailbox(
      parsed.agentName,
      {
        text: message.text,
        from: message.from,
        ...(message.color !== undefined ? { color: message.color } : {}),
        timestamp: message.timestamp ?? new Date().toISOString(),
      },
      parsed.teamName,
    )
  }

  /**
   * Graceful: a shutdown-request payload into the teammate's mailbox (the
   * teammate side recognises it by its type discriminator). Returns true
   * unconditionally after the write — the teammate process decides whether
   * to honour it.
   */
  async terminate(agentId: string, reason?: string): Promise<boolean> {
    const parsed = parseAgentId(agentId)
    if (parsed === null) {
      logForDebugging(`pane executor: cannot terminate invalid agent id ${agentId}`)
      return false
    }
    const request = createShutdownRequestMessage({
      requestId: `shutdown-${agentId}-${Date.now()}`,
      from: TEAM_LEAD_NAME,
      ...(reason !== undefined ? { reason } : {}),
    })
    await writeToMailbox(
      parsed.agentName,
      { from: TEAM_LEAD_NAME, text: JSON.stringify(request), timestamp: new Date().toISOString() },
      parsed.teamName,
    )
    return true
  }

  /**
   * Forceful. The record is pruned REGARDLESS of the kill result — a failed
   * close (pane already gone, socket error) must not leave an entry that can
   * never be cleaned up.
   */
  async kill(agentId: string): Promise<boolean> {
    const record = this.spawnRecords.get(agentId)
    if (record === undefined) {
      logForDebugging(`pane executor: no spawn record for ${agentId}`)
      return false
    }
    const killed = await this.backend.killPane(record.paneId, !record.insideTmux)
    this.spawnRecords.delete(agentId)
    return killed
  }

  async isActive(agentId: string): Promise<boolean> {
    const record = this.spawnRecords.get(agentId)
    if (record === undefined) return false
    if (this.backend.isPaneAlive) {
      return this.backend.isPaneAlive(record.paneId, !record.insideTmux)
    }
    // No probe: we hold a record, assume alive.
    return true
  }
}

export function createPaneBackendExecutor(backend: PaneBackend): PaneBackendExecutor {
  return new PaneBackendExecutor(backend)
}
