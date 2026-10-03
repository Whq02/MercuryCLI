
import { spawn, type ChildProcess } from 'node:child_process'
import { selfScriptPath } from '../../daemon/daemonBuild.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import type { LooseRow } from '../../rows/read.js'
import type { ElicitationAnswer, ElicitationRequestParams, PermissionAnswer, PermissionRequestParams } from '../../runner/wire/methods.js'
import { createPeer, PeerClosed, type Peer } from '../../runner/wire/peer.js'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

export interface TurnEndDetail {
  status: string
  stopReason?: string
  errors: string[]
}

export type ToolAsk = Extract<PermissionRequestParams, { kind: 'tool' }>

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
  onPermissionAsk: (requestId: number, ask: ToolAsk, withdrawn: AbortSignal) => Promise<PermissionAnswer>
  onNetworkAsk?: (host: string, withdrawn: AbortSignal) => Promise<boolean>
  onElicitation?: (params: ElicitationRequestParams, withdrawn: AbortSignal) => Promise<ElicitationAnswer>
  onElicitationComplete?: (server: string, elicitationId: string) => void
  onExit: (code: number | null) => void
}

export interface SpawnChildOptions {
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
}

export const INITIALIZE_DEADLINE_MS = 120_000

export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = (content as Array<Record<string, unknown>>)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
  return texts.length > 0 ? texts.join('\n') : undefined
}

export function inputBlocksOf(blocks: ReadonlyArray<Record<string, unknown>>): Array<{ type: 'text'; text: string } | { type: 'image'; media_type: string; data: string }> {
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

export class MercuryChildSession {
  readonly child: ChildProcess
  readonly cwd: string
  readonly peer: Peer
  readonly initialized: Promise<string | null>
  mercurySessionId: string | null = null
  private readonly handlers: ChildEventHandlers
  private closedByUs = false
  private dead = false
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
    this.peer = createPeer({
      input: this.child.stdout!,
      output: this.child.stdin!,
      side: 'host',
      log: line => logForDebugging(`[acp] ${line}`),
    })
    this.peer.onNotification('row', row => this.onRow(row as LooseRow))
    this.peer.onNotification('elicitation/complete', params => this.handlers.onElicitationComplete?.(params.server, params.elicitation_id))
    this.peer.onRequest('permission/request', (params, ctx) => {
      if (params.kind === 'network') {
        const ask = this.handlers.onNetworkAsk
        if (ask === undefined) return { outcome: 'deny', message: 'the editor cannot answer a network ask' }
        return ask(params.host, ctx.signal).then(allowed => (allowed ? { outcome: 'allow' as const } : { outcome: 'deny' as const, message: 'denied by the ACP client' }))
      }
      return this.handlers.onPermissionAsk(ctx.id, params, ctx.signal)
    })
    this.peer.onRequest('elicitation/request', (params, ctx) => {
      const ask = this.handlers.onElicitation
      if (ask === undefined) return { action: 'cancel' }
      return ask(params, ctx.signal)
    })
    this.initialized = this.peer
      .request(
        'initialize',
        {
          protocol: 1,
          host: { name: 'mercury-acp', version: MERCURY_VERSION },
          capabilities: { holds_asks: true, elicitation: opts.elicitation === true, partial_rows: false },
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
      default:
        return
    }
  }

  async writeUserPrompt(content: Array<Record<string, unknown>>): Promise<void> {
    if (this.dead || this.closedByUs) {
      throw new Error(`the session child is ${this.dead ? 'dead' : 'closed'} — prompt not delivered`)
    }
    await this.initialized
    try {
      const answer = await this.peer.request('queue/add', { type: 'prompt', content: inputBlocksOf(content) }, { deadlineMs: 30_000 })
      if (answer.accepted === false) throw new Error(`the session refused the prompt (${answer.reason})`)
    } catch (error) {
      if (error instanceof PeerClosed) throw new Error('the session child is unwritable — prompt not delivered')
      throw error
    }
  }

  interrupt(): void {
    void this.peer.request('turn/interrupt', {}).catch((error: unknown) => {
      logForDebugging(`[acp] interrupt not answered: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (this.dead || this.closedByUs) throw new Error('the session child is gone — the mode was not changed')
    await this.initialized
    await this.peer.request('session/set_mode', { mode })
  }

  close(graceMs = 1_500): Promise<void> {
    this.closedByUs = true
    this.peer.close('the session was closed')
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
