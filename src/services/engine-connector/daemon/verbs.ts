import { randomUUID } from 'node:crypto'
import type { SessionKitEditV1 } from '../../../daemon/sessionKit.js'
import type { PermissionMode } from '../../../types/permissions.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getEngineModel } from '../../../utils/model/model.js'
import { submitTrace } from '../../../utils/submitTrace.js'
import { mcpToolsOfReply } from '../../mcp/toolsAnswer.js'
import type { SpawnSwitchKind } from '../../switchboard/spawnSwitches.js'
import type { SessionLiveV1 } from '../seatLive.js'
import type { SessionFactsV1 } from '../seatProjections.js'
import type {
  AgentControlReceiptV1,
  BoardPostReceiptV1,
  BoardPostRequestV1,
  KitDialReceiptV1,
  LeaveReceiptV1,
  McpToolsV1,
  ModelFactsV1,
  ModelSwitchReceiptV1,
  PermissionModeReceiptV1,
  RewindReceiptV1,
  RewindRequestV1,
  SendReceiptV1,
  SessionAskV1,
  SpawnSwitchReceiptV1,
} from '../types.js'
import { REFUSED_EMPTY } from './shared.js'

const LEAVE_RPC_TIMEOUT_MS = 135_000
export const SEAT_VERB_SETTLE_MS = 4000

interface VerbsNeeds {
  record(): { readonly sessionId: string; readonly runnerId: string }
  rpc(req: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  verbChain(): Promise<unknown>
  tick(): Promise<void>
  readFacts(): void
  live(): SessionLiveV1
  asks(): readonly SessionAskV1[]
  dropAsks(): void
  pressInterrupt(): { hard: boolean; undo: () => void } | null
  modelFacts(): ModelFactsV1
  showModel(target: string, busy: boolean): void
  showEffort(level: string, busy: boolean): void
  showMode(mode: PermissionMode): SessionFactsV1 | null
  restoreMode(before: SessionFactsV1 | null, mode: PermissionMode): void
  settleFacts(windowMs: number): void
}

export class VerbsPart {
  constructor(private readonly needs: VerbsNeeds) {}

