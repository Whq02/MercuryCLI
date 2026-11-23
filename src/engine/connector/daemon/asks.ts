import type { AssistantMessage, Message } from '../../message-shapes/message.js'
import type { ContentBlockParam } from '../../message-shapes/wire.js'
import type { PermissionMode } from '../../../permissions/rules/permissions.js'
import { decodeDecisionReasonFromWire } from '../../../permissions/rules/decisionReasonWire.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../../tools/kit/tool.js'
import type { ToolUseConfirm } from '../../../permissions/cards/PermissionRequest.js'
import { createAssistantMessage } from '../../message-shapes/factories.js'
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../../platform/files/fileStateCache.js'
import { getAllBaseTools } from '../../../tools/kit/toolList.js'
import { MCPTool } from '../../../tools/mcp/MCPTool.js'
import { mcpInfoFromString } from '../../../integrations/mcp-shapes/mcpToolNames.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { readSessionAsks, type SessionAskProjectionV1, type SessionFactsV1 } from '../seatProjections.js'
import type { AskAnswerV1, AskReceiptV1, SendReceiptV1, SessionAskV1, WorkRowV1 } from '../types.js'
import { emitAll, type Listeners } from './shared.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { controlFrame } from './controlCarrier.js'

interface AsksNeeds {
  record(): { readonly sessionId: string; readonly modelKey?: string }
  rows(): Message[]
  facts(): SessionFactsV1 | null
  permissionMode(): PermissionMode | null
  chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  deliver(text: string, opts: { extraBlocks?: ContentBlockParam[] }): Promise<SendReceiptV1>
  recheckAsks?: () => void
  settleFacts?: () => void
}

function toolFor(name: string): Tool {
  const known = getAllBaseTools().find(t => t.name === name)
  if (known) return known
  const served = mcpInfoFromString(name)
  return {
    ...MCPTool,
    name,
    userFacingName: () => (served?.toolName === undefined ? name : `${served.serverName} - ${served.toolName} (MCP)`),
  }
}

const CREWMATE_GLYPH = '△'

function crewmateTypeLabel(agentType: string | undefined): string {
  if (!agentType || agentType === 'mercury-crew' || agentType === 'worker') return 'crewmate'
  return agentType
}

function formatCrewmateAskLine(agentId: string, work: readonly WorkRowV1[] | undefined): string {
  const row = work?.find(item => item.kind === 'agent' && (item.agentId === agentId || item.id === agentId))
  if (row === undefined) return `${CREWMATE_GLYPH} ${agentId}`
  const label = crewmateTypeLabel(row.agentType)
  const detail = row.name.trim()
  return detail === '' || detail === label || detail === row.agentType
    ? `${CREWMATE_GLYPH} ${label}`
    : `${CREWMATE_GLYPH} ${label} ${detail}`
}

export class AsksPart {
  private askEntries: SessionAskV1[] = []
  private readonly confirms = new Map<string, ToolUseConfirm>()
  private readonly askListeners: Listeners = new Set()

  constructor(private readonly needs: AsksNeeds) {}

  dropAll(): void {
    for (const entry of this.askEntries) this.confirms.delete(entry.id)
    this.askEntries = []
    emitAll(this.askListeners, 'asks')
  }

  readAsks(): void {
    const projection = readSessionAsks(this.needs.record().sessionId)
    const rows: SessionAskProjectionV1[] = projection?.asks ?? []
    const nextIds = rows.map(r => r.requestId)
    const sameIds = nextIds.length === this.askEntries.length && nextIds.every((id, i) => id === this.askEntries[i]!.id)
    if (sameIds && projection !== null) return
    if (projection === null && this.askEntries.length === 0) return
    const next: SessionAskV1[] = []
    for (const row of rows) {
      let confirm = this.confirms.get(row.requestId)
      if (confirm === undefined) {
        confirm = this.buildConfirm(row)
        this.confirms.set(row.requestId, confirm)
      }
      next.push({
        id: row.requestId,
        confirm,
        toolName: row.toolName,
        ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
        askedAt: row.askedAt,
        ...(row.limitMs !== undefined ? { limitMs: row.limitMs } : {}),
      })
    }
    for (const id of [...this.confirms.keys()]) if (!nextIds.includes(id)) this.confirms.delete(id)
    this.askEntries = next
    emitAll(this.askListeners, 'asks')
  }

