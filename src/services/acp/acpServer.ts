
import { randomUUID, type UUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  agent,
  ndJsonStream,
  methods,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import type {
  AgentContext,
} from '@agentclientprotocol/sdk'
import {
  listReviewArtifactHeadsSource,
  readReviewArtifactState,
} from '../../utils/artifacts/reviewStore.js'
import { healthOf, valueOr } from '../../substrate/sourceState.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import { loadRunSidecar, runRevision } from '../run/runSidecar.js'
import { processMainOwner } from '../run/resolveOwner.js'
import { isOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { getCwd } from '../../utils/cwd.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { sessionIdExists } from '../../utils/sessionStorage.js'
import { loadSessionFile } from '../../utils/sessionStorage/loading.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import { resolveWorkbenchSnapshot } from '../workbench/projection.js'
import { workbenchFactsOf } from '../workbench/attentionBridge.js'
import {
  createComposerDocument,
  addShelfItem,
  type ComposerDocument,
} from '../../input-core/composer-document.js'
import {
  bucketItems,
  ATTENTION_BUCKETS,
  foldAttention,
  emptyAttentionState,
} from '../../services/attention/contracts.js'
import type { AttentionItem, AttentionState } from '../../services/attention/contracts.js'
import { foldRelations, emptyRelationState } from '../../services/attention/relations.js'
import type { RelationState } from '../../services/attention/relations.js'
import { listTasks, getTasksDir, type TaskStatus } from '../../utils/tasks.js'
import { existsSync, readFileSync } from 'node:fs'
import { getContextWindowForModel } from '../../utils/model/capabilities.js'
import { MercuryChildSession, toolResultText, type TurnEndDetail } from './childSession.js'
import { decodePermissionModeSpelling } from '../../types/permissions.js'

const PERMISSION_MODES = [
  { id: 'default', name: 'Default', description: 'ask before consequential tools' },
  { id: 'implement', name: 'Implement Mode', description: 'file edits pre-approved' },
  { id: 'strategy', name: 'Strategy Mode', description: 'read-only planning' },
  { id: 'flow', name: 'Flow', description: 'the safer autonomous mode' },
] as const

function decodeAcpModeId(raw: string): string {
  return decodePermissionModeSpelling(raw)
}


const TASK_PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

export function permissionAskWire(
  ask: { toolUseId?: string; toolName: string; input: unknown },
  requestId: string | number,
  acpSessionId: string,
): {
  sessionId: string
  toolCall: { toolCallId: string; title: string; status: 'pending'; rawInput: unknown }
  options: { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[]
} {
  return {
    sessionId: acpSessionId,
    toolCall: {
      toolCallId: ask.toolUseId || `ask-${requestId}`,
      title: ask.toolName,
      status: 'pending',
      rawInput: ask.input,
    },
    options: [
      { optionId: 'allow', name: `Allow ${ask.toolName}`, kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  }
}

export function permissionAllowedOf(result: unknown): boolean {
  const o = (result as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome
  return o?.outcome === 'selected' && o?.optionId === 'allow'
}


export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

const TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  Read: 'read',
  NotebookRead: 'read',
  ReadMcpResourceTool: 'read',
  ListMcpResourcesTool: 'read',
  Inspect: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  AstEdit: 'edit',
  ChangeSet: 'edit',
  Glob: 'search',
  Grep: 'search',
  AstSearch: 'search',
  LSP: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
  Bash: 'execute',
  PowerShell: 'execute',
  REPL: 'execute',
  Debug: 'execute',
  Launch: 'execute',
  Test: 'execute',
  Eval: 'execute',
  Agent: 'think',
  Task: 'think',
  TaskCreate: 'think',
  TaskUpdate: 'think',
  TaskGet: 'think',
  TaskList: 'think',
  EnterPlanMode: 'switch_mode',
  ExitPlanMode: 'switch_mode',
  SetTier: 'switch_mode',
}

export function toolKindOf(name: string): AcpToolKind {
  return TOOL_KINDS[name] ?? 'other'
}

export function toolLocationsOf(
  name: string,
  input: unknown,
): Array<{ path: string; line?: number }> {
  const i = (input ?? {}) as Record<string, unknown>
  const out: Array<{ path: string; line?: number }> = []
  const push = (path: unknown, line?: unknown): void => {
    if (typeof path !== 'string' || path === '') return
    if (out.some(l => l.path === path)) return
    out.push({ path, ...(typeof line === 'number' && line > 0 ? { line } : {}) })
  }
  push(i.file_path, name === 'Read' ? i.offset : undefined)
  push(i.notebook_path)
  if (name === 'AstEdit' || name === 'AstSearch') push(i.path)
  if (name === 'ChangeSet' && Array.isArray(i.changes)) {
    for (const change of i.changes as Array<Record<string, unknown>>) push(change.file_path)
  }
  return out
}

export interface AcpDiff {
  path: string
  oldText?: string | null
  newText: string
}

export function toolDiffsOf(
  name: string,
  input: unknown,
  readFile: (path: string) => string | null = readFileOrNull,
): AcpDiff[] {
  const i = (input ?? {}) as Record<string, unknown>
  if (name === 'Edit' && typeof i.file_path === 'string' && typeof i.new_string === 'string') {
    return [
      {
        path: i.file_path,
        oldText: typeof i.old_string === 'string' ? i.old_string : null,
        newText: i.new_string,
      },
    ]
  }
  if (name === 'Write' && typeof i.file_path === 'string' && typeof i.content === 'string') {
    const before = readFile(i.file_path)
    if (before === i.content) return []
    return [{ path: i.file_path, oldText: before, newText: i.content }]
  }
  return []
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export const TOOL_OUTPUT_WIRE_LIMIT = 16_000

export function boundedToolText(text: string, limit = TOOL_OUTPUT_WIRE_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters not shown)`
}

export function toolOutputContentOf(
  text: string | undefined,
): Array<{ type: 'content'; content: { type: 'text'; text: string } }> | undefined {
  if (text === undefined || text === '') return undefined
  return [{ type: 'content', content: { type: 'text', text: boundedToolText(text) } }]
}


export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export function stopReasonOf(
  outcome: 'success' | 'error' | 'cancelled',
  detail: TurnEndDetail | undefined,
): { stopReason: AcpStopReason } | { error: string } {
  if (outcome === 'cancelled') return { stopReason: 'cancelled' }
  if (outcome === 'success') {
    if (detail?.stopReason === 'max_tokens') return { stopReason: 'max_tokens' }
    if (detail?.stopReason === 'refusal') return { stopReason: 'refusal' }
    return { stopReason: 'end_turn' }
  }
  if (detail?.subtype === 'error_max_turns') return { stopReason: 'max_turn_requests' }
  const why = detail?.errors.filter(e => e.trim() !== '').join('; ')
  return {
    error: `the session turn failed${detail ? ` (${detail.subtype})` : ''}${why ? `: ${why}` : ''}`,
  }
}


export function acpMcpServersToConfig(
  servers: unknown,
): { json: string; names: string[]; skipped: string[] } | null {
  if (!Array.isArray(servers) || servers.length === 0) return null
  const mcpServers: Record<string, Record<string, unknown>> = {}
  const skipped: string[] = []
  const headersOf = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (!Array.isArray(raw)) return out
    for (const h of raw as Array<Record<string, unknown>>) {
      if (typeof h?.name === 'string' && typeof h.value === 'string') out[h.name] = h.value
    }
    return out
  }
  for (const raw of servers as Array<Record<string, unknown>>) {
    const name = typeof raw?.name === 'string' ? raw.name : ''
    if (name === '') {
      skipped.push('(unnamed)')
      continue
    }
    const type = typeof raw.type === 'string' ? raw.type : 'stdio'
    if ((type === 'http' || type === 'sse') && typeof raw.url === 'string') {
      mcpServers[name] = { type, url: raw.url, headers: headersOf(raw.headers) }
    } else if (type === 'stdio' && typeof raw.command === 'string') {
      const env: Record<string, string> = {}
      if (Array.isArray(raw.env)) {
        for (const e of raw.env as Array<Record<string, unknown>>) {
          if (typeof e?.name === 'string' && typeof e.value === 'string') env[e.name] = e.value
        }
      }
      mcpServers[name] = {
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
        env,
      }
    } else {
      skipped.push(`${name} (${type})`)
    }
  }
  const names = Object.keys(mcpServers)
  if (names.length === 0) return null
  return { json: JSON.stringify({ mcpServers }), names, skipped }
}


export interface EditorContextWire {
  v: 1
  sessionId: string
  workspaceFolders?: string[]
  activeFile?: {
    path: string
    languageId?: string
    selection?: { startLine: number; endLine: number; text?: string }
  }
  openFiles?: string[]
  diagnostics?: Array<{ path: string; line: number; severity: string; message: string }>
}

const EDITOR_CONTEXT_URI = 'mercury://editor-context'
const EDITOR_CONTEXT_SELECTION_LIMIT = 8_000
const EDITOR_CONTEXT_LIST_LIMIT = 30
const EDITOR_CONTEXT_DIAGNOSTIC_LIMIT = 25

export function editorContextOf(raw: unknown): EditorContextWire | null {
  const r = raw as Record<string, unknown> | null
  if (r === null || typeof r !== 'object' || typeof r.sessionId !== 'string') return null
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
  const active = r.activeFile as Record<string, unknown> | undefined
  const sel = active?.selection as Record<string, unknown> | undefined
  const diags = Array.isArray(r.diagnostics)
    ? (r.diagnostics as Array<Record<string, unknown>>)
        .filter(d => typeof d?.path === 'string' && typeof d.message === 'string')
        .map(d => ({
          path: d.path as string,
          line: typeof d.line === 'number' ? d.line : 0,
          severity: typeof d.severity === 'string' ? d.severity : 'Info',
          message: d.message as string,
        }))
    : undefined
  const folders = strings(r.workspaceFolders)
  const open = strings(r.openFiles)
  return {
    v: 1,
    sessionId: r.sessionId,
    ...(folders !== undefined ? { workspaceFolders: folders } : {}),
    ...(active && typeof active.path === 'string'
      ? {
          activeFile: {
            path: active.path,
            ...(typeof active.languageId === 'string' ? { languageId: active.languageId } : {}),
            ...(sel && typeof sel.startLine === 'number' && typeof sel.endLine === 'number'
              ? {
                  selection: {
                    startLine: sel.startLine,
                    endLine: sel.endLine,
                    ...(typeof sel.text === 'string' ? { text: sel.text } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(open !== undefined ? { openFiles: open } : {}),
    ...(diags !== undefined ? { diagnostics: diags } : {}),
  }
}

export function editorContextResource(
  ctx: EditorContextWire | null,
): { type: 'resource'; resource: { uri: string; text: string; mimeType: string } } | null {
  if (ctx === null) return null
  const lines: string[] = []
  if (ctx.workspaceFolders && ctx.workspaceFolders.length > 0) {
    lines.push(`workspace: ${ctx.workspaceFolders.slice(0, 10).join(', ')}`)
  }
  if (ctx.activeFile) {
    const lang = ctx.activeFile.languageId ? ` (${ctx.activeFile.languageId})` : ''
    const sel = ctx.activeFile.selection
    if (sel) {
      lines.push(`active file: ${ctx.activeFile.path}${lang} · selection lines ${sel.startLine}-${sel.endLine}`)
      if (sel.text !== undefined && sel.text !== '') {
        lines.push(
          sel.text.length > EDITOR_CONTEXT_SELECTION_LIMIT
            ? `${sel.text.slice(0, EDITOR_CONTEXT_SELECTION_LIMIT)}\n… (selection truncated)`
            : sel.text,
        )
      }
    } else {
      lines.push(`active file: ${ctx.activeFile.path}${lang}`)
    }
  }
  if (ctx.openFiles && ctx.openFiles.length > 0) {
    const shown = ctx.openFiles.slice(0, EDITOR_CONTEXT_LIST_LIMIT)
    const more = ctx.openFiles.length - shown.length
    lines.push(`open files: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`)
  }
  if (ctx.diagnostics && ctx.diagnostics.length > 0) {
    const shown = ctx.diagnostics.slice(0, EDITOR_CONTEXT_DIAGNOSTIC_LIMIT)
    lines.push('diagnostics:')
    for (const d of shown) lines.push(`  ${d.path}:${d.line} ${d.severity}: ${d.message}`)
    if (ctx.diagnostics.length > shown.length) lines.push(`  … (+${ctx.diagnostics.length - shown.length} more)`)
  }
  if (lines.length === 0) return null
  return {
    type: 'resource',
    resource: { uri: EDITOR_CONTEXT_URI, text: lines.join('\n'), mimeType: 'text/plain' },
  }
}


export function replayUpdatesOf(
  messages: Iterable<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const updates: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.isMeta === true || m.isSidechain === true) continue
    const message = m.message as { content?: unknown } | undefined
    const content = message?.content
    if (m.type === 'user') {
      if (typeof content === 'string') {
        if (content !== '') updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: content } })
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: block.text } })
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const text = toolResultText(block.content)
          const output = toolOutputContentOf(text)
          updates.push({
            sessionUpdate: 'tool_call_update',
            toolCallId: block.tool_use_id,
            status: block.is_error === true ? 'failed' : 'completed',
            ...(output !== undefined ? { content: output } : {}),
          })
        }
      }
      continue
    }
    if (m.type === 'assistant') {
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
          updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking } })
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = String(block.name ?? 'tool')
          updates.push({
            sessionUpdate: 'tool_call',
            toolCallId: block.id,
            title: name,
            kind: toolKindOf(name),
            status: 'in_progress',
            rawInput: (block.input as Record<string, unknown>) ?? {},
            locations: toolLocationsOf(name, block.input),
          })
        }
      }
    }
  }
  return updates
}

export interface AcpPromptMaterial {
  doc: ComposerDocument
  bodies: Map<string, string>
  images: Map<string, { mimeType: string; data: string }>
  layout: Array<{ kind: 'text'; text: string } | { kind: 'item'; id: string }>
}

export function acpPromptToComposerDocument(
  content: Array<Record<string, unknown>>,
): AcpPromptMaterial {
  let doc = createComposerDocument('acp-prompt')
  const bodies = new Map<string, string>()
  const images = new Map<string, { mimeType: string; data: string }>()
  const layout: AcpPromptMaterial['layout'] = []
  const texts: string[] = []
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text)
      layout.push({ kind: 'text', text: item.text })
    } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
      const path = String(item.uri).replace(/^file:\/\//, '')
      doc = addShelfItem(doc, { kind: 'file', ref: String(item.uri), label: path })
      const fileChip = doc.items.find(i => i.kind === 'file' && i.ref === String(item.uri))!
      layout.push({ kind: 'item', id: fileChip.id })
    } else if (item.type === 'resource') {
      const resource = item.resource as { uri?: string; text?: string } | undefined
      if (resource?.text !== undefined) {
        const uri = resource.uri ?? ''
        doc = addShelfItem(doc, {
          kind: 'selection',
          ref: uri,
          label: /[^/\\]+$/.exec(uri)?.[0] ?? (uri || 'selection'),
          bytes: resource.text.length,
        })
        bodies.set(doc.items[doc.items.length - 1]!.id, resource.text)
        layout.push({ kind: 'item', id: doc.items[doc.items.length - 1]!.id })
      }
    } else if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      doc = addShelfItem(doc, {
        kind: 'image',
        ref: `acp-image:${item.mimeType}`,
        label: `Image · ${item.mimeType} · ${(item.data.length / 1024).toFixed(1)} KB`,
        bytes: item.data.length,
      })
      images.set(doc.items[doc.items.length - 1]!.id, {
        mimeType: item.mimeType,
        data: item.data,
      })
      layout.push({ kind: 'item', id: doc.items[doc.items.length - 1]!.id })
    }
  }
  doc = { ...doc, body: texts.join('\n') }
  return { doc, bodies, images, layout }
}

export function composerDocumentBlocks(m: AcpPromptMaterial): Array<Record<string, unknown>> {
  const itemsById = new Map(m.doc.items.map(i => [i.id, i]))
  const blocks: Array<Record<string, unknown>> = []
  for (const entry of m.layout) {
    if (entry.kind === 'text') {
      blocks.push({ type: 'text', text: entry.text })
      continue
    }
    const item = itemsById.get(entry.id)
    if (!item) continue
    if (item.kind === 'selection') {
      const text = m.bodies.get(item.id)
      if (text !== undefined) {
        blocks.push({
          type: 'text',
          text: `<attached-resource uri="${item.ref}">\n${text}\n</attached-resource>`,
        })
      }
    } else if (item.kind === 'file') {
      blocks.push({ type: 'text', text: `@${item.ref.replace(/^file:\/\//, '')}` })
    } else if (item.kind === 'image') {
      const image = m.images.get(item.id)
      if (image) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType, data: image.data },
        })
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

export function planEntriesOf(
  tasks: ReadonlyArray<{ id: string; subject: string; status: TaskStatus }>,
): Array<{ content: string; priority: 'medium'; status: TaskStatus }> {
  return [...tasks]
    .sort((a, b) => {
      const an = Number(a.id)
      const bn = Number(b.id)
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map(t => ({ content: t.subject, priority: 'medium' as const, status: t.status }))
}

export function usageWireOf(
  lastRoundTrip: Record<string, unknown>,
  model: string,
): { used: number; size: number } {
  const n = (key: string): number => {
    const v = lastRoundTrip[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const used =
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens') +
    n('output_tokens')
  return { used, size: getContextWindowForModel(model) }
}

export interface AttentionWireItem {
  subjectId: string
  owner: string
  sourceEventId: string
  reasonCode: string
  reasonLabel: string
  sinceMs: number
  atMs: number
  urgency: number
  title?: string
}

export interface AttentionWire {
  v: 1
  version: number
  atMs: number
  needsYou: number
  buckets: Partial<Record<string, AttentionWireItem[]>>
  edges: Array<{
    kind: string
    from: string
    to: string
    owner: string
    sourceEventId: string
  }>
}

export function attentionWire(view: {
  v: 1
  version: number
  atMs: number
  attention: AttentionState
  relations: RelationState
  needsYou: number
}): AttentionWire {
  const buckets: Partial<Record<string, AttentionWireItem[]>> = {}
  for (const bucket of ATTENTION_BUCKETS) {
    const items = bucketItems(view.attention, bucket)
    if (items.length === 0) continue
    buckets[bucket] = items.map((i: AttentionItem) => ({
      subjectId: i.subjectId,
      owner: i.owner,
      sourceEventId: i.sourceEventId,
      reasonCode: i.reasonCode,
      reasonLabel: i.reasonLabel,
      sinceMs: i.sinceMs,
      atMs: i.atMs,
      urgency: i.urgency,
      ...(i.title !== undefined && { title: i.title }),
    }))
  }
  return {
    v: 1,
    version: view.version,
    atMs: view.atMs,
    needsYou: view.needsYou,
    buckets,
    edges: [...view.relations.edges.values()].map(e => ({
      kind: e.kind,
      from: e.from,
      to: e.to,
      owner: e.owner,
      sourceEventId: e.sourceEventId,
    })),
  }
}

export function attentionWireFromSnapshot(snap: {
  threads: unknown[]
  reviewQueue?: unknown[]
  refreshedAt: number
  lanes?: unknown[]
}): AttentionWire {
  const facts = workbenchFactsOf(snap as never)
  const attention = foldAttention(emptyAttentionState(), facts.attention)
  const relations = foldRelations(emptyRelationState(), facts.relations)
  return attentionWire({
    v: 1,
    version: snap.refreshedAt,
    atMs: snap.refreshedAt,
    attention,
    relations,
    needsYou: bucketItems(attention, 'needs-you').length,
  })
}

interface AcpSessionState {
  child: MercuryChildSession
  cwd: string
  modeId: string
  turnResolve: ((outcome: 'success' | 'error' | 'cancelled', detail?: TurnEndDetail) => void) | null
  cancelled: boolean
  editorContext: EditorContextWire | null
  toolNames: Map<string, string>
  planChain: Promise<void>
  planEverSent: boolean
  costTotalUsd: number
}

export interface AcpServerOptions {
  entry?: { node: string; script: string }
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export async function runAcpServer(opts: AcpServerOptions = {}): Promise<void> {
  const sessions = new Map<string, AcpSessionState>()

  const attachSession = (
    ctx: AgentContext,
    args: {
      cwd: string
      acpSessionId: string
      resumeSessionId?: string
      modeId?: string
      mcpServers?: unknown
    },
  ): AcpSessionState => {
    const acpSessionId = args.acpSessionId
    const state: AcpSessionState = {
      child: null as unknown as MercuryChildSession,
      cwd: args.cwd,
      modeId: args.modeId ?? 'default',
      turnResolve: null,
      cancelled: false,
      editorContext: null,
      toolNames: new Map(),
      planChain: Promise.resolve(),
      planEverSent: false,
      costTotalUsd: 0,
    }
    const emitPlan = (): void => {
      state.planChain = state.planChain
        .then(async () => {
          const listId = state.child.mercurySessionId ?? acpSessionId
          const entries = planEntriesOf(await listTasks(listId))
          if (entries.length === 0 && !state.planEverSent) return
          if (entries.length === 0 && !existsSync(getTasksDir(listId))) return
          state.planEverSent = true
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: { sessionUpdate: 'plan', entries },
          })
        })
        .catch(() => {
        })
    }
    const mcp = acpMcpServersToConfig(args.mcpServers)
    if (mcp && mcp.skipped.length > 0) {
      process.stderr.write(`[acp] mcpServers not carried (unsupported shape): ${mcp.skipped.join(', ')}\n`)
    }
    const child = new MercuryChildSession(
      {
        cwd: args.cwd,
        ...(args.resumeSessionId !== undefined
          ? { resumeSessionId: args.resumeSessionId }
          : { sessionId: acpSessionId }),
        permissionMode: args.modeId !== undefined ? decodeAcpModeId(args.modeId) : 'default',
        ...(opts.entry !== undefined && { entry: opts.entry }),
        ...(mcp !== null && { mcpConfig: mcp.json }),
      },
      {
        onInit: sessionId => {
          if (sessionId !== acpSessionId && !sessions.has(sessionId)) {
            sessions.set(sessionId, state)
          }
        },
        onAssistantText: text => {
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          })
        },
        onAssistantThought: text => {
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text },
            },
          })
        },
        onToolUse: (toolUseId, name, input) => {
          state.toolNames.set(toolUseId, name)
          const diffs = toolDiffsOf(name, input)
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: toolUseId,
              title: name,
              kind: toolKindOf(name),
              status: 'in_progress',
              rawInput: (input as Record<string, unknown>) ?? {},
              locations: toolLocationsOf(name, input),
              ...(diffs.length > 0 && { content: diffs.map(d => ({ type: 'diff' as const, ...d })) }),
            },
          })
        },
        onToolResult: (toolUseId, isError, output) => {
          const content = toolOutputContentOf(output)
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: toolUseId,
              status: isError ? 'failed' : 'completed',
              ...(content !== undefined && { content }),
            },
          })
          const name = state.toolNames.get(toolUseId)
          state.toolNames.delete(toolUseId)
          if (name !== undefined && TASK_PLAN_TOOLS.has(name) && !isError) emitPlan()
        },
        onUsage: (lastRoundTrip, model, turnCostUsd) => {
          if (turnCostUsd !== undefined) state.costTotalUsd += turnCostUsd
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'usage_update',
              ...usageWireOf(lastRoundTrip, model),
              ...(state.costTotalUsd > 0 && {
                cost: { amount: state.costTotalUsd, currency: 'USD' as const },
              }),
            },
          })
        },
        onTurnEnd: (outcome, detail) => {
          if (state.turnResolve) {
            const resolveTurn = state.turnResolve
            state.turnResolve = null
            resolveTurn(state.cancelled ? 'cancelled' : outcome, detail)
            state.cancelled = false
          }
        },
        onPermissionAsk: (requestId, ask) => {
          void (async () => {
            try {
              const result = await ctx.request(
                methods.client.session.requestPermission,
                permissionAskWire(ask, requestId, acpSessionId),
              )
              const allowed = permissionAllowedOf(result)
              child.answerPermission(requestId, allowed, { updatedInput: ask.input })
            } catch (e) {
              child.answerPermission(requestId, false, { message: `permission channel failed: ${e}` })
            }
          })()
        },
        onExit: code => {
          if (state.turnResolve) {
            const resolveTurn = state.turnResolve
            state.turnResolve = null
            resolveTurn('error', {
              subtype: 'child_exited',
              errors: [`the session process exited${code === null ? '' : ` (${code})`} mid-turn`],
            })
          }
          for (const [key, value] of sessions) {
            if (value === state) sessions.delete(key)
          }
        },
      },
    )
    state.child = child
    sessions.set(acpSessionId, state)
    return state
  }

  const modesFor = (modeId: string) => ({
    currentModeId: modeId,
    availableModes: PERMISSION_MODES.map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
    })),
  })

  const configOptionsFor = (modeId: string) => [
    {
      id: 'permission-mode',
      name: 'Permission mode',
      description: 'The Mercury permission ladder for this session',
      category: 'mode' as const,
      type: 'select' as const,
      currentValue: modeId,
      options: PERMISSION_MODES.map(m => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
  ]

  const notifyModeChanged = (ctx: AgentContext, sessionId: string, modeId: string): void => {
    void ctx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
    })
    void ctx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: configOptionsFor(modeId) },
    })
  }

  const app = agent({ name: 'mercury' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {} },
      },
      authMethods: [],
      agentInfo: { name: 'mercury', title: 'Mercury', version: MERCURY_VERSION },
    }))
    .onRequest('session/new', ctx => {
      const sessionId = randomUUID()
      attachSession(ctx.client, {
        cwd: ctx.params.cwd,
        acpSessionId: sessionId,
        mcpServers: ctx.params.mcpServers,
      })
      return {
        sessionId,
        modes: modesFor('default'),
        configOptions: configOptionsFor('default'),
      }
    })
    .onRequest('session/load', async ctx => {
      const requested = ctx.params.sessionId
      if (sessions.has(requested)) {
        const modeId = sessions.get(requested)!.modeId
        return { modes: modesFor(modeId), configOptions: configOptionsFor(modeId) }
      }
      if (!sessionIdExists(requested)) {
        throw new Error(`unknown session '${requested}' — no transcript exists for it here`)
      }
      attachSession(ctx.client, {
        cwd: ctx.params.cwd,
        acpSessionId: requested,
        resumeSessionId: requested,
        mcpServers: ctx.params.mcpServers,
      })
      try {
        const { messages } = await loadSessionFile(requested as UUID)
        for (const update of replayUpdatesOf(messages.values() as unknown as Iterable<Record<string, unknown>>)) {
          await ctx.client.notify(methods.client.session.update, {
            sessionId: requested,
            update: update as never,
          })
        }
      } catch (e) {
        process.stderr.write(`[acp] session/load replay skipped: ${e instanceof Error ? e.message : String(e)}\n`)
      }
      const modeId = sessions.get(requested)?.modeId ?? 'default'
      return { modes: modesFor(modeId), configOptions: configOptionsFor(modeId) }
    })
    .onRequest('session/list', async ctx => {
      const cursor = ctx.params?.cursor ? Number(ctx.params.cursor) : 0
      const limit = 50
      const all = await listSessionsImpl({ limit: cursor + limit + 1 })
      const page = all.slice(cursor, cursor + limit)
      return {
        sessions: page.map(s => {
          const raw = s as unknown as Record<string, unknown>
          return {
            sessionId: String(raw.sessionId ?? raw.id ?? ''),
            cwd: String(raw.cwd ?? raw.projectPath ?? ''),
            ...(typeof raw.summary === 'string' && raw.summary !== ''
              ? { title: raw.summary }
              : {}),
          }
        }),
        ...(all.length > cursor + limit ? { nextCursor: String(cursor + limit) } : {}),
      }
    })
    .onRequest('session/prompt', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (!state) {
        throw new Error(`unknown session '${ctx.params.sessionId}' — session/new or session/load first`)
      }
      if (state.turnResolve) {
        throw new Error('a prompt turn is already in flight for this session')
      }
      const editorResource = editorContextResource(state.editorContext)
      const blocks = composerDocumentBlocks(
        acpPromptToComposerDocument([
          ...(editorResource !== null ? [editorResource as unknown as Record<string, unknown>] : []),
          ...(ctx.params.prompt as unknown as Array<Record<string, unknown>>),
        ]),
      )
      state.cancelled = false
      const settled = await new Promise<{
        outcome: 'success' | 'error' | 'cancelled'
        detail: TurnEndDetail | undefined
      }>(resolve => {
        state.turnResolve = (outcome, detail) => resolve({ outcome, detail })
        try {
          state.child.writeUserPrompt(blocks)
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          process.stderr.write(`[acp] session/prompt failed to reach the child: ${why}\n`)
          state.turnResolve = null
          resolve({ outcome: 'error', detail: { subtype: 'prompt_undelivered', errors: [why] } })
        }
      })
      const verdict = stopReasonOf(settled.outcome, settled.detail)
      if ('error' in verdict) throw new Error(verdict.error)
      return { stopReason: verdict.stopReason }
    })
    .onRequest('session/set_mode', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (!state) throw new Error(`unknown session '${ctx.params.sessionId}'`)
      const modeId = decodeAcpModeId(ctx.params.modeId)
      if (!PERMISSION_MODES.some(m => m.id === modeId)) {
        throw new Error(`unknown mode '${modeId}' — modes: ${PERMISSION_MODES.map(m => m.id).join(', ')}`)
      }
      if (!(await state.child.setPermissionMode(modeId))) {
        throw new Error(`the session did not confirm mode '${modeId}' — state unchanged`)
      }
      state.modeId = modeId
      notifyModeChanged(ctx.client, ctx.params.sessionId, modeId)
      return {}
    })
    .onRequest('session/set_config_option', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (!state) throw new Error(`unknown session '${ctx.params.sessionId}'`)
      if (ctx.params.configId !== 'permission-mode') {
        throw new Error(`unknown config option '${ctx.params.configId}' — options: permission-mode`)
      }
      const value = typeof ctx.params.value === 'string' ? decodeAcpModeId(ctx.params.value) : ctx.params.value
      if (typeof value !== 'string' || !PERMISSION_MODES.some(m => m.id === value)) {
        throw new Error(
          `unknown permission-mode value '${String(value)}' — values: ${PERMISSION_MODES.map(m => m.id).join(', ')}`,
        )
      }
      if (!(await state.child.setPermissionMode(value))) {
        throw new Error(`the session did not confirm mode '${value}' — state unchanged`)
      }
      state.modeId = value
      notifyModeChanged(ctx.client, ctx.params.sessionId, value)
      return { configOptions: configOptionsFor(value) }
    })
    .onRequest('session/close', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (state) {
        if (state.turnResolve) {
          const resolveTurn = state.turnResolve
          state.turnResolve = null
          resolveTurn('cancelled')
        }
        await state.child.close()
        for (const [key, value] of sessions) {
          if (value === state) sessions.delete(key)
        }
      }
      return {}
    })
    .onNotification('session/cancel', ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (state && state.turnResolve) {
        state.cancelled = true
        state.child.interrupt()
      }
    })
    .onNotification('_mercury/editor_context', (v: unknown) => editorContextOf(v), ctx => {
      const wire = ctx.params
      if (wire === null) return
      const state = sessions.get(wire.sessionId)
      if (state) state.editorContext = wire
    })
    .onRequest('_mercury/workbench', (v: unknown) => (v ?? {}), async () => {
      const snap = await resolveWorkbenchSnapshot()
      if (!snap) {
        return {
          threads: [],
          lanes: [],
          missions: [],
          artifactHeads: [],
          unavailable: 'the workbench projection is disabled',
        }
      }
      return {
        generation: snap.generation,
        nextAction: snap.nextAction,
        attention: attentionWireFromSnapshot(snap),
        threads: [snap.root, ...snap.threads].map(t => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          phase: t.phase,
          state: t.state,
          ...(t.model !== undefined && { model: t.model }),
          ...(t.worktreePath !== undefined && { worktreePath: t.worktreePath }),
          ...(t.blocker !== undefined && { blocker: t.blocker }),
        })),
        lanes: snap.lanes,
        missions: snap.missions,
        artifactHeads: snap.artifactHeads,
        sources: snap.sources,
      }
    })
    .onRequest('_mercury/artifacts', (v: unknown) => (v ?? {}), () => {
      const src = listReviewArtifactHeadsSource({ root: getCwd() })
      return {
        heads: valueOr(src, []).map(h => ({
          id: h.id,
          kind: h.kind,
          title: h.title,
          latestVersion: h.latestVersion,
          status: h.status,
          openComments: h.openComments,
        })),
        source: healthOf(src),
      }
    })
    .onRequest('_mercury/crew', (v: unknown) => (v ?? {}), async () => {
      const { crewDirectoryEnabled } = await import('../crew/identity.js')
      if (!crewDirectoryEnabled()) {
        return {
          members: [],
          inbox: [],
          conversations: [],
          descriptors: [],
          unavailable: 'the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)',
        }
      }
      const [{ resolveCrewSnapshot }, conversationsMod, { deriveInbox }, descriptorMod, graphMod, identityMod] =
        await Promise.all([
          import('../crew/projection.js'),
          import('../crew/conversations.js'),
          import('../crew/inbox.js'),
          import('../crew/descriptor.js'),
          import('../crew/graph.js'),
          import('../../substrate/identity/identity.js'),
        ])
      const snap = await resolveCrewSnapshot()
      const operatorId = identityMod.operatorPrincipal().id
      const [conversations, cursors, descriptors, graph] = await Promise.all([
        conversationsMod.listConversations().catch(() => []),
        conversationsMod.listReadCursors(operatorId).catch(() => new Map<string, number>()),
        descriptorMod.listSessionDescriptors().catch(() => []),
        graphMod.assembleSessionGraph().catch(() => null),
      ])
      const inbox = deriveInbox(conversations, id => (cursors as Map<string, number>).get(id) ?? 0)
      const labels = new Map((snap?.members ?? []).map(m => [m.agentId as string, m.label]))
      const { foldScopeDecisions } = await import('../../utils/artifacts/reviewContracts.js')
      const folioSrc = listReviewArtifactHeadsSource({ root: getCwd() })
      const folioHeads = valueOr(folioSrc, []).slice(0, 40).map(h => {
        const state = readReviewArtifactState(h.id)
        const fold = state ? foldScopeDecisions(state.scopeDecisions, state.latestVersion) : null
        return {
          id: h.id,
          kind: h.kind,
          title: h.title,
          latestVersion: h.latestVersion,
          status: h.status,
          openComments: h.openComments,
          ...(fold
            ? {
                scopeFold: {
                  accepted: fold.accepted,
                  revisionRequested: fold.revisionRequested,
                  suggestion: fold.suggestion,
                },
              }
            : {}),
        }
      })
      return {
        members: (snap?.members ?? []).map(m => ({
          agentId: m.agentId,
          label: m.label,
          displayName: m.displayName,
          presence: m.presence,
          ...(m.lifecycle !== undefined ? { lifecycle: m.lifecycle } : {}),
          ...(m.focus !== undefined ? { focus: m.focus } : {}),
          ...(m.worktreeRef !== undefined ? { worktreeRef: m.worktreeRef } : {}),
          openSessions: m.sessions.filter(s => s.endedAt === undefined).length,
        })),
        sources: snap?.sources ?? null,
        inbox: inbox.map(r => ({
          conversationId: r.conversationId,
          bucket: r.bucket,
          title: r.title,
          kind: r.kind,
          unreadCount: r.unreadCount,
          resumeSeq: r.resumeSeq,
          updatedAt: r.updatedAt,
        })),
        conversations: conversations.slice(-100).map(c => ({
          conversationId: c.conversationId,
          kind: c.kind,
          title: c.title,
          lastEventSeq: c.lastEventSeq,
          readCursor: (cursors as Map<string, number>).get(c.conversationId) ?? 0,
          updatedAt: c.updatedAt,
        })),
        descriptors: descriptors.map(d => ({
          agentId: d.agentId,
          sessionId: d.sessionId,
          ...(d.missionRef !== undefined ? { missionRef: d.missionRef } : {}),
          ...(d.worktreeRef !== undefined ? { worktreeRef: d.worktreeRef } : {}),
          revision: d.revision,
          title: descriptorMod.renderSessionTitle({
            agentLabel: labels.get(d.agentId as string) ?? (d.agentId as string),
            ...(d.missionRef !== undefined ? { missionLabel: d.missionRef } : {}),
            ...(d.worktreeRef !== undefined ? { worktreeLabel: d.worktreeRef } : {}),
          }),
        })),
        ...(graph !== null ? { graph } : {}),
        folioHeads,
        folioSource: healthOf(folioSrc),
      }
    })
    .onRequest('_mercury/run', (v: unknown) => (v ?? {}), async ctx => {
      const asked = (ctx.params as { owner?: unknown } | null | undefined)?.owner
      let owner: OwnerKey
      if (asked === undefined) owner = processMainOwner()
      else if (isOwnerKey(asked)) owner = asked
      else return { error: 'malformed owner key' }
      let snap = getRunSnapshot(owner)
      if (snap === null) {
        try {
          const load = await loadRunSidecar(owner)
          if (load.state === 'loaded') snap = load.snapshot
          else if (load.state === 'unavailable') {
            return { unavailable: load.reason, retryable: load.retryable }
          }
        } catch {
        }
      }
      const revision = runRevision(owner)
      if (snap === null) return { run: null, revision }
      return {
        revision,
        run: {
          runId: snap.runId,
          objective: snap.objective,
          lifecycle: snap.lifecycle,
          phase: snap.phase,
          nextAction: snap.nextAction,
          totalChangedPaths: snap.totalChangedPaths,
          verification: snap.verification.state,
          ...(snap.blocker
            ? { blocker: { description: snap.blocker.description, ownedBy: snap.blocker.ownedBy } }
            : {}),
          ...(snap.modelState ? { model: snap.modelState } : {}),
        },
      }
    })
    .onRequest(
      '_mercury/artifact',
      (v: unknown) => {
        const id = (v as { id?: unknown } | null)?.id
        if (typeof id !== 'string') throw new Error('params.id (ra-…) required')
        return { id }
      },
      ctx => {
        const state = readReviewArtifactState(ctx.params.id)
        if (!state) throw new Error(`no review artifact '${ctx.params.id}'`)
        const latest = state.versions[state.versions.length - 1]!
        const lines: string[] = [
          `# ${state.title}`,
          '',
          `${state.kind} v${state.latestVersion} · ${state.statuses[state.latestVersion] ?? 'draft'}`,
          '',
        ]
        if ('markdown' in latest.body) lines.push(latest.body.markdown, '')
        if (latest.body.kind === 'diff') {
          for (const f of latest.body.files) lines.push(`- ${f.path} (${f.hunks.length} hunks)`)
          lines.push('')
        }
        if (state.comments.length > 0) {
          lines.push('## Comments', '')
          for (const c of state.comments) {
            lines.push(`- [${c.state}] ${c.author}: ${c.body}`)
          }
        }
        return {
          id: state.id,
          kind: state.kind,
          status: state.statuses[state.latestVersion] ?? 'draft',
          latestVersion: state.latestVersion,
          comments: state.comments,
          rendered: lines.join('\n'),
        }
      },
    )

  const input = Writable.toWeb(
    (opts.output ?? process.stdout) as NodeJS.WriteStream,
  ) as WritableStream<Uint8Array>
  const output = Readable.toWeb(
    (opts.input ?? process.stdin) as NodeJS.ReadStream,
  ) as ReadableStream<Uint8Array>
  const connection = app.connect(ndJsonStream(input, output))
  await connection.closed
  const closes: Promise<void>[] = []
  for (const state of new Set(sessions.values())) {
    if (state.turnResolve) {
      const resolveTurn = state.turnResolve
      state.turnResolve = null
      resolveTurn('cancelled')
    }
    closes.push(state.child.close())
  }
  await Promise.all(closes)
}
