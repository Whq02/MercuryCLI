import { randomUUID } from 'node:crypto'
import { SESSION_VERBS } from '../../../daemon/runner-wire/sessionVerbs.js'
import type { SessionKitEditV1 } from '../../../daemon/session-seat/sessionKit.js'
import type { PermissionMode } from '../../../permissions/rules/permissions.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { mcpToolsOfReply } from '../../../integrations/mcp/toolsAnswer.js'
import type { SpawnSwitchKind } from '../../../daemon/switchboard/spawnSwitches.js'
import type { SessionLiveV1 } from '../seatLive.js'
import type { SessionFactsV1 } from '../seatProjections.js'
import type {
  KitDialReceiptV1,
  McpToolsV1,
  ModelFactsV1,
  ModelSwitchReceiptV1,
  PermissionModeReceiptV1,
  SpawnSwitchReceiptV1,
} from '../types.js'
import { controlFrame, sendDialReceipt } from './controlCarrier.js'

export const SEAT_VERB_SETTLE_MS = 4000

interface DialsNeeds {
  record(): { readonly sessionId: string; readonly runnerId: string }
  rpc(req: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  readFacts(): void
  live(): SessionLiveV1
  modelFacts(): ModelFactsV1
  showModel(target: string, busy: boolean): void
  showEffort(level: string, busy: boolean): void
  showMode(mode: PermissionMode): SessionFactsV1 | null
  restoreMode(before: SessionFactsV1 | null, mode: PermissionMode): void
  settleFacts(windowMs: number): void
}

export class DialsPart {
  constructor(private readonly needs: DialsNeeds) {}