  async rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    try {
      const reply = await this.needs.chainRpc(req.undo === true || req.filePath !== undefined ? {
        op: 'sessionFileRestore',
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        userMessageId: req.userMessageId,
        ...(req.undo === true ? { action: 'undo' } : { action: 'restore', filePath: req.filePath! }),
        ...(req.dryRun === true ? { dryRun: true } : {}),
      } : {
        op: 'sessionRewind',
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        mode: req.mode,
        userMessageId: req.userMessageId,
        ...(req.dryRun === true ? { dryRun: true } : {}),
      })
      if (reply.ok !== true) {
        const error = typeof reply.error === 'string' ? reply.error : ''
        if (reply.refusal === 'daemon-older') {
          return { outcome: 'refused', mode: req.mode, refusal: 'daemon-older', detail: error }
        }
        return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `${error !== '' ? error : 'the daemon refused the rewind'} — nothing is assumed restored` }
      }
      const outcome = reply.outcome
      if (outcome !== 'applied' && outcome !== 'refused' && outcome !== 'noop') {
        return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `unexpected outcome ${String(outcome)}` }
      }
      const r = reply as unknown as RewindReceiptV1
      const receipt: RewindReceiptV1 = {
        outcome,
        mode: req.mode,
        ...(r.refusal !== undefined ? { refusal: r.refusal } : {}),
        ...(typeof r.detail === 'string' && r.detail !== '' ? { detail: r.detail } : {}),
        ...(r.dryRun === true ? { dryRun: true } : {}),
        ...(r.code !== undefined ? { code: r.code } : {}),
        ...(r.conversation !== undefined ? { conversation: r.conversation } : {}),
      }
      if (receipt.outcome === 'applied' && receipt.conversation !== undefined && receipt.dryRun !== true) void this.needs.tick()
      return receipt
    } catch (e) {
      return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `the daemon is not answering — nothing is assumed restored (${e instanceof Error ? e.message : String(e)})` }
    }
  }

  async sendAgentNote(agentId: string, text: string): Promise<SendReceiptV1> {
    const trimmed = text.trim()
    if (trimmed === '' || agentId === '') return REFUSED_EMPTY
    const clientMessageId = randomUUID()
    submitTrace('connector-agent-note', trimmed, { agentId, clientMessageId })
    try {
      const { ensureOwnedDaemon } = await import('../../switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return { state: 'refused', detail: 'the daemon that hosts sessions did not start — ↵ again starts it and retries' }
      }
      const reply = await this.needs.rpc({
        op: 'sessionDispatch',
        clientMessageId,
        prompt: trimmed,
        workspaceDir: '',
        targetSessionId: this.needs.record().sessionId,
        by: 'operator',
        mode: 'task-notification',
        agentId,
      })
      if (reply.ok === true) return { state: 'accepted' }
      const detail = typeof reply.error === 'string' ? reply.error : 'the session did not take it'
      return { state: 'refused', detail }
    } catch (e) {
      return { state: 'refused', detail: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  interrupt(): boolean {
    const wasRunning = this.needs.live().inFlight || this.needs.asks().length > 0
    if (!wasRunning) return false
    this.needs.dropAsks()
    const press = this.needs.pressInterrupt()
    if (press === null) return true
    const { hard, undo } = press
    void this.needs.chainRpc({ op: 'sessionControl', action: 'interrupt', sessionId: this.needs.record().sessionId, by: 'operator', clientOpId: randomUUID(), ...(hard ? { hard: true } : {}) })
      .then(reply => {
        if (!(reply.ok === true && reply.outcome === 'applied')) undo()
      })
      .catch(undo)
    return true
  }

  async backgroundShell(): Promise<AgentControlReceiptV1> {
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'background-shell', sessionId: this.needs.record().sessionId, by: 'operator' })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async sendNow(): Promise<AgentControlReceiptV1> {
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'send-now', sessionId: this.needs.record().sessionId, by: 'operator' })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async pauseGate(paused: boolean): Promise<AgentControlReceiptV1> {
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'pause-gate', sessionId: this.needs.record().sessionId, by: 'operator', paused })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') {
        this.needs.readFacts()
        return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async postBoard(post: BoardPostRequestV1): Promise<BoardPostReceiptV1> {
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'board-post', sessionId: this.needs.record().sessionId, by: 'operator', clientOpId: post.clientOpId, boardPost: post })
      if (reply.ok !== true) return { ok: false, reason: String(reply.error ?? 'the daemon refused the post') }
      const detail = typeof reply.detail === 'string' ? reply.detail : ''
      if (!detail.startsWith('{')) return { ok: false, reason: detail || `unexpected outcome ${String(reply.outcome)}` }
      const answer = JSON.parse(detail) as { ok: true; event_id: string; seq: number; replay: boolean; address: string; recipients: string[] } | { ok: false; reason: string; candidates?: string[] }
      if (!answer.ok) return answer
      return { ok: true, eventId: answer.event_id, seq: answer.seq, replay: answer.replay, address: answer.address, recipients: answer.recipients }
    } catch (e) {
      return { ok: false, reason: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async leave(opts?: { signal?: AbortSignal }): Promise<LeaveReceiptV1> {
    const skip = (): void => {
      void this.needs.rpc({ op: 'sessionControl', action: 'interrupt', sessionId: this.needs.record().sessionId, by: 'operator', clientOpId: randomUUID() }).catch(() => {})
    }
    if (opts?.signal?.aborted) return { note: 'none', detail: 'the handoff was skipped' }
    opts?.signal?.addEventListener('abort', skip, { once: true })
    try {
      await this.needs.verbChain()
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const reply = (await daemonControlRpc(
        { op: 'sessionControl', action: 'leave', sessionId: this.needs.record().sessionId, by: 'operator' } as never,
        { timeoutMs: LEAVE_RPC_TIMEOUT_MS },
      )) as Record<string, unknown>
      if (reply.ok !== true) return { note: 'none', detail: String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome !== 'applied') return { note: 'none', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
      let answer: { note?: unknown; noteChars?: unknown } = {}
      try {
        answer = JSON.parse(detail ?? '{}') as { note?: unknown; noteChars?: unknown }
      } catch {
        answer = {}
      }
      if (answer.note === 'stored' || answer.note === 'skipped' || answer.note === 'none') {
        return { note: answer.note, ...(typeof answer.noteChars === 'number' && Number.isInteger(answer.noteChars) && answer.noteChars >= 0 ? { noteChars: answer.noteChars } : {}) }
      }
      return { note: 'none', detail: detail ?? 'the runner answered the leave with a receipt the screen cannot read' }
    } catch (e) {
      return { note: 'none', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      opts?.signal?.removeEventListener('abort', skip)
    }
  }

  async agentVerb(action: 'stop-agent' | 'resume-agent', agentId: string, note?: string): Promise<AgentControlReceiptV1> {
    if (agentId === '') return { outcome: 'refused', detail: `${action} needs a crewmate` }
    try {
      const reply = await this.needs.chainRpc({
        op: 'sessionControl',
        action,
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        agentId,
        ...(note !== undefined ? { note } : {}),
      })
      if (reply.ok !== true) {
        return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
      }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome === 'applied') return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
      return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
    } catch (e) {
      return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async setModel(setting: string | null, words?: string): Promise<ModelSwitchReceiptV1> {
    const target = setting ?? getEngineModel()
    const current = this.needs.modelFacts()
    if (current.effective === target && current.pendingSwitch === null) return { state: 'no-op' }
    const busy = this.needs.live().inFlight
    this.needs.showModel(target, busy)
    const refuse = (detail: string): ModelSwitchReceiptV1 => {
      logForDebugging(`[engine-connector] daemon set-model refused: ${detail}`)
      this.needs.readFacts()
      return { state: 'refused', detail }
    }
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'set-model', sessionId: this.needs.record().sessionId, by: 'operator', model: target, ...(words === undefined ? {} : { words }) })
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
      logForDebugging(`[engine-connector] daemon set-effort refused: ${detail}`)
      this.needs.readFacts()
      return { state: 'refused', detail }
    }
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'set-effort', sessionId: this.needs.record().sessionId, by: 'operator', effort: level })
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
      const reply = await this.needs.rpc({ op: 'sessionControl', action: 'mcp-action', sessionId: this.needs.record().sessionId, by: 'operator', mcpAction: { name, action } }, 300_000)
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
      const reply = await this.needs.rpc({ op: 'sessionControl', action: 'mcp-tools', sessionId: this.needs.record().sessionId, by: 'operator', mcpServer: serverName })
      if (reply.ok !== true) return unavailable(String(reply.error ?? 'the daemon refused the MCP tools list'))
      if (reply.outcome !== 'applied') return unavailable(typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : `unexpected outcome ${String(reply.outcome)}`)
      return mcpToolsOfReply(reply.mcpTools) ?? unavailable('the daemon answered the MCP tools list with a payload this screen cannot read')
    } catch (e) {
      return unavailable(`the daemon is not answering — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1> {
    try {
      const reply = await this.needs.chainRpc({
        op: 'sessionControl',
        action: 'set-kit',
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        kitEdit: edit,
        clientOpId: `kit-${randomUUID()}`,
      })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the dial') }
      const outcome = reply.outcome
      if (outcome === 'applied' || outcome === 'queued' || outcome === 'noop' || outcome === 'refused') {
        return { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
      }
      return { outcome: 'refused', detail: `unexpected outcome ${String(outcome)}` }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon set-kit failed: ${e}`)
      return { outcome: 'refused', detail: 'the daemon is not answering — the dial did not land' }
    }
  }

  async setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): Promise<SpawnSwitchReceiptV1> {
    try {
      const reply = await this.needs.chainRpc({
        op: 'sessionControl',
        action: 'set-spawn-switch',
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        spawnSwitch: { kind, on },
      })
      if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the toggle') }
      const outcome = reply.outcome
      if (outcome === 'applied' || outcome === 'queued' || outcome === 'noop' || outcome === 'refused') {
        this.needs.readFacts()
        return { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
      }
      return { outcome: 'refused', detail: `unexpected outcome ${String(outcome)}` }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon set-spawn-switch failed: ${e}`)
      return { outcome: 'refused', detail: 'the daemon is not answering — the toggle did not land' }
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionModeReceiptV1> {
    const before = this.needs.showMode(mode)
    let receipt: PermissionModeReceiptV1
    try {
      const reply = await this.needs.chainRpc({ op: 'sessionControl', action: 'set-permission-mode', sessionId: this.needs.record().sessionId, by: 'operator', mode })
      const outcome = reply.outcome
      receipt =
        reply.ok === true && (outcome === 'applied' || outcome === 'noop')
          ? { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
          : { outcome: 'refused', detail: typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : String(reply.error ?? 'the daemon refused the mode change') }
    } catch (e) {
      logForDebugging(`[engine-connector] daemon set-permission-mode failed: ${e}`)
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
