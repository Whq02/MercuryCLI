import { connect, type MercurySession, type PermissionHandler } from '../../../sdk/src/runner.js'
import type { PermissionMode } from '../../../sdk/src/door.js'
import type { ParamsOf } from '../../../sdk/src/wire.js'
import type { RunOptions } from '../../../sdk/src/client.js'

export type AutomationRun = { prompt: string; session_id?: string; title?: string; model?: string; mode?: PermissionMode }
export type AutomationOptions = Pick<RunOptions, 'mercury' | 'cwd' | 'env' | 'model' | 'mode' | 'allowSovereign' | 'effort'>
const RESULT_CHARS = 100_000

type Session = { session: MercurySession; mode: PermissionMode; permission?: PermissionHandler; busy: boolean }

export function boundedRows(rows: readonly unknown[], limit = 50, before = rows.length): Record<string, unknown> {
  const end = Math.min(before, rows.length)
  let start = end
  let chars = 0
  while (start > 0 && end - start < limit) {
    const size = JSON.stringify(rows[start - 1]).length
    if (chars + size > RESULT_CHARS && start < end) break
    if (size > RESULT_CHARS) return { rows: [], total: rows.length, next_before: start - 1, oversized_row: start - 1 }
    chars += size
    start--
  }
  return { rows: rows.slice(start, end), total: rows.length, ...(start > 0 ? { next_before: start } : {}) }
}

export class AutomationBridge {
  private reader?: Promise<MercurySession>
  private sessions = new Map<string, Session>()
  private opening = new Set<Promise<MercurySession>>()
  private resuming = new Set<string>()
  private closed = false

  constructor(private readonly options: AutomationOptions) {}

  private async open(options: Parameters<typeof connect>[0]): Promise<MercurySession> {
    if (this.closed) throw new Error('The MCP server is closing')
    const pending = connect({ ...this.options, ...options })
    this.opening.add(pending)
    try { return await pending } finally { this.opening.delete(pending) }
  }

  async query(input: ParamsOf<'project/query'>): Promise<Record<string, unknown>> {
    if (input.op === 'rows' && input.session_id) {
      const live = this.sessions.get(input.session_id)
      if (live) return { session_id: input.session_id, ...boundedRows(live.session.rows, input.limit, input.before), source: 'stream' }
    }
    if (input.op === 'send' && input.session_id) {
      const live = this.sessions.get(input.session_id)
      if (live) {
        if (!input.sender?.trim() || !input.message?.trim()) throw new Error('sender and message are required')
        const accepted = await live.session.sendPrompt(`From ${JSON.stringify(input.sender)} (MCP):\n${input.message}`, { id: input.message_id })
        return { ...accepted, session_id: input.session_id }
      }
    }
    this.reader ??= this.open({ ephemeral: true, mode: 'dontAsk', host: { name: 'mercury-mcp-reader', version: '1' } }).catch(error => { this.reader = undefined; throw error })
    const result = await (await this.reader).request('project/query', input)
    if (input.op === 'rows' && Array.isArray(result.rows)) {
      const page = boundedRows(result.rows, input.limit)
      const base = Number(result.next_before ?? 0)
      return { ...result, ...page, total: result.total, next_before: page.next_before === undefined ? result.next_before : base + Number(page.next_before), source: 'transcript' }
    }
    if (input.op === 'sessions' && Array.isArray(result.sessions)) return { sessions: result.sessions.map(row => ({ ...row, ...(this.sessions.has(row.session_id) ? { live: true, mode: this.sessions.get(row.session_id)!.mode } : {}) })) }
    return result
  }

  async run(input: AutomationRun, onPermissionRequest: PermissionHandler, signal: AbortSignal): Promise<Record<string, unknown>> {
    const mode = input.mode ?? this.options.mode ?? 'default'
    if (mode !== (this.options.mode ?? 'default')) throw new Error(`This server runs sessions in ${this.options.mode ?? 'default'} mode; change the server's --mode to choose another`)
    let held = input.session_id ? this.sessions.get(input.session_id) : undefined
    if (held?.busy || (input.session_id && this.resuming.has(input.session_id))) throw new Error('This session is running; use mercury_send')
    if (input.session_id) this.resuming.add(input.session_id)
    try {
      if (!held) {
        if (input.session_id) {
          const saved = await this.query({ op: 'sessions' })
          const previous = (saved.sessions as Array<{ session_id: string; live: boolean; mode?: string }>).find(row => row.session_id === input.session_id)
          if (!previous) throw new Error('No saved session with that id in this project')
          if (previous.live) throw new Error('This session is live; use mercury_send')
          if (previous.mode !== undefined && previous.mode !== mode) throw new Error(`The session uses ${previous.mode} mode; its permission mode is not changed by MCP`)
        }
        const entry: Partial<Session> = { mode, permission: onPermissionRequest, busy: true }
        const session = await this.open({
          ...(input.session_id ? { resume: input.session_id } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.model ? { model: input.model } : {}),
          mode,
          onPermissionRequest: (params, request) => entry.permission?.(params, request) ?? { outcome: 'deny', message: 'No MCP call is waiting to answer this session’s permission request' },
          host: { name: 'mercury-mcp', version: '1' },
        })
        entry.session = session
        held = entry as Session
        this.sessions.set(session.sessionId!, held)
        void session.exit.then(() => this.sessions.delete(session.sessionId!))
      } else if (input.model) await held.session.setModel(input.model)
      held.busy = true
      held.permission = onPermissionRequest
      const outcome = await held.session.prompt(input.prompt, { signal, interruptOnAbort: true })
      return { session_id: held.session.sessionId, ...boundedRows(held.session.rows, held.session.rows.length), status: outcome.status, source: 'stream' }
    } finally {
      if (input.session_id) this.resuming.delete(input.session_id)
      if (held) { held.busy = false; held.permission = undefined }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const opening = await Promise.allSettled(this.opening)
    const sessions = new Set([...this.sessions.values()].map(entry => entry.session))
    for (const row of opening) if (row.status === 'fulfilled') sessions.add(row.value)
    if (this.reader) try { sessions.add(await this.reader) } catch {}
    await Promise.all([...sessions].map(session => session.close()))
    this.sessions.clear()
  }
}
