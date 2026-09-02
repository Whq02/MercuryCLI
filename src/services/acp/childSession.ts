// ============================================================================
//  acp/childSession — one Mercury session behind the ACP server.
//
//  The ACP layer is an ADAPTER, never a second agent loop: each ACP session
//  drives Mercury through the SAME stream-json print-mode contract the
//  daemon uses for its own children (`-p --input-format=stream-json
//  --output-format=stream-json`, the exact self-invocation seam). Prompts
//  are user frames on stdin; events are NDJSON on stdout; permission asks
//  arrive as `can_use_tool` control requests (--permission-prompt-tool
//  stdio) and are answered by the ACP client's own request_permission.
//  Closing a session reaps EXACTLY this child — nothing else.
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

/** How a turn ended, beyond the outcome word: the result frame's own
 *  subtype, the last API stop reason it carried, and its error lines. */
export interface TurnEndDetail {
  subtype: string
  stopReason?: string
  errors: string[]
}

export interface ChildEventHandlers {
  onInit: (mercurySessionId: string) => void
  onAssistantText: (text: string) => void
  /** A thinking block from an assistant frame — the model's own reasoning
   *  text, which an editor renders as a thought, never as the reply. */
  onAssistantThought?: (text: string) => void
  onToolUse: (toolUseId: string, name: string, input: unknown) => void
  /** `content` is the tool result's text (its text blocks joined), absent
   *  when the result carried none. */
  onToolResult: (toolUseId: string, isError: boolean, content?: string) => void
  onTurnEnd: (outcome: 'success' | 'error' | 'cancelled', detail: TurnEndDetail) => void
  /** Context OCCUPANCY at turn end: the
   *  LAST API round-trip's usage — its input+cache tokens ARE the tokens in
   *  context (each round-trip carries the whole conversation), which the
   *  turn-cumulative result-frame sum is NOT (it re-counts the context per
   *  round-trip and reads >100% of the window on any multi-tool turn).
   *  `model` is that round-trip's served id. Fires ONLY when a real
   *  round-trip happened — an error turn with no API response emits
   *  nothing, never a fabricated zero. Cost is the result frame's own
   *  per-turn figure, passed only when reported. */
  onUsage?: (
    lastRoundTrip: Record<string, unknown>,
    model: string,
    turnCostUsd?: number,
  ) => void
  onPermissionAsk: (
    requestId: string,
    ask: {
      toolName: string
      toolUseId: string
      input: Record<string, unknown>
      description?: string
    },
  ) => void
  onExit: (code: number | null) => void
}

export interface SpawnChildOptions {
  cwd: string
  /** Pin the Mercury session id (fresh sessions — the 1:1 mapping seam). */
  sessionId?: string
  resumeSessionId?: string
  model?: string
  permissionMode?: string
  effort?: string
  /** Override the self-invocation (proofs point at the built bundle). */
  entry?: { node: string; script: string }
  env?: Record<string, string>
  /** An inline `--mcp-config` document (`{"mcpServers":{…}}`) — the MCP
   *  servers the editor client asked this session to carry. */
  mcpConfig?: string
}

let controlSeq = 0

/** The text a tool_result block carries: a bare string, or its text blocks
 *  joined; undefined when it carried no text at all (image-only results). */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = (content as Array<Record<string, unknown>>)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
  return texts.length > 0 ? texts.join('\n') : undefined
}

export class MercuryChildSession {
  readonly child: ChildProcess
  readonly cwd: string
  mercurySessionId: string | null = null
  private buffer = ''
  private readonly handlers: ChildEventHandlers
  private closedByUs = false
  /** oversized-line resync flag — see onData. */
  private discardingOversizedLine = false
  private static readonly MAX_LINE_BUFFER_BYTES = 32 * 1024 * 1024

