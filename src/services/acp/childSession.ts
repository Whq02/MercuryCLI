import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { selfScriptPath } from '../../daemon/daemonBuild.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import type { LooseRow } from '../../rows/read.js'
import type { ElicitationAnswer, ElicitationRequestParams, ParamsOf, PermissionAnswer, PermissionRequestParams, ResultOf } from '../../runner/wire/methods.js'
import { createPeer, PeerClosed, type Peer } from '../../runner/wire/peer.js'
import type { RpcError } from '../../runner/wire/errors.js'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

export interface TurnEndDetail {
  status: string
  stopReason?: string
  errors: string[]
}

export type ToolAsk = PermissionRequestParams

interface ChildEventHandlers {
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

  onPermissionAsk: (requestId: number, ask: ToolAsk, withdrawn: AbortSignal) => Promise<PermissionAnswer>

  onElicitation?: (params: ElicitationRequestParams, withdrawn: AbortSignal) => Promise<ElicitationAnswer>
  onElicitationComplete?: (server: string, elicitationId: string) => void
  onReadTextFile?: (params: ParamsOf<'fs/read_text_file'>, withdrawn: AbortSignal) => Promise<ResultOf<'fs/read_text_file'>>
  onWriteTextFile?: (params: ParamsOf<'fs/write_text_file'>, withdrawn: AbortSignal) => Promise<ResultOf<'fs/write_text_file'>>
  onTerminalCreate?: (params: ParamsOf<'terminal/create'>, withdrawn: AbortSignal) => Promise<ResultOf<'terminal/create'>>
  onTerminalOutput?: (params: ParamsOf<'terminal/output'>, withdrawn: AbortSignal) => Promise<ResultOf<'terminal/output'>>
  onTerminalWaitForExit?: (params: ParamsOf<'terminal/wait_for_exit'>, withdrawn: AbortSignal) => Promise<ResultOf<'terminal/wait_for_exit'>>
  onTerminalKill?: (params: ParamsOf<'terminal/kill'>, withdrawn: AbortSignal) => Promise<ResultOf<'terminal/kill'>>
  onTerminalRelease?: (params: ParamsOf<'terminal/release'>, withdrawn: AbortSignal) => Promise<ResultOf<'terminal/release'>>
  onExit: (code: number | null) => void
}

interface SpawnChildOptions {
  cwd: string

  sessionId?: string
  resumeSessionId?: string
  model?: string
  permissionMode?: string

  allowSovereign?: boolean
  effort?: string

  entry?: { node: string; script: string }
  env?: Record<string, string>

  mcpConfig?: string

  elicitation?: boolean
  fsReadTextFile?: boolean
  fsWriteTextFile?: boolean
  terminal?: boolean
}

const INITIALIZE_DEADLINE_MS = 120_000

export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = (content as Array<Record<string, unknown>>)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
  return texts.length > 0 ? texts.join('\n') : undefined
}

function inputBlocksOf(blocks: ReadonlyArray<Record<string, unknown>>): Array<{ type: 'text'; text: string } | { type: 'image'; media_type: string; data: string }> {
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; media_type: string; data: string }> = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const source = block.source as { media_type?: unknown; data?: unknown } | undefined
      const mediaType = source?.media_type ?? block.media_type
      const data = source?.data ?? block.data
      if (typeof mediaType === 'string' && typeof data === 'string') out.push({ type: 'image', media_type: mediaType, data })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

const IDLE_EXIT_MS = 20_000

export class MercuryChildSession {
  readonly child: ChildProcess
  readonly cwd: string
  readonly peer: Peer

  readonly initialized: Promise<string | null>
  mercurySessionId: string | null = null
  private readonly handlers: ChildEventHandlers
  private closedByUs = false
  private dead = false
  private protocolFailure: RpcError | null = null
  private queuedPromptId: string | null = null
  private turnOpen = false
  private interruptWhenTurnOpens = false

  private lastRoundTripUsage: Record<string, unknown> | null = null
  private lastRoundTripModel = ''