  private assistantRecordFor(toolUseId: string, toolName: string, input: Record<string, unknown>): AssistantMessage {
    const rows = this.needs.rows()
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i]!
      if (m.type !== 'assistant') continue
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content) && content.some(b => (b as { type?: string; id?: string }).type === 'tool_use' && (b as { id?: string }).id === toolUseId)) {
        return m as AssistantMessage
      }
    }
    return createAssistantMessage({
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
    })
  }

  private standInToolUseContext(): ToolUseContext {
    const facts = this.needs.facts()
    return {
      options: {
        commands: [],
        debug: false,
        verbose: false,
        engineModel: facts?.model.effective ?? this.needs.record().modelKey ?? getEngineModel(),
        tools: getAllBaseTools(),
        mcpClients: [],
        isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      startTurn: () => {
        throw new Error('a daemon-hosted session has no in-process turn loop')
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      getAppState: () => {
        throw new Error('a daemon-hosted session has no in-process app state')
      },
      setAppState: () => {},
      messages: this.needs.rows(),
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    }
  }

  private buildConfirm(row: SessionAskProjectionV1): ToolUseConfirm {
    const tool = toolFor(row.toolName)
    const decisionReason =
      decodeDecisionReasonFromWire(row.decisionReasonDetail) ??
      (row.decisionReason !== undefined ? { type: 'other' as const, reason: row.decisionReason } : undefined)
    const permissionResult = {
      behavior: 'ask' as const,
      message: `${row.toolName} asks to run`,
      ...(row.suggestions !== undefined ? { suggestions: row.suggestions } : {}),
      ...(row.blockedPath !== undefined ? { blockedPath: row.blockedPath } : {}),
      ...(decisionReason !== undefined ? { decisionReason } : {}),
    }
    let description = row.description ?? tool.userFacingName(row.input) ?? row.toolName
    const crewmateId = row.agentId !== undefined && row.agentId !== '' ? row.agentId : undefined
    const needs = this.needs
    const confirm: ToolUseConfirm = {
      assistantMessage: this.assistantRecordFor(row.toolUseId, row.toolName, row.input),
      tool,
      get description() {
        return description
      },
      input: row.input,
      toolUseContext: this.standInToolUseContext(),
      toolUseID: row.toolUseId,
      permissionResult: permissionResult as ToolUseConfirm['permissionResult'],
      permissionPromptStartTimeMs: row.askedAt,
      ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
      ...(crewmateId !== undefined
        ? {
            get crewmate() {
              return formatCrewmateAskLine(crewmateId, needs.facts()?.work)
            },
          }
        : {}),
      onUserInteraction: () => {},
      onAbort: () => {
        void this.answerThroughDaemon(row.requestId, { kind: 'abort' })
      },
      onAllow: async (updatedInput, permissionUpdates, feedback, contentBlocks) => {
        await this.answerThroughDaemon(row.requestId, {
          kind: 'allow',
          updatedInput: updatedInput as Record<string, unknown>,
          permissionUpdates,
          feedback,
          contentBlocks,
        })
      },
      onReject: async (feedback, contentBlocks) => {
        await this.answerThroughDaemon(row.requestId, { kind: 'deny', feedback, contentBlocks })
      },
      recheckPermission: async () => {
        this.readAsks()
        this.needs.recheckAsks?.()
      },
    }
    if (row.description !== undefined) return confirm
    void Promise.resolve(
      tool.description(row.input, {
        isNonInteractiveSession: false,
        toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: this.needs.permissionMode() ?? 'default' },
        tools: getAllBaseTools(),
      }),
    )
      .then(text => {
        if (typeof text === 'string' && text.trim() !== '') description = text
      })
      .catch(passedOver)
    return confirm
  }

  private async answerThroughDaemon(requestId: string, answer: AskAnswerV1): Promise<AskReceiptV1> {
    this.settleAsk(requestId)
    try {
      const reply = await this.needs.chainRpc(
        controlFrame('answerAsk', this.needs.record().sessionId, {
          requestId,
          allow: answer.kind === 'allow',
          answer:
            answer.kind === 'allow'
              ? {
                  ...(answer.updatedInput !== undefined ? { updatedInput: answer.updatedInput } : {}),
                  ...(answer.permissionUpdates !== undefined && answer.permissionUpdates.length > 0
                    ? { permissionUpdates: answer.permissionUpdates }
                    : {}),
                }
              : answer.kind === 'deny'
                ? { ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}) }
                : { interrupt: true },
        }),
      )
      const ok = reply.ok === true && reply.outcome === 'applied'
      if (!ok) return { ok: false, detail: String(reply.detail ?? reply.error ?? 'the ask was already answered') }
      if (answer.kind === 'allow' && answer.permissionUpdates !== undefined && answer.permissionUpdates.length > 0) {
        this.needs.recheckAsks?.()
        this.needs.settleFacts?.()
      }
      const feedback = answer.kind === 'allow' || answer.kind === 'deny' ? answer.feedback?.trim() : undefined
      const blocks = answer.kind === 'allow' || answer.kind === 'deny' ? answer.contentBlocks : undefined
      if ((answer.kind === 'allow' && feedback) || (blocks !== undefined && blocks.length > 0)) {
        void this.needs.deliver(feedback ?? '', { extraBlocks: blocks })
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  asks(): readonly SessionAskV1[] {
    return this.askEntries
  }

  subscribeAsks(listener: () => void): () => void {
    this.askListeners.add(listener)
    return () => {
      this.askListeners.delete(listener)
    }
  }

  answerAsk(askId: string, answer: AskAnswerV1): Promise<AskReceiptV1> {
    if (!this.askEntries.some(a => a.id === askId)) {
      return Promise.resolve({ ok: false, detail: 'no pending ask carries that id' })
    }
    return this.answerThroughDaemon(askId, answer)
  }

  settleAsk(askId: string): void {
    if (!this.askEntries.some(a => a.id === askId)) return
    this.askEntries = this.askEntries.filter(a => a.id !== askId)
    this.confirms.delete(askId)
    emitAll(this.askListeners, 'asks')
  }
}