  constructor(opts: SpawnChildOptions, handlers: ChildEventHandlers) {
    this.handlers = handlers
    this.cwd = opts.cwd
    const node = opts.entry?.node ?? process.execPath
    const script = opts.entry?.script ?? process.argv[1] ?? ''
    const argv = [
      script,
      '-p',
      '--verbose',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--permission-prompt-tool',
      'stdio',
      ...(opts.permissionMode ? ['--permission-mode', opts.permissionMode] : []),
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
      ...(opts.sessionId && !opts.resumeSessionId ? ['--session-id', opts.sessionId] : []),
      ...(opts.mcpConfig ? ['--mcp-config', opts.mcpConfig] : []),
    ]
    const env: NodeJS.ProcessEnv = {
      // child-env law: raw base by design — the child IS a Mercury session
      // (its own subprocessEnv scrubs ITS children).
      ...process.env,
      // ACP clients read plans from the task owner, and the
      // task tools resolve OFF under -p by default — the registered spelling
      // turns them on for exactly this child. An operator's OWN explicit
      // value is respected, never overridden (wave-C review).
      MERCURY_TASKS: process.env.MERCURY_TASKS ?? '1',
      // Pin the child's task list to the id the ACP server reads plans
      // from — ambient team/task-list context must not fork the two sides
      // onto different lists (wave-C review: getTaskListId's precedence).
      MERCURY_TASK_LIST_ID: opts.resumeSessionId ?? opts.sessionId ?? '',
      ...(opts.env ?? {}),
      ...(opts.effort ? { MERCURY_EFFORT_LEVEL: opts.effort } : {}),
    }
    // THE NON-SESSION-ESTATE INSULATION (the kit one-law):
    // an ACP child is a full runner and would LATCH a stray session-kit
    // spelling inherited through `...process.env` — an IDE-hosted session
    // must never wear a kit nobody stamped on it. Strip both flag
    // spellings AFTER every overlay: no ACP caller stamps one on purpose
    // (an explicit opts.env kit would be a bug upstream, not a contract).
    for (const spelling of flagSpellings('MERCURY_SESSION_KIT')) delete env[spelling]
    this.child = spawn(node, argv, {
      windowsHide: true,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    this.child.on('exit', code => {
      this.dead = true
      if (!this.closedByUs) this.handlers.onExit(code)
    })
    // An unhandled 'error' (spawn ENOENT, EPIPE on a dead pipe) would crash
    // the WHOLE ACP server — every session, not just this one. Both the
    // process and its stdin get listeners; writes are guarded below.
    this.child.on('error', err => {
      this.dead = true
      logForDebugging(`[acp] child error: ${err}`)
      if (!this.closedByUs) this.handlers.onExit(null)
    })
    this.child.stdin?.on('error', err => {
      logForDebugging(`[acp] child stdin error (write after death?): ${err}`)
    })
  }

  private dead = false
  /** The most recent API round-trip's usage + served model (occupancy). */
  private lastRoundTripUsage: Record<string, unknown> | null = null
  private lastRoundTripModel = ''
  /** Pending acks for control requests we sent (mode changes). */
  private readonly controlWaiters = new Map<string, (ok: boolean) => void>()

  /** Write one NDJSON frame to the child. Returns false when the frame could
   *  NOT be delivered (dead/closed child, write failure) — control-frame
   *  callers treat that as a no-op, but the PROMPT path must surface it: a
   *  silently dropped prompt leaves the ACP turn promise parked forever (the
   *  settlement class — LANE ACP). */
  private writeFrame(frame: string): boolean {
    if (this.dead || this.closedByUs) return false
    try {
      this.child.stdin?.write(frame + '\n')
      return true
    } catch (e) {
      logForDebugging(`[acp] frame write failed: ${e}`)
      return false
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (this.discardingOversizedLine) {
        // This newline terminates the oversized line — resync from here.
        this.discardingOversizedLine = false
        logForDebugging(
          `[acp] dropped an oversized stdout line (> ${MercuryChildSession.MAX_LINE_BUFFER_BYTES} bytes buffered) — resynced at the next newline`,
        )
      } else if (line !== '') {
        this.onLine(line)
      }
      idx = this.buffer.indexOf('\n')
    }
    // single stream-json lines legitimately carry whole
    // tool_results, so the cap is generous — but past it the line cannot be
    // a valid frame. Drop it and resync at the next newline (the ndjsonChild
    // exemplar's bound at editor-bridge scale) instead of growing the heap
    // without limit.
    if (!this.discardingOversizedLine && this.buffer.length > MercuryChildSession.MAX_LINE_BUFFER_BYTES) {
      this.discardingOversizedLine = true
      this.buffer = ''
    } else if (this.discardingOversizedLine) {
      this.buffer = ''
    }
  }

  private onLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return // non-JSON stdout is not part of the contract; ignore
    }
    const type = frame.type
    if (type === 'system') {
      const sid = frame.session_id
      if (frame.subtype === 'init' && typeof sid === 'string' && !this.mercurySessionId) {
        this.mercurySessionId = sid
        this.handlers.onInit(sid)
      }
      return
    }
    if (type === 'assistant') {
      const message = frame.message as {
        content?: unknown
        usage?: unknown
        model?: unknown
      } | undefined
      // Each assistant frame is one API round-trip; its usage is the honest
      // occupancy signal the result frame's cumulative sum is not. SYNTHETIC
      // assistant frames (local command output, placeholders) carry an
      // all-zero usage — a real API response always bills ≥1 input token,
      // so only a non-zero round-trip may record (found live: a trailing
      // synthetic frame zeroed the occupancy of every tool turn).
      if (message?.usage !== null && typeof message?.usage === 'object') {
        const u = message.usage as Record<string, unknown>
        const sum = [
          'input_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
          'output_tokens',
        ].reduce((n, k) => n + (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0), 0)
        if (sum > 0) {
          this.lastRoundTripUsage = u
          if (typeof message.model === 'string') this.lastRoundTripModel = message.model
        }
      }
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          this.handlers.onAssistantText(block.text)
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
          this.handlers.onAssistantThought?.(block.thinking)
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          this.handlers.onToolUse(block.id, String(block.name ?? 'tool'), block.input)
        }
      }
      return
    }
    if (type === 'user') {
      const message = frame.message as { content?: unknown } | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          this.handlers.onToolResult(block.tool_use_id, block.is_error === true, toolResultText(block.content))
        }
      }
      return
    }
    if (type === 'result') {
      // Before onTurnEnd, so the usage notification is enqueued ahead of
      // the prompt response settling on the ACP side. Only a turn that made
      // a real API round-trip reports — nothing is fabricated for errors.
      if (this.lastRoundTripUsage !== null) {
        this.handlers.onUsage?.(
          this.lastRoundTripUsage,
          this.lastRoundTripModel,
          typeof frame.total_cost_usd === 'number' ? frame.total_cost_usd : undefined,
        )
        this.lastRoundTripUsage = null
      }
      const subtype = String(frame.subtype ?? 'success')
      const errors = Array.isArray(frame.errors)
        ? (frame.errors as unknown[]).filter((e): e is string => typeof e === 'string')
        : []
      this.handlers.onTurnEnd(
        subtype === 'success' ? 'success' : subtype.includes('interrupt') ? 'cancelled' : 'error',
        {
          subtype,
          ...(typeof frame.stop_reason === 'string' ? { stopReason: frame.stop_reason } : {}),
          errors,
        },
      )
      return
    }
    if (type === 'control_request') {
      const requestId = String(frame.request_id ?? '')
      const request = frame.request as Record<string, unknown> | undefined
      if (request?.subtype === 'can_use_tool') {
        this.handlers.onPermissionAsk(requestId, {
          toolName: String(request.tool_name ?? 'tool'),
          toolUseId: String(request.tool_use_id ?? ''),
          input: (request.input as Record<string, unknown>) ?? {},
          ...(typeof request.description === 'string' && { description: request.description }),
        })
      }
      return
    }
    if (type === 'control_response') {
      // The child's answer to a control request WE sent (mode changes ride
      // this — wave-C review: a mode commit must never be optimistic).
      const response = frame.response as
        | { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown }
        | undefined
      const requestId = String(response?.request_id ?? '')
      const waiter = this.controlWaiters.get(requestId)
      if (waiter) {
        this.controlWaiters.delete(requestId)
        waiter(response?.subtype === 'success')
      }
      return
    }
  }

  /** Throws when the prompt frame was not delivered (dead/closed child or a
   *  failed pipe write): the ACP server's session/prompt handler settles the
   *  turn as an error on that throw — never a parked promise. */
  writeUserPrompt(content: Array<Record<string, unknown>>): void {
    const delivered = this.writeFrame(
      JSON.stringify({ type: 'user', message: { role: 'user', content } }),
    )
    if (!delivered) {
      throw new Error(
        `the session child is ${this.dead ? 'dead' : this.closedByUs ? 'closed' : 'unwritable'} — prompt not delivered`,
      )
    }
  }

  answerPermission(
    requestId: string,
    allow: boolean,
    opts?: { updatedInput?: Record<string, unknown>; message?: string },
  ): void {
    const frame = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? // The allow schema REQUIRES updatedInput (the tool's input,
            // possibly edited by the client) — an absent field fails
            // validation and silently degrades to deny.
            { behavior: 'allow', updatedInput: opts?.updatedInput ?? {} }
          : { behavior: 'deny', message: opts?.message ?? 'denied by the ACP client' },
      },
    })
    this.writeFrame(frame)
  }

  sendControl(request: Record<string, unknown>): string {
    const requestId = `acp-${++controlSeq}`
    this.writeFrame(JSON.stringify({ type: 'control_request', request_id: requestId, request }))
    return requestId
  }

  /** Send a control request and await the child's own ack (bounded). False
   *  = refused, dead, or silent past the deadline — the CALLER must not
   *  commit state the child never confirmed (wave-C review: the optimistic
   *  mode commit). */
  sendControlAcked(request: Record<string, unknown>, timeoutMs = 5000): Promise<boolean> {
    if (this.dead || this.closedByUs) return Promise.resolve(false)
    const requestId = this.sendControl(request)
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(requestId)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.controlWaiters.set(requestId, ok => {
        clearTimeout(timer)
        resolve(ok)
      })
    })
  }

  interrupt(): void {
    this.sendControl({ subtype: 'interrupt' })
  }

  setPermissionMode(mode: string): Promise<boolean> {
    return this.sendControlAcked({ subtype: 'set_permission_mode', mode })
  }

  setModel(model: string): void {
    this.sendControl({ subtype: 'set_model', model })
  }

  /** Reap EXACTLY this child.: SIGTERM → grace →
   *  SIGKILL, resolving at the child's real exit (bounded) — the old single
   *  fire-and-forget SIGTERM with closedByUs suppressing onExit meant no
   *  caller ever learned a child survived. Awaited by session/close and the
   *  server's shutdown sweep (the MCP kill-ladder law at this owner). */
  close(graceMs = 1_500): Promise<void> {
    this.closedByUs = true
    try {
      this.child.stdin?.end()
    } catch {
      /* already gone */
    }
    if (this.dead) return Promise.resolve()
    return new Promise<void>(resolve => {
      let escalation: NodeJS.Timeout | null = null
      let hardBound: NodeJS.Timeout | null = null
      const finish = (): void => {
        if (escalation) clearTimeout(escalation)
        if (hardBound) clearTimeout(hardBound)
        resolve()
      }
      this.child.once('exit', finish)
      try {
        this.child.kill('SIGTERM')
      } catch (e) {
        logForDebugging(`[acp] child kill failed (already dead?): ${e}`)
      }
      escalation = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, graceMs)
      escalation.unref?.()
      // Never hang a shutdown sweep on an unkillable child — resolve after
      // the escalation had its own grace to land, and SAY so.
      hardBound = setTimeout(() => {
        this.child.removeListener('exit', finish)
        logForDebugging('[acp] child survived close() escalation (unkillable?) — resolving bounded')
        finish()
      }, graceMs + 1_500)
      hardBound.unref?.()
    })
  }
}