  async setModel(setting: string | null, words?: string, replacedDefault?: string): Promise<ModelSwitchReceiptV1> {
    const target = setting ?? getEngineModel()
    const current = this.needs.modelFacts()
    if (current.effective === target && current.pendingSwitch === null) return { state: 'no-op' }
    const busy = this.needs.live().inFlight
    this.needs.showModel(target, busy)
    const refuse = (detail: string): ModelSwitchReceiptV1 => {
      logForDebugging(`[engine-connector] daemon ${SESSION_VERBS.setModel.daemon.action} refused: ${detail}`)
      this.needs.readFacts()
      return { state: 'refused', detail }
    }
    try {
      const reply = await this.needs.chainRpc(controlFrame('setModel', this.needs.record().sessionId, { model: target, ...(words === undefined ? {} : { words }), ...(replacedDefault === undefined ? {} : { replacedDefault }) }))
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the switch'))
      const outcome = reply.outcome
      const detail = typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : undefined
      if (outcome === 'refused') return refuse(detail ?? 'the daemon refused the switch')
      if (outcome !== 'applied' && outcome !== 'queued' && outcome !== 'noop') return refuse(`unexpected outcome ${String(outcome)}`)
      if (outcome === 'noop' || (outcome === 'queued') !== busy) this.needs.readFacts()
      if (outcome === 'noop') return { state: 'no-op' }
      this.needs.settleFacts(SEAT_VERB_SETTLE_MS)
      if (outcome === 'applied') {
        const respawned = (reply as { respawned?: unknown }).respawned === true
        if (respawned) this.needs.readFacts()
        if (detail !== undefined && (respawned || detail !== `${this.needs.record().runnerId} → ${target}`)) return { state: 'applied', note: detail }
      }
      return { state: outcome }
    } catch (e) {
      return refuse(`the daemon is not answering — the switch did not land (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  async setEffort(level: string): Promise<ModelSwitchReceiptV1> {
    const current = this.needs.modelFacts()
    if (current.effort === level) return { state: 'no-op' }
    const busy = this.needs.live().inFlight
    this.needs.showEffort(level, busy)
    const refuse = (detail: string): ModelSwitchReceiptV1 => {
      logForDebugging(`[engine-connector] daemon ${SESSION_VERBS.setEffort.daemon.action} refused: ${detail}`)
      this.needs.readFacts()
      return { state: 'refused', detail }
    }
    try {
      const reply = await this.needs.chainRpc(controlFrame('setEffort', this.needs.record().sessionId, { effort: level }))
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the effort'))
      const outcome = reply.outcome
      const detail = typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : undefined
      if (outcome === 'refused') return refuse(detail ?? 'the daemon refused the effort')
      if (outcome !== 'applied' && outcome !== 'queued' && outcome !== 'noop') return refuse(`unexpected outcome ${String(outcome)}`)
      if ((outcome === 'queued') !== busy) this.needs.readFacts()
      if (outcome === 'noop') return { state: 'no-op' }
      this.needs.settleFacts(SEAT_VERB_SETTLE_MS)
      return { state: outcome }
    } catch (e) {
      return refuse(`the daemon is not answering — the effort did not land (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  async mcpAction(name: string, action: 'authenticate' | 'reconnect' | 'cancel-auth'): Promise<KitDialReceiptV1> {
    try {
      const reply = await this.needs.rpc(controlFrame('mcpAction', this.needs.record().sessionId, { mcpAction: { name, action } }), SESSION_VERBS.mcpAction.runner.deadlineMs)
      return reply.ok === true && reply.outcome === 'applied'
        ? { outcome: 'applied', ...(typeof reply.detail === 'string' ? { detail: reply.detail } : {}) }
        : { outcome: 'refused', detail: String(reply.detail ?? reply.error ?? 'the MCP action refused') }
    } catch (error) {
      return { outcome: 'refused', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async mcpTools(serverName: string): Promise<McpToolsV1> {
    const unavailable = (detail: string): McpToolsV1 => ({ server: serverName, state: 'unavailable', tools: [], omitted: 0, detail })
    try {
      const reply = await this.needs.rpc(controlFrame('mcpTools', this.needs.record().sessionId, { mcpServer: serverName }))
      if (reply.ok !== true) return unavailable(String(reply.error ?? 'the daemon refused the MCP tools list'))
      if (reply.outcome !== 'applied') return unavailable(typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : `unexpected outcome ${String(reply.outcome)}`)
      return mcpToolsOfReply(reply.mcpTools) ?? unavailable('the daemon answered the MCP tools list with a payload this screen cannot read')
    } catch (e) {
      return unavailable(`the daemon is not answering — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1> {
    return sendDialReceipt(
      this.needs.chainRpc,
      this.needs.record().sessionId,
      'setKit',
      { kitEdit: edit, clientOpId: `kit-${randomUUID()}` },
      {
        refused: 'the daemon refused the dial',
        unreachable: 'the daemon is not answering — the dial did not land',
        log: logForDebugging,
      },
    )
  }

  setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): Promise<SpawnSwitchReceiptV1> {
    return sendDialReceipt(
      this.needs.chainRpc,
      this.needs.record().sessionId,
      'setSpawnSwitch',
      { spawnSwitch: { kind, on } },
      {
        refused: 'the daemon refused the toggle',
        unreachable: 'the daemon is not answering — the toggle did not land',
        onSettled: () => this.needs.readFacts(),
        log: logForDebugging,
      },
    )
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionModeReceiptV1> {
    const before = this.needs.showMode(mode)
    let receipt: PermissionModeReceiptV1
    try {
      const reply = await this.needs.chainRpc(controlFrame('setPermissionMode', this.needs.record().sessionId, { mode }))
      const outcome = reply.outcome
      receipt =
        reply.ok === true && (outcome === 'applied' || outcome === 'noop')
          ? { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
          : { outcome: 'refused', detail: typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : String(reply.error ?? 'the daemon refused the mode change') }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon ${SESSION_VERBS.setPermissionMode.daemon.action} failed: ${e}`)
      receipt = { outcome: 'refused', detail: 'the daemon is not answering — the mode change did not land' }
    }
    if (receipt.outcome === 'applied') this.needs.settleFacts(SEAT_VERB_SETTLE_MS)
    if (receipt.outcome === 'refused') {
      this.needs.restoreMode(before, mode)
      this.needs.readFacts()
    }
    return receipt
  }
}
