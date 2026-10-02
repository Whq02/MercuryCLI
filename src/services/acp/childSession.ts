
import { spawn, type ChildProcess } from 'node:child_process'
import { selfScriptPath } from '../../daemon/daemonBuild.js'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { parseRunnerLine } from '../../daemon/longLivedSupervisor.js'
import type { LooseRow } from '../../rows/read.js'

export interface TurnEndDetail {
  status: string
  stopReason?: string
  errors: string[]
}

export interface ChildEventHandlers {
  onInit: (mercurySessionId: string) => void
  onAssistantText: (text: string) => void
  onAssistantThought?: (text: string) => void
  onToolUse: (toolUseId: string, name: string, input: unknown) => void
  onToolResult: (toolUseId: string, isError: boolean, content?: string) => void
  onToolProgress?: (parentToolUseId: string, text: string) => void
  onMode?: (mode: string) => void
  onTurnEnd: (outcome: 'success' | 'error' | 'cancelled', detail: TurnEndDetail) => void
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
  sessionId?: string
  resumeSessionId?: string
  model?: string
  permissionMode?: string
  effort?: string
  entry?: { node: string; script: string }
  env?: Record<string, string>
  mcpConfig?: string
}

let controlSeq = 0

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
  private discardingOversizedLine = false
  private static readonly MAX_LINE_BUFFER_BYTES = 32 * 1024 * 1024

  constructor(opts: SpawnChildOptions, handlers: ChildEventHandlers) {
    this.handlers = handlers
    this.cwd = opts.cwd
    const node = opts.entry?.node ?? process.execPath
    const script = opts.entry?.script ?? selfScriptPath()
    const argv = [
      script,
      'run',
      '--input=rows',
      '--format=rows',
      '--permission-channel',
      'stdio',
      ...(opts.permissionMode ? ['--mode', opts.permissionMode] : []),
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
      ...(opts.sessionId && !opts.resumeSessionId ? ['--session-id', opts.sessionId] : []),
      ...(opts.mcpConfig ? ['--mcp', opts.mcpConfig] : []),
    ]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_TASKS: process.env.MERCURY_TASKS ?? '1',
      MERCURY_TASK_LIST_ID: opts.resumeSessionId ?? opts.sessionId ?? '',
      ...(opts.env ?? {}),
      ...(opts.effort ? { MERCURY_EFFORT_LEVEL: opts.effort } : {}),
    }
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
  private lastRoundTripUsage: Record<string, unknown> | null = null
  private lastRoundTripModel = ''
  private readonly controlWaiters = new Map<string, (ok: boolean) => void>()

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
        this.discardingOversizedLine = false
        logForDebugging(
          `[acp] dropped an oversized stdout line (> ${MercuryChildSession.MAX_LINE_BUFFER_BYTES} bytes buffered) — resynced at the next newline`,
        )
      } else if (line !== '') {
        this.onLine(line)
      }
      idx = this.buffer.indexOf('\n')
    }
    if (!this.discardingOversizedLine && this.buffer.length > MercuryChildSession.MAX_LINE_BUFFER_BYTES) {
      this.discardingOversizedLine = true
      this.buffer = ''
    } else if (this.discardingOversizedLine) {
      this.buffer = ''
    }
  }

  private onLine(line: string): void {
    const row = parseRunnerLine(line)
    if (row === null) return
    this.onRow(row)
  }

  private onRow(row: LooseRow): void {
    const tagged = typeof row.parent_call_id === 'string' ? row.parent_call_id : null
    switch (row.type) {
      case 'session': {
        const sid = row.session_id
        if (typeof sid === 'string' && !this.mercurySessionId) {
          this.mercurySessionId = sid
          this.handlers.onInit(sid)
        }
        return
      }
      case 'text': {
        const text = typeof row.text === 'string' ? row.text : ''
        if (text === '') return
        if (tagged !== null) this.handlers.onToolProgress?.(tagged, text)
        else this.handlers.onAssistantText(text)
        return
      }
      case 'command_output': {
        if (tagged === null && typeof row.text === 'string' && row.text !== '') this.handlers.onAssistantText(row.text)
        return
      }
      case 'reasoning': {
        if (tagged !== null) return
        if (typeof row.text === 'string' && row.text !== '') this.handlers.onAssistantThought?.(row.text)
        return
      }
      case 'tool_call': {
        if (tagged !== null) return
        if (typeof row.call_id === 'string') this.handlers.onToolUse(row.call_id, String(row.tool ?? 'tool'), row.input)
        return
      }
      case 'tool_result': {
        if (tagged !== null) return
        if (typeof row.call_id === 'string') this.handlers.onToolResult(row.call_id, row.status !== 'ok', typeof row.output === 'string' && row.output !== '' ? row.output : undefined)
        return
      }
      case 'step': {
        if (tagged !== null) return
        const usage = row.usage
        if (usage !== null && typeof usage === 'object') {
          const u = usage as Record<string, unknown>
          const sum = ['input_tokens', 'output_tokens'].reduce((n, k) => n + (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0), 0)
          if (sum > 0) {
            this.lastRoundTripUsage = u
            if (typeof row.model === 'string') this.lastRoundTripModel = row.model
          }
        }
        return
      }
      case 'mode': {
        if (typeof row.mode === 'string') this.handlers.onMode?.(row.mode)
        return
      }
      case 'outcome': {
        if (this.lastRoundTripUsage !== null) {
          this.handlers.onUsage?.(this.lastRoundTripUsage, this.lastRoundTripModel, typeof row.cost_usd === 'number' ? row.cost_usd : undefined)
          this.lastRoundTripUsage = null
        }
        const status = String(row.status ?? 'failed')
        const error = row.error as { message?: unknown; detail?: unknown } | undefined
        const errors = [
          ...(typeof error?.message === 'string' ? [error.message] : []),
          ...(Array.isArray(error?.detail) ? (error.detail as unknown[]).filter((e): e is string => typeof e === 'string') : []),
        ]
        this.handlers.onTurnEnd(status === 'completed' ? 'success' : status === 'interrupted' ? 'cancelled' : 'error', {
          status,
          ...(typeof row.stop === 'string' ? { stopReason: row.stop } : {}),
          errors,
        })
        return
      }
      case 'control_request': {
        const requestId = String(row.request_id ?? '')
        const request = row.request as Record<string, unknown> | undefined
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
      case 'control_response': {
        const response = row.response as { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } | undefined
        const requestId = String(response?.request_id ?? '')
        const waiter = this.controlWaiters.get(requestId)
        if (waiter) {
          this.controlWaiters.delete(requestId)
          waiter(response?.subtype === 'success')
        }
        return
      }
      default:
        return
    }
  }

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
          ?
            { behavior: 'allow', updated_input: opts?.updatedInput ?? {} }
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

  close(graceMs = 1_500): Promise<void> {
    this.closedByUs = true
    try {
      this.child.stdin?.end()
    } catch {
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
        }
      }, graceMs)
      escalation.unref?.()
      hardBound = setTimeout(() => {
        this.child.removeListener('exit', finish)
        logForDebugging('[acp] child survived close() escalation (unkillable?) — resolving bounded')
        finish()
      }, graceMs + 1_500)
      hardBound.unref?.()
    })
  }
}