  constructor(opts: SpawnChildOptions, handlers: ChildEventHandlers) {
    this.handlers = handlers
    this.cwd = opts.cwd
    const node = opts.entry?.node ?? process.execPath
    const script = opts.entry?.script ?? selfScriptPath()
    const argv = [
      script,
      'runner',
      ...(opts.permissionMode ? ['--mode', opts.permissionMode] : []),
      ...(opts.allowSovereign === true ? ['--allow-sovereign'] : []),
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
    const peerOptions = {
      input: this.child.stdout!,
      output: this.child.stdin!,
      side: 'host' as const,
      log: (line: string) => logForDebugging(`[acp] ${line}`),
      onProtocolError: (error: RpcError): void => {
        this.protocolFailure = error
        this.handlers.onTurnEnd('error', { status: 'protocol_error', errors: [error.message] })
        void this.close()
      },
    }
    this.peer = createPeer(peerOptions)
    this.peer.onNotification('row', row => this.onRow(row as LooseRow))
    this.peer.onNotification('elicitation/complete', params => this.handlers.onElicitationComplete?.(params.server, params.elicitation_id))
    this.peer.onRequest('permission/request', (params, ctx) => this.handlers.onPermissionAsk(ctx.id, params, ctx.signal))
    this.peer.onRequest('elicitation/request', (params, ctx) => {
      const ask = this.handlers.onElicitation
      if (ask === undefined) return { action: 'cancel' }
      return ask(params, ctx.signal)
    })
    this.peer.onRequest('fs/read_text_file', (params, ctx) => {
      if (!this.handlers.onReadTextFile) throw new Error('fs/read_text_file is not supported by this ACP client')
      return this.handlers.onReadTextFile(params, ctx.signal)
    })
    this.peer.onRequest('fs/write_text_file', (params, ctx) => {
      if (!this.handlers.onWriteTextFile) throw new Error('fs/write_text_file is not supported by this ACP client')
      return this.handlers.onWriteTextFile(params, ctx.signal)
    })
    this.peer.onRequest('terminal/create', (params, ctx) => {
      if (!this.handlers.onTerminalCreate) throw new Error('terminal/create is not supported by this ACP client')
      return this.handlers.onTerminalCreate(params, ctx.signal)
    })
    this.peer.onRequest('terminal/output', (params, ctx) => {
      if (!this.handlers.onTerminalOutput) throw new Error('terminal/output is not supported by this ACP client')
      return this.handlers.onTerminalOutput(params, ctx.signal)
    })
    this.peer.onRequest('terminal/wait_for_exit', (params, ctx) => {
      if (!this.handlers.onTerminalWaitForExit) throw new Error('terminal/wait_for_exit is not supported by this ACP client')
      return this.handlers.onTerminalWaitForExit(params, ctx.signal)
    })
    this.peer.onRequest('terminal/kill', (params, ctx) => {
      if (!this.handlers.onTerminalKill) throw new Error('terminal/kill is not supported by this ACP client')
      return this.handlers.onTerminalKill(params, ctx.signal)
    })
    this.peer.onRequest('terminal/release', (params, ctx) => {
      if (!this.handlers.onTerminalRelease) throw new Error('terminal/release is not supported by this ACP client')
      return this.handlers.onTerminalRelease(params, ctx.signal)
    })
    this.initialized = this.peer
      .request(
        'initialize',
        {
          protocol: 1,
          host: { name: 'mercury-acp', version: MERCURY_VERSION },
          capabilities: {
            holds_asks: true,
            elicitation: opts.elicitation === true,
            partial_rows: false,
            ...(opts.fsReadTextFile === true ? { fs_read_text_file: true } : {}),
            ...(opts.fsWriteTextFile === true ? { fs_write_text_file: true } : {}),
            ...(opts.terminal === true ? { terminal: true } : {}),
          },
        },
        { deadlineMs: INITIALIZE_DEADLINE_MS },
      )
      .then(result => {
        if (typeof result.session_id === 'string' && !this.mercurySessionId) {
          this.mercurySessionId = result.session_id
          this.handlers.onInit(result.session_id)
        }
        return result.session_id
      })
      .catch((error: unknown) => {
        logForDebugging(`[acp] the runner did not answer initialize: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
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
      case 'turn': {
        if (tagged !== null || row.state !== 'started') return
        this.turnOpen = true
        this.queuedPromptId = null
        if (this.interruptWhenTurnOpens) {
          this.interruptWhenTurnOpens = false
          this.requestInterrupt()
        }
        return
      }
      case 'outcome': {
        this.turnOpen = false
        this.queuedPromptId = null
        this.interruptWhenTurnOpens = false

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
      default:
        return
    }
  }

  async writeUserPrompt(content: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    if (this.protocolFailure) throw this.protocolFailure
    if (this.dead || this.closedByUs) {
      throw new Error(`the session child is ${this.dead ? 'dead' : 'closed'} — prompt not delivered`)
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal?.reason)
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.initialized.then(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, error => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      })
    })
    signal?.throwIfAborted()
    if (this.protocolFailure) throw this.protocolFailure
    const id = randomUUID()
    this.queuedPromptId = id
    try {
      const answer = await this.peer.request('queue/add', { type: 'prompt', content: inputBlocksOf(content), id }, { deadlineMs: 30_000 })
      if (answer.accepted === false) throw new Error(`the session refused the prompt (${answer.reason})`)
    } catch (error) {
      if (this.queuedPromptId === id) this.queuedPromptId = null
      if (error instanceof PeerClosed) throw new Error('the session child is unwritable — prompt not delivered')
      throw error
    }
  }

  interrupt(): void {
    const queued = this.queuedPromptId
    if (this.turnOpen || queued === null) {
      this.requestInterrupt()
      return
    }
    this.interruptWhenTurnOpens = true
    void this.peer
      .request('queue/withdraw', { id: queued })
      .then(answer => {
        if (answer.withdrawn) {
          this.interruptWhenTurnOpens = false
          if (this.queuedPromptId === queued) this.queuedPromptId = null
          this.handlers.onTurnEnd('cancelled', { status: 'interrupted', errors: [] })
          return
        }
        if (this.turnOpen && this.interruptWhenTurnOpens) {
          this.interruptWhenTurnOpens = false
          this.requestInterrupt()
        }
      })
      .catch((error: unknown) => {
        logForDebugging(`[acp] withdraw not answered: ${error instanceof Error ? error.message : String(error)}`)
        this.interruptWhenTurnOpens = false
        this.requestInterrupt()
      })
  }

  private requestInterrupt(): void {
    void this.peer.request('turn/interrupt', {}).catch((error: unknown) => {
      logForDebugging(`[acp] interrupt not answered: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (this.protocolFailure) throw this.protocolFailure
    if (this.dead || this.closedByUs) throw new Error('the session child is gone — the mode was not changed')
    await this.initialized
    if (this.protocolFailure) throw this.protocolFailure
    await this.peer.request('session/set_mode', { mode })
  }

  close(graceMs = 1_500, exitMs = IDLE_EXIT_MS): Promise<void> {
    this.closedByUs = true
    this.peer.close('the session was closed')
    try {
      this.child.stdin?.end()
    } catch {
    }
    if (this.dead) return Promise.resolve()
    return new Promise<void>(resolve => {
      const timers: NodeJS.Timeout[] = []
      const finish = (): void => {
        for (const timer of timers) clearTimeout(timer)
        resolve()
      }
      const arm = (ms: number, step: () => void): void => {
        const timer = setTimeout(step, ms)
        timer.unref?.()
        timers.push(timer)
      }
      const signal = (name: 'SIGTERM' | 'SIGKILL'): void => {
        try {
          this.child.kill(name)
        } catch (e) {
          logForDebugging(`[acp] child ${name} failed (already dead?): ${e}`)
        }
      }
      this.child.once('exit', finish)
      arm(exitMs, () => {
        signal('SIGTERM')
        arm(graceMs, () => signal('SIGKILL'))
        arm(graceMs + 1_500, () => {
          this.child.removeListener('exit', finish)
          logForDebugging('[acp] child survived close() escalation (unkillable?) — resolving bounded')
          finish()
        })
      })
    })
  }
}
