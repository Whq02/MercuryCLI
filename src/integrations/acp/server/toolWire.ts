import type { TaskStatus } from '../../../engine/task-framework/tasks.js'
import { readFileSync } from 'node:fs'
import { getContextWindowForModel } from '../../../models/facts/capabilities.js'
import type { TurnEndDetail } from '../childSession.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

type AcpToolKind =
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
  ReadMcpResource: 'read',
  ListMcpResources: 'read',
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
  Debug: 'execute',
  Launch: 'execute',
  Test: 'execute',
  Eval: 'execute',
  Crewmate: 'think',
  Task: 'think',
  TaskCreate: 'think',
  TaskUpdate: 'think',
  TaskGet: 'think',
  TaskList: 'think',
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

interface AcpDiff {
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
  } catch (error) {
    passedOver(error)
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


type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

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
  if (detail?.status === 'turn_limit') return { stopReason: 'max_turn_requests' }
  const why = detail?.errors.filter(e => e.trim() !== '').join('; ')
  return {
    error: `the session turn failed${detail ? ` (${detail.status})` : ''}${why ? `: ${why}` : ''}`,
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
  const used = n('input_tokens') + n('output_tokens')
  return { used, size: getContextWindowForModel(model) }
}
