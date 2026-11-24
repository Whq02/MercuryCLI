#!/usr/bin/env bun
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Reply = Record<string, unknown>
type Answer = Reply | 'drop' | ((req: Reply) => Reply | 'drop')
type ScriptedReply = Answer | { apart: Answer } | { hold: (release: (reply: Reply | 'drop') => void) => void }
type Listener = 'records' | 'live' | 'model' | 'permission' | 'work' | 'checkpoints' | 'asks' | 'fold'
type Row = Record<string, unknown>

export const LISTENER_KINDS: readonly Listener[] = ['records', 'live', 'model', 'permission', 'work', 'checkpoints', 'asks', 'fold']
export const SUBSCRIBE_METHODS = ['subscribeRecords', 'subscribeLive', 'subscribeModel', 'subscribePermissionMode', 'subscribeWork', 'subscribeCheckpoints', 'subscribeAsks', 'subscribeFold'] as const
export const READ_METHODS = [
  'sessionId',
  'transcriptFile',
  'isAttached',
  'feedCadencesForProofs',
  'records',
  'tailAnchor',
  'tail',
  'live',
  'turnActive',
  'turnChars',
  'turnOutputTokens',
  'turnFacts',
  'status',
  'lastTurnCompletedAtMs',
  'asks',
  'fold',
  'modelFacts',
  'permissionMode',
  'workRoster',
  'advisorFacts',
  'swarmBoard',
  'checkpointFacts',
  'usage',
  'identity',
  'editOutcomes',
  'skillsRoster',
  'mcpRoster',
  'spawnSwitches',
  'workspace',
  'heldForCompaction',
  'lostLine',
  'transcriptStoreFailing',
  'admissionRefusal',
  'recallableSend',
  'queuedSendCount',
] as const

export type Recording = { scenarios: Record<string, string[]>; called: string[]; woken: string[] }

const CLOCK_ZERO = Date.UTC(2026, 10, 18, 12, 0, 0)
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const STEP_BUDGET_MS = 20_000

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realSetImmediate = globalThis.setImmediate
const RealDate = Date

type FakeTimer = { id: number; at: number; every: number | null; run: () => void; dead: boolean }

const PRODUCT = join(import.meta.dir, '..', '..', 'src') + sep
const armedByTheProduct = (): boolean => {
  const stack = new Error().stack ?? ''
  return stack.includes(PRODUCT) || stack.includes(PRODUCT.split(sep).join('/'))
}

function installClock(): { now: () => number; advance: (ms: number) => void; begin: (hour: number) => void } {
  let now = CLOCK_ZERO
  let nextId = 1
  const timers: FakeTimer[] = []
  const handleOf = (timer: FakeTimer): unknown => {
    const handle = {
      fake: timer,
      ref: () => handle,
      unref: () => handle,
      hasRef: () => false,
      refresh: () => handle,
      [Symbol.toPrimitive]: () => timer.id,
    }
    return handle
  }
  const arm = (every: boolean) => (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown => {
    if (!armedByTheProduct()) return (every ? realSetInterval : realSetTimeout)(fn, ms, ...args)
    const delay = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
    const timer: FakeTimer = { id: nextId++, at: now + delay, every: every ? Math.max(1, delay) : null, run: () => fn(...args), dead: false }
    timers.push(timer)
    return handleOf(timer)
  }
  const disarm = (real: (handle: never) => void) => (handle: unknown): void => {
    const timer = (handle as { fake?: FakeTimer } | null | undefined)?.fake
    if (timer !== undefined) timer.dead = true
    else if (handle !== undefined && handle !== null) real(handle as never)
  }
  const g = globalThis as Record<string, unknown>
  g.setTimeout = arm(false)
  g.setInterval = arm(true)
  g.clearTimeout = disarm(realClearTimeout)
  g.clearInterval = disarm(realClearInterval)
  g.Date = new Proxy(RealDate, {
    construct: (target, args: unknown[]) => (args.length === 0 ? new target(now) : new (target as new (...a: unknown[]) => Date)(...args)),
    apply: target => new target(now).toString(),
    get: (target, prop, receiver) => (prop === 'now' ? () => now : Reflect.get(target, prop, receiver)),
  })
  Object.defineProperty(globalThis.performance, 'now', { value: () => now - CLOCK_ZERO, configurable: true, writable: true })
  return {
    now: () => now,
    begin: hour => {
      for (const t of timers) t.dead = true
      timers.length = 0
      now = CLOCK_ZERO + hour * 3_600_000
    },
    advance: ms => {
      const target = now + ms
      for (;;) {
        let next: FakeTimer | null = null
        for (const t of timers) if (!t.dead && t.at <= target && (next === null || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t
        if (next === null) break
        now = Math.max(now, next.at)
        if (next.every === null) next.dead = true
        else next.at += next.every
        next.run()
      }
      for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.dead) timers.splice(i, 1)
      now = target
    },
  }
}

const turn = (): Promise<void> => new Promise(resolve => realSetImmediate(resolve))
const pause = (ms: number): Promise<void> => new Promise(resolve => realSetTimeout(resolve, ms))
function within<T>(what: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new Error(`${what}: no end within ${STEP_BUDGET_MS} ms`)), STEP_BUDGET_MS)
    work.then(
      value => {
        realClearTimeout(timer)
        resolve(value)
      },
      error => {
        realClearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function recordScenarios(only: readonly string[] = []): Promise<Recording> {
  const scratch = mkdtempSync(join(tmpdir(), 'connector-recording-'))
  const daemonDir = join(scratch, 'daemon')
  const work = join(scratch, 'work')
  for (const dir of [join(scratch, 'home'), daemonDir, work]) mkdirSync(dir, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
  process.env.MERCURY_DAEMON_DIR = daemonDir
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  delete process.env.MERCURY_HOME
  delete process.env.MERCURY_CONNECTOR_TRACE
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const clock = installClock()

  const src = (path: string): string => join(import.meta.dir, '..', '..', 'src', path)
  const bootstrap = await import(src('boot/process-state/processState.ts'))
  bootstrap.setIsInteractive(false)
  const { enableConfigs } = await import(src('platform/config/globalConfig.ts'))
  enableConfigs()
  const { DaemonSessionConnector } = await import(src('engine/connector/daemonConnector.ts'))
  const projections = await import(src('engine/connector/seatProjections.ts'))
  const { controlSockPath, daemonStatePath } = await import(src('daemon/control/controlSocket.ts'))
  const { concourseWorkersPath } = await import(src('daemon/concourse-workers/concourseWorkers.ts'))
  const { _resetDaemonUsableMemoForProofs } = await import(src('daemon/switchboard/ensureDaemon.ts'))
  const { createSeatReceiptMessage } = await import(src('engine/message-shapes/systemMessages.ts'))
  const { mcpToolsAnswerOf } = await import(src('integrations/mcp/toolsAnswer.ts'))
  const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
  const carrierCall = async (req: Reply, timeoutMs: number): Promise<Reply> => {
    const { daemonControlRpc } = await import(src('daemon/control/controlSocket.ts'))
    return (await daemonControlRpc(req, { timeoutMs })) as Reply
  }
  const carrierThrows = async (message: string): Promise<Reply> => {
    throw new Error(message)
  }
  const progressStore = await import(src('screen/app-state/ephemeralProgressStore.ts'))
  await import(src('daemon/control/ownerWatch.ts'))
  const WATCHED_TOOLS = ['toolu_attach', 'toolu_run', 'toolu_hook', 'toolu_eval', 'toolu_mcp', 'toolu_ps', 'toolu_fed', 'toolu_old', 'toolu_f']

  type Pending = { req: Reply; answer: (reply: Reply | 'drop') => void; closed: Promise<void> }
  const waiting: Pending[] = []
  const seats: Array<{ action: string; sessionId: string }> = []
  const arrivals: Array<() => void> = []
  const arrived = (): void => {
    for (const wake of arrivals.splice(0)) wake()
  }
  const nextArrival = (): Promise<void> => new Promise(resolve => arrivals.push(resolve))
  let current: { event: (entry: Record<string, unknown>) => void } | null = null
  const server = net.createServer(sock => {
    let text = ''
    let closed: () => void = () => {}
    const whenClosed = new Promise<void>(resolve => (closed = resolve))
    sock.on('error', () => {})
    sock.on('close', () => closed())
    sock.on('data', chunk => {
      text += chunk.toString('utf8')
      const nl = text.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(text.slice(0, nl)) as Reply
      text = ''
      const send = (reply: Reply | 'drop'): void => {
        if (reply === 'drop') sock.end()
        else sock.end(`${JSON.stringify(reply)}\n`)
      }
      if (req.op === 'sessionControl' && (req.action === 'focus' || req.action === 'blur')) {
        seats.push({ action: String(req.action), sessionId: String(req.sessionId) })
        send({ ok: true, op: 'sessionControl', outcome: 'applied' })
        arrived()
        return
      }
      if (req.op === 'hello') {
        current?.event({ carrier: { op: 'hello' }, reply: 'matched' })
        send({ ok: true, op: 'hello', proto: req.proto, minProto: 1, ready: true, version: '1.0.0', buildTree: null, pid: process.pid, startedAt: CLOCK_ZERO, ownerPid: null, foreground: false, live: 0, liveSessions: 0, warm: 0, restartArmed: false })
        return
      }
      waiting.push({ req, answer: send, closed: whenClosed })
      arrived()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(controlSockPath(), () => resolve())
  })

  const baseFacts = {
    schema: 1 as const,
    pendingModel: null,
    busy: false,
    model: { effective: 'claude-sonnet-5-5', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default' as const,
    workspace: { cwd: work, originalCwd: work, projectRoot: work, instructionRoots: [] },
    queue: [],
  }

  const called = new Set<string>()
  const woken = new Set<string>()
  const scenarios: Record<string, string[]> = {}

  class Harness {
    readonly events: string[] = []
    readonly sessionId: string
    readonly home: string
    readonly transcriptPath: string
    readonly connector: InstanceType<typeof DaemonSessionConnector>
    private readonly guts: { attached: boolean; tick: () => Promise<void>; readTail: () => void; readAsks: () => void }
    private factsFeedReads: () => void = () => {}
    private carrierBroken: string | null = null
    private readonly ids = new Map<string, string>()
    private readonly last = new Map<string, string>()
    private rows: Row[] = []
    private written = 0
    private factsAt = 0
    private script: ScriptedReply[] = []
    private serving: Promise<void> = Promise.resolve()
    private readonly apart: Array<Record<string, unknown>> = []
    private readonly closing: Array<Promise<void>> = []
    private readonly unsubscribe: Array<() => void> = []
    onWake: ((kind: Listener) => void) | null = null

    constructor(readonly name: string, record: Record<string, unknown> = {}, before: (h: Harness) => void = () => {}, watcher: 'real' | 'none' = 'none') {
      this.sessionId = `rec-${name}`
      this.home = join(scratch, 'sessions', name)
      mkdirSync(this.home, { recursive: true })
      this.transcriptPath = join(this.home, `${this.sessionId}.jsonl`)
      before(this)
      this.connector = new DaemonSessionConnector(
        { sessionId: this.sessionId, runnerId: `runner-${name}`, title: `the ${name} chat`, projectLabel: 'proof', workspaceId: work, home: this.home, modelKey: 'claude-sonnet-5-5', ...record },
        {
          rpc: (req: Reply, timeoutMs: number) => (this.carrierBroken === null ? carrierCall(req, timeoutMs) : carrierThrows(this.carrierBroken)),
          ...(watcher === 'real' ? {} : { armTranscriptWatcher: () => {} }),
          factsRead: (read: () => void) => {
            this.factsFeedReads = read
          },
        },
      )
      this.guts = this.connector as unknown as Harness['guts']
      const subscribe: Record<Listener, (cb: () => void) => () => void> = {
        records: cb => this.connector.subscribeRecords(cb),
        live: cb => this.connector.subscribeLive(cb),
        model: cb => this.connector.subscribeModel(cb),
        permission: cb => this.connector.subscribePermissionMode(cb),
        work: cb => this.connector.subscribeWork(cb),
        checkpoints: cb => this.connector.subscribeCheckpoints(cb),
        asks: cb => this.connector.subscribeAsks(cb),
        fold: cb => this.connector.subscribeFold(cb),
      }
      for (const kind of LISTENER_KINDS) {
        this.unsubscribe.push(subscribe[kind](() => {
          woken.add(kind)
          this.event({ wake: kind, answers: this.changed() })
          this.onWake?.(kind)
        }))
      }
      for (const method of SUBSCRIBE_METHODS) called.add(method)
      const store = this.connector.tail() as unknown as { subscribe(cb: () => void): () => void; getSnapshot(): string | null; readSettled(): unknown; readIds(): unknown; readPhases(): unknown }
      this.unsubscribe.push(store.subscribe(() => this.event({ tailStore: { published: store.getSnapshot(), settled: store.readSettled(), ids: store.readIds(), phases: store.readPhases() } })))
      for (const id of WATCHED_TOOLS) {
        this.unsubscribe.push(progressStore.subscribeEphemeralProgress(id, () => {
          const frame = progressStore.getEphemeralProgressFrame(id) as { toolUseID?: string; data?: unknown } | undefined
          this.event({ progress: id, frame: frame === undefined ? null : { toolUseID: frame.toolUseID, data: frame.data } })
        }))
      }
      this.event({ opened: this.sessionId, answers: this.changed() })
    }

    private mask(value: unknown): Json {
      if (value === undefined) return '<undefined>'
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value as Json
      if (typeof value === 'string') {
        return value
          .split(scratch).join('<scratch>')
          .split(scratch.replace(/^\/private/, '')).join('<scratch>')
          .replace(UUID, id => {
            const key = id.toLowerCase()
            if (!this.ids.has(key)) this.ids.set(key, `<id:${this.ids.size + 1}>`)
            return this.ids.get(key)!
          })
          .replace(/operator:\d+/g, 'operator:<pid>')
          .replace(/\((E[A-Z]+)\)/g, '(<errno>)')
      }
      if (typeof value === 'function') return '<function>'
      if (value instanceof Set) return [...value].map(v => this.mask(v))
      if (value instanceof Map) return [...value.entries()].map(([k, v]) => [this.mask(k), this.mask(v)])
      if (Array.isArray(value)) return value.map(v => this.mask(v))
      if (typeof value === 'object') {
        const out: Record<string, Json> = {}
        for (const key of Object.keys(value as object).sort()) {
          const v = (value as Record<string, unknown>)[key]
          if (v === undefined) continue
          out[key] = key === 'proto' || key === 'pid' || key === 'auth' ? '<masked>' : this.mask(v)
        }
        return out
      }
      return String(value)
    }

    private rowLabel(row: unknown): Json {
      const r = row as Row
      const message = r.message as { id?: unknown; content?: unknown } | undefined
      const content = message?.content
      const blocks = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => {
        const block = b as Row
        if (block.type === 'text') return `text:${String(block.text)}`
        if (block.type === 'tool_use') return `tool_use:${String(block.name)}:${String(block.id)}`
        if (block.type === 'tool_result') return `tool_result:${String(block.tool_use_id)}:${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`
        return String(block.type)
      }) : undefined
      const attachment = r.attachment as Row | undefined
      return this.mask({
        type: r.type,
        subtype: r.subtype,
        uuid: r.uuid,
        timestamp: r.timestamp,
        isMeta: r.isMeta,
        isVirtual: r.isVirtual,
        queued: r.queued,
        heldFor: r.heldFor,
        level: r.level,
        content: typeof r.content === 'string' ? r.content : undefined,
        messageId: message?.id,
        blocks,
        attachment: attachment === undefined ? undefined : { type: attachment.type, prompt: attachment.prompt, commandMode: attachment.commandMode, source_uuid: attachment.source_uuid, deliveredAt: attachment.deliveredAt },
        origin: r.origin,
      })
    }

    private askLabel(ask: unknown): Json {
      const a = ask as { id: string; toolName: string; agentId?: string; askedAt: number; limitMs?: number; confirm: { description: string; input: unknown; toolUseID: string; cwd?: string; permissionResult: unknown; tool: { name: string }; assistantMessage: unknown } }
      return this.mask({ id: a.id, toolName: a.toolName, agentId: a.agentId, askedAt: a.askedAt, limitMs: a.limitMs, description: a.confirm.description, input: a.confirm.input, toolUseID: a.confirm.toolUseID, cwd: a.confirm.cwd, permissionResult: a.confirm.permissionResult, tool: a.confirm.tool.name, assistant: this.rowLabel(a.confirm.assistantMessage) })
    }

    private answers(): Record<string, Json> {
      const out: Record<string, Json> = {}
      for (const name of READ_METHODS) {
        called.add(name)
        const value = (this.connector as unknown as Record<string, () => unknown>)[name]!()
        if (name === 'records') out[name] = (value as unknown[]).map(row => this.rowLabel(row))
        else if (name === 'asks') out[name] = (value as unknown[]).map(ask => this.askLabel(ask))
        else if (name === 'tail') {
          const store = value as { read: () => unknown; readSettled: () => unknown; readIds: () => unknown; readPhases: () => unknown }
          out[name] = this.mask({ text: store.read(), settled: store.readSettled(), ids: store.readIds(), phases: store.readPhases() })
        } else out[name] = this.mask(value)
      }
      return out
    }

    private changed(): Record<string, Json> {
      const out: Record<string, Json> = {}
      for (const [key, value] of Object.entries(this.answers())) {
        const text = JSON.stringify(value)
        if (this.last.get(key) === text) continue
        this.last.set(key, text)
        out[key] = value
      }
      return out
    }

    private claim(): void {
      this.guts.attached = true
    }

    event(entry: Record<string, unknown>): void {
      this.events.push(JSON.stringify(this.mask(entry)))
      if (process.argv.includes('--trace')) process.stderr.write(`${this.events[this.events.length - 1]!.slice(0, 400)}\n`)
    }

    private begin(script: ScriptedReply[]): void {
      current = this
      this.script = [...script]
      this.serving = (async () => {
        while (this.script.length > 0) {
          while (waiting.length === 0) await nextArrival()
          const pending = waiting.shift()!
          const scripted = this.script.shift()!
          if (typeof scripted === 'object' && scripted !== null && 'hold' in scripted) {
            this.event({ carrier: pending.req, reply: '<held: the carrier is quiet>' })
            ;(scripted as { hold: (release: (reply: Reply | 'drop') => void) => void }).hold(reply => {
              this.event({ carrier: pending.req, released: reply })
              pending.answer(reply)
            })
            continue
          }
          const aside = typeof scripted === 'object' && 'apart' in scripted
          const answer = (aside ? (scripted as { apart: Answer }).apart : scripted) as Answer
          const reply = typeof answer === 'function' ? answer(pending.req) : answer
          if (aside) this.apart.push({ carrier: pending.req, reply, apart: true })
          else this.event({ carrier: pending.req, reply })
          pending.answer(reply)
          this.closing.push(pending.closed)
        }
      })()
    }

    private async settle(what: string): Promise<void> {
      await within(`${this.name}: ${what}: the carrier was scripted ${this.script.length} more replies than it was asked for`, this.serving)
      await Promise.all(this.closing.splice(0))
      const apart = this.apart.splice(0)
      const place = (entry: Record<string, unknown>): string => JSON.stringify(entry.carrier).replace(new RegExp(UUID.source, 'gi'), '<id>')
      if (apart.length > 1) apart.sort((a, b) => (place(a) < place(b) ? -1 : place(a) > place(b) ? 1 : 0))
      for (const entry of apart) this.event(entry)
      if (this.guts.attached) await this.guts.tick.call(this.connector)
      for (let i = 0; i < 4; i++) await turn()
      await pause(1)
      for (let i = 0; i < 2; i++) await turn()
      if (waiting.length > 0) {
        const stray = waiting.splice(0)
        for (const p of stray) p.answer({ ok: false, code: 'EUNKNOWN', error: 'the scenario scripted no reply' })
        throw new Error(`${this.name}: ${what}: the carrier was asked ${JSON.stringify(stray.map(p => [p.req.op, p.req.action]))} with no scripted reply`)
      }
      const answers = this.changed()
      if (Object.keys(answers).length > 0) this.event({ then: answers })
    }

    async call(method: string, args: unknown[] = [], script: ScriptedReply[] = []): Promise<unknown> {
      called.add(method)
      this.begin(script)
      this.event({ call: method, args })
      let out: unknown
      try {
        out = (this.connector as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args)
      } catch (error) {
        this.event({ threw: method, error: String(error) })
        await this.settle(method)
        return undefined
      }
      if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
        const value = await within(`${this.name}: ${method}`, (out as Promise<unknown>).then(
          settled => {
            this.event({ returned: method, value: settled, answers: this.changed() })
            return settled
          },
          error => {
            this.event({ rejected: method, error: String(error) })
            return undefined
          },
        ))
        await this.settle(method)
        return value
      }
      this.event({ returned: method, value: out, answers: this.changed() })
      await this.settle(method)
      return out
    }

    async step(label: string, script: ScriptedReply[], run: () => void | Promise<void>): Promise<void> {
      this.begin(script)
      this.event({ step: label })
      await within(`${this.name}: ${label}`, Promise.resolve(run()))
      await this.settle(label)
    }

    facts(patch: Record<string, unknown> = {}, script: ScriptedReply[] = []): Promise<void> {
      this.publishFacts(patch)
      return this.step(`facts ${JSON.stringify(this.mask(patch))}`, script, () => this.factsFeedReads())
    }

    publishFacts(patch: Record<string, unknown> = {}): void {
      this.factsAt = Math.max(this.factsAt + 1, clock.now())
      projections.publishSessionFacts({ ...baseFacts, sessionId: this.sessionId, atMs: this.factsAt, ...patch }, daemonDir)
    }

    rereadFacts(label = 'the same facts are read again'): Promise<void> {
      return this.step(label, [], () => this.factsFeedReads())
    }

    rereadAsks(): Promise<void> {
      return this.step('the same asks are read again', [], () => this.guts.readAsks.call(this.connector))
    }

    rereadTail(): Promise<void> {
      return this.step('the same tail is read again', [], () => this.guts.readTail.call(this.connector))
    }

    dropFacts(): Promise<void> {
      return this.step('the facts file is gone', [], () => {
        rmSync(projections.sessionFactsPath(this.sessionId, daemonDir), { force: true })
        this.factsFeedReads()
      })
    }

    tail(patch: Record<string, unknown> | null): Promise<void> {
      return this.step(`tail ${JSON.stringify(this.mask(patch))}`, [], () => {
        if (patch === null) rmSync(projections.sessionTailPath(this.sessionId, daemonDir), { force: true })
        else projections.publishSessionTail({ schema: 1, sessionId: this.sessionId, atMs: clock.now(), text: null, ...patch }, daemonDir)
        this.guts.readTail.call(this.connector)
      })
    }

    asks(asks: Row[] | null, script: ScriptedReply[] = []): Promise<void> {
      return this.step(`asks ${JSON.stringify(this.mask(asks))}`, script, () => {
        if (asks === null) rmSync(projections.sessionAsksPath(this.sessionId, daemonDir), { force: true })
        else projections.publishSessionAsks({ schema: 1, sessionId: this.sessionId, asks }, daemonDir)
        this.guts.readAsks.call(this.connector)
      })
    }

    publishProgress(tools: Record<string, Row>): void {
      projections.publishSessionProgress({ schema: 1, sessionId: this.sessionId, atMs: clock.now(), tools }, daemonDir)
    }

    workers(marks: { lastTurnSettledAt?: number; lastDeliveryAt?: number; endedAt?: number } | null): void {
      const path = concourseWorkersPath(daemonDir)
      if (marks === null) {
        rmSync(path, { force: true })
        return
      }
      const runnerId = `runner-${this.name}`
      const file = { version: 1, workers: { [runnerId]: { schema: 1, runnerId, sessionId: this.sessionId, workspaceId: work, isolation: 'shared', modelKey: 'claude-sonnet-5-5', spawnedAt: CLOCK_ZERO, lastLiveAt: clock.now(), ...marks } } }
      writeFileSync(`${path}.next`, `${JSON.stringify(file)}\n`)
      renameSync(`${path}.next`, path)
    }

    daemonRecord(state: 'alive' | 'gone'): void {
      if (state === 'gone') rmSync(daemonStatePath(), { force: true })
      else writeFileSync(daemonStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: CLOCK_ZERO, dir: daemonDir, controlSock: controlSockPath() }))
    }

    private line(row: Row): Row {
      const n = this.rows.length + 1
      const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      const parentUuid = this.rows.length === 0 ? null : (this.rows[this.rows.length - 1]!.uuid as string)
      return { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: this.sessionId, version: '1.0.0', gitBranch: 'main', parentUuid, uuid, timestamp: new Date(clock.now()).toISOString(), ...row }
    }

    user(text: string, extra: Row = {}): () => Row {
      return () => this.line({ type: 'user', message: { role: 'user', content: text }, ...extra })
    }

    assistant(messageId: string, content: Row[], extra: Row = {}): () => Row {
      return () => this.line({ type: 'assistant', requestId: `req_${messageId}`, message: { id: messageId, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...extra })
    }

    toolResult(toolUseId: string, text: string): () => Row {
      return () => this.line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, toolUseResult: text })
    }

    uuidOf(index: number): string {
      return this.rows[index]!.uuid as string
    }

    private write(make: Array<() => Row>): void {
      for (const row of make) this.rows.push(row())
      const lines = encodeSeedTranscript(this.rows, this.sessionId).split('\n').filter(Boolean)
      appendFileSync(this.transcriptPath, lines.slice(this.written).join('\n') + '\n')
      this.written = lines.length
    }

    seed(make: Array<() => Row>): void {
      this.write(make)
    }

    transcript(label: string, make: Array<() => Row>): Promise<void> {
      return this.step(`transcript: ${label}`, [], async () => {
        this.write(make)
        this.claim()
        await this.guts.tick.call(this.connector)
      })
    }

    transcriptGrowsWhileRead(label: string, first: Array<() => Row>, then: Array<() => Row>): Promise<void> {
      return this.step(`transcript: ${label}`, [], async () => {
        this.write(first)
        this.claim()
        const reading = this.guts.tick.call(this.connector)
        this.write(then)
        void this.guts.tick.call(this.connector)
        await reading
      })
    }

    watcherFiresTwice(label: string, make: Array<() => Row>): Promise<void> {
      return this.step(`transcript: ${label}`, [], async () => {
        if (make.length > 0) this.write(make)
        this.claim()
        void this.guts.tick.call(this.connector)
        await this.guts.tick.call(this.connector)
      })
    }

    unwrittenTranscript(make: Array<() => Row>): void {
      this.event({ step: 'rows reach the transcript and no tick has read them' })
      this.write(make)
    }

    cutTranscript(label: string, keep: number): Promise<void> {
      return this.step(`transcript: ${label}`, [], async () => {
        this.rows = this.rows.slice(0, keep)
        writeFileSync(this.transcriptPath, encodeSeedTranscript(this.rows, this.sessionId))
        this.written = this.rows.length
        this.claim()
        await this.guts.tick.call(this.connector)
      })
    }

    spoilTranscript(label: string, spoil: () => void): Promise<void> {
      return this.step(`transcript: ${label}`, [], async () => {
        spoil()
        this.claim()
        await this.guts.tick.call(this.connector)
      })
    }

    hold(on: boolean): Promise<void> {
      return this.step(on ? 'the window is held attached' : 'the window is let go', [], () => {
        if (on) this.claim()
        else this.guts.attached = false
      })
    }

    advance(ms: number, script: ScriptedReply[] = []): Promise<void> {
      return this.step(`the clock moves ${ms} ms`, script, () => clock.advance(ms))
    }

    feed(label: string, publish: () => void): Promise<void> {
      return this.step(`a feed reads: ${label}`, [], () => {
        publish()
        clock.advance(10_000)
      })
    }

    beat(): Promise<void> {
      return this.step('the clock moves 1000 ms and the probe of the carrier ends', [], async () => {
        clock.advance(1000)
        for (let i = 0; i < 4; i++) await turn()
        for (let round = 0; round < 3; round++) {
          for (let i = 0; i < 8; i++) await readFile(daemonStatePath(), 'utf8').catch(() => null)
          await pause(1)
        }
        for (let i = 0; i < 4; i++) await turn()
      })
    }

    breakCarrier(message: string): void {
      this.event({ step: `the carrier throws: ${message}` })
      this.carrierBroken = message
    }

    mendCarrier(): void {
      this.event({ step: 'the carrier answers again' })
      this.carrierBroken = null
    }

    async close(): Promise<void> {
      this.carrierBroken = null
      this.guts.attached = true
      await this.call('detach')
      for (const off of this.unsubscribe) off()
      const mark = `drain-${this.name}`
      const drain = new DaemonSessionConnector({ sessionId: mark, runnerId: '', title: mark, projectLabel: 'proof', workspaceId: work, home: this.home })
      ;(drain as unknown as { attached: boolean }).attached = true
      drain.assertSeat()
      while (!seats.some(s => s.sessionId === mark)) await within(`${this.name}: the seat verbs drain`, nextArrival())
      this.event({ seat: seats.splice(0).filter(s => s.sessionId === this.sessionId).map(s => s.action) })
      scenarios[this.name] = this.events
    }
  }

  const applied = (extra: Reply = {}): Reply => ({ ok: true, op: 'sessionControl', outcome: 'applied', ...extra })
  const outcome = (word: string, extra: Reply = {}): Reply => ({ ok: true, op: 'sessionControl', outcome: word, ...extra })
  const refusedBy = (error: string, extra: Reply = {}): Reply => ({ ok: false, code: 'EREFUSED', error, ...extra })
  const dispatched: Reply = { ok: true, op: 'sessionDispatch', state: 'delivered' }
  let scenariosSeen = 0
  const scenario = async (name: string, run: (h: Harness) => Promise<void>, record: Record<string, unknown> = {}, before: (h: Harness) => void = () => {}, watcher: 'real' | 'none' = 'none'): Promise<void> => {
    const hour = scenariosSeen++
    if (only.length > 0 && !only.includes(name)) return
    clock.begin(hour)
    _resetDaemonUsableMemoForProofs()
    rmSync(concourseWorkersPath(daemonDir), { force: true })
    rmSync(daemonStatePath(), { force: true })
    const h = new Harness(name, record, before, watcher)
    await run(h)
    await h.close()
  }
  const sentId = (h: Harness): string => (h.connector.recallableSend() as { clientMessageId: string }).clientMessageId
  const notice = (id: string, words: string): string => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${words}" completed</summary>\n</task-notification>`
  const crewRow = (id: string, status: string, extra: Row = {}): Row => ({ id, agentId: id, kind: 'agent', name: `the ${id} errand`, status, startTime: CLOCK_ZERO - 20_000, ...extra })

  await scenario('attach-and-detach', async h => {
    await h.call('attach', [], [{ apart: applied() }])
    await h.call('attach')
    await h.call('assertSeat')
    await h.call('detach')
    await h.call('detach')
    await h.call('assertSeat')
  }, {}, h => {
    h.publishFacts({ busy: false, effort: 'high' })
    projections.publishSessionAsks({ schema: 1, sessionId: h.sessionId, asks: [{ requestId: 'ask-at-attach', toolUseId: 'toolu_attach', toolName: 'Bash', input: { command: 'ls' }, description: 'list the folder', askedAt: clock.now() }] }, daemonDir)
    projections.publishSessionTail({ schema: 1, sessionId: h.sessionId, atMs: clock.now(), text: null, turnChars: 12, turnOutputTokens: 3 }, daemonDir)
    h.publishProgress({ toolu_attach: { toolUseID: 'toolu_inner', dataType: 'bash_progress', seq: 1, latestLine: 'one line', elapsedTimeSeconds: 2, totalLines: 1, budgetMs: 120000 } })
    h.seed([h.user('the words before the window opened')])
  }, 'real')

  await scenario('send-delivered', async h => {
    h.workers({})
    await h.hold(true)
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.call('sendWords', ['hello there'], [dispatched])
    const id = sentId(h)
    await h.advance(50)
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.transcript('the send lands as the user row', [h.user('hello there', { uuid: id })])
    await h.tail({ text: 'the reply', messageId: 'msg_reply', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 9, turnOutputTokens: 2, lastEventAtMs: clock.now(), firstByteAtMs: clock.now() })
    await h.transcript('the reply lands', [h.assistant('msg_reply', [{ type: 'text', text: 'the reply' }])])
    await h.tail({ text: null, messageId: 'msg_reply' })
    await h.advance(50)
    h.workers({ lastTurnSettledAt: clock.now(), lastDeliveryAt: clock.now() - 40 })
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.rereadFacts()
    await h.call('sendingSinceMs')
  })

  await scenario('send-queued-then-recalled', async h => {
    await h.hold(true)
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.call('sendWords', ['a second thought'], [dispatched])
    const first = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: first, value: 'a second thought', mode: 'prompt' }] })
    await h.call('withdrawSend', [first], [applied({ withdrawn: true, text: 'a second thought' })])
    await h.call('withdrawSend', [first])
    await h.call('sendWords', ['a line with a paste [Pasted text #1 +2 lines]', { pastedContents: { 1: { id: 1, type: 'text', content: 'line one\nline two' } } }], [dispatched])
    const second = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: second, value: 'a line with a paste', mode: 'prompt' }] })
    await h.call('withdrawSend', [second], [outcome('refused', { withdrawn: false, reason: 'refused', detail: 'the queue is locked' })])
    await h.call('withdrawSend', [second], [refusedBy('the daemon is an older build', { refusal: 'daemon-older' })])
    h.breakCarrier('ECONNREFUSED')
    await h.call('withdrawSend', [second])
    h.mendCarrier()
    await h.call('withdrawSend', [second], [applied({ withdrawn: true, text: 'a line with a paste line one\nline two' })])
    await h.call('sendWords', ['a third thought'], [dispatched])
    const third = sentId(h)
    await h.call('withdrawSend', [third], [outcome('refused', { withdrawn: false, reason: 'taken', detail: 'the runner already took the line' })])
    await h.call('withdrawSend', [third])
    await h.call('sendWords', ['a fourth thought'], [dispatched])
    const fourth = sentId(h)
    await h.call('withdrawSend', [fourth], [outcome('refused', { withdrawn: false, reason: 'unknown' })])
    await h.call('withdrawSend', ['00000000-0000-4000-8000-00000000ffff'])
  })

  await scenario('send-refused-held-failed', async h => {
    await h.hold(true)
    await h.facts({ busy: false })
    await h.call('sendWords', [''])
    await h.call('sendWords', ['   '])
    await h.call('sendWords', ['hold this line'], [refusedBy('session-paused: the operator paused it', { heldReason: 'paused' })])
    await h.call('sendWords', ['hold this line'], [dispatched])
    await h.call('sendWords', ['refuse this line'], [refusedBy('no session carries that id')])
    await h.call('sendWords', ['drop this line'], ['drop'])
    h.breakCarrier('ECONNREFUSED')
    await h.call('sendWords', ['the daemon is away'])
    h.mendCarrier()
    await h.call('sendWords', ['ls -la', { mode: 'bash' }], [dispatched])
    await h.call('sendWords', ['/compact now', { metaFrom: { command: '/compact' } }], [dispatched])
    await h.call('sendWords', ['look at this', { pastedContents: { 1: { id: 1, type: 'image', content: 'aGVsbG8=', mediaType: 'image/png' } } }], [dispatched])
    await h.call('dispatchSlash', ['status'], [dispatched])
    await h.call('dispatchSlash', ['  /model opus '], [refusedBy('unknown command')])
    await h.call('sendAgentNote', ['agent-7', '  a note for the crewmate  '], [dispatched])
    await h.call('sendAgentNote', ['agent-7', '   '])
    await h.call('sendAgentNote', ['', 'a note for nobody'])
    await h.call('sendAgentNote', ['agent-7', 'a note that is refused'], [refusedBy('the crewmate ended')])
    await h.call('sendAgentNote', ['agent-7', 'a note with no reason'], [{ ok: false, code: 'EREFUSED' }])
    h.breakCarrier('ECONNREFUSED')
    await h.call('sendAgentNote', ['agent-7', 'a note to a daemon that is away'])
    h.mendCarrier()
  })

  await scenario('asks-answered-and-settled', async h => {
    await h.hold(true)
    await h.transcript('a turn asks to run a tool', [h.user('clean the build'), h.assistant('msg_ask', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rm -rf build' } }])])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.asks([
      { requestId: 'ask-1', toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'rm -rf build' }, description: 'remove the build folder', askedAt: clock.now(), cwd: work, decisionReason: 'the rule asks' },
      { requestId: 'ask-2', toolUseId: 'toolu_2', toolName: 'mcp__files__write', input: { path: 'a.txt' }, description: 'write a.txt', askedAt: clock.now(), agentId: 'agent-3', limitMs: 60000, blockedPath: '/etc/hosts' },
    ])
    await h.rereadAsks()
    await h.asks([
      { requestId: 'ask-1', toolUseId: 'toolu_1', toolName: 'Bash', input: { command: 'rm -rf build' }, description: 'remove the build folder', askedAt: clock.now(), cwd: work, decisionReason: 'the rule asks' },
      { requestId: 'ask-2', toolUseId: 'toolu_2', toolName: 'mcp__files__write', input: { path: 'a.txt' }, description: 'write a.txt', askedAt: clock.now(), agentId: 'agent-3', limitMs: 60000, blockedPath: '/etc/hosts' },
    ])
    await h.call('answerAsk', ['ask-1', { kind: 'allow', updatedInput: { command: 'rm -rf build' }, permissionUpdates: [] }], [applied()])
    await h.call('answerAsk', ['ask-9', { kind: 'deny' }])
    await h.call('answerAsk', ['ask-2', { kind: 'deny', feedback: 'not that file' }], [applied()])
    await h.asks([{ requestId: 'ask-3', toolUseId: 'toolu_3', toolName: 'Bash', input: { command: 'make' }, description: 'run make', askedAt: clock.now() }])
    await h.call('answerAsk', ['ask-3', { kind: 'allow', feedback: '  and be careful  ' }], [applied(), dispatched])
    await h.asks([
      { requestId: 'ask-4', toolUseId: 'toolu_4', toolName: 'Bash', input: { command: 'one' }, description: 'run one', askedAt: clock.now() },
      { requestId: 'ask-5', toolUseId: 'toolu_5', toolName: 'Bash', input: { command: 'two' }, description: 'run two', askedAt: clock.now() },
      { requestId: 'ask-6', toolUseId: 'toolu_6', toolName: 'Bash', input: { command: 'three' }, description: 'run three', askedAt: clock.now() },
      { requestId: 'ask-7', toolUseId: 'toolu_7', toolName: 'Bash', input: { command: 'four' }, description: 'run four', askedAt: clock.now() },
    ])
    await h.call('settleAsk', ['ask-4'])
    await h.call('settleAsk', ['ask-4'])
    const card = (id: string): { onAbort: () => void; onAllow: (...a: unknown[]) => Promise<void>; onReject: (...a: unknown[]) => Promise<void> } =>
      (h.connector.asks() as Array<{ id: string; confirm: never }>).find(a => a.id === id)!.confirm
    const abort = card('ask-5')
    await h.step('the card of ask-5 is aborted', [applied()], () => abort.onAbort())
    const allow = card('ask-6')
    await h.step('the card of ask-6 is allowed', [applied()], () => allow.onAllow({ command: 'three' }, [], undefined, undefined))
    const reject = card('ask-7')
    await h.step('the card of ask-7 is rejected and the daemon says it was answered already', [outcome('refused', { detail: 'the ask was already answered' })], () => reject.onReject('no', undefined))
    await h.asks([{ requestId: 'ask-8', toolUseId: 'toolu_8', toolName: 'Bash', input: { command: 'five' }, description: 'run five', askedAt: clock.now() }])
    h.breakCarrier('ECONNREFUSED')
    await h.call('answerAsk', ['ask-8', { kind: 'allow' }])
    h.mendCarrier()
    await h.asks([{ requestId: 'ask-10', toolUseId: 'toolu_10', toolName: 'Bash', input: { command: 'six' }, description: 'run six', askedAt: clock.now() }])
    await h.facts({ busy: false })
    await h.call('interrupt', [], [applied()])
    await h.asks(null)
    await h.asks([])
  })

  await scenario('interrupt-mid-turn', async h => {
    await h.hold(true)
    await h.call('interrupt')
    await h.transcript('a turn begins', [h.user('write the long answer')])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.tail({ text: 'the half-written', messageId: 'msg_cut', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 16, lastEventAtMs: clock.now() })
    await h.call('interrupt', [], [applied()])
    await h.tail({ text: 'the half-written and more after the press', messageId: 'msg_cut', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 41, lastEventAtMs: clock.now() })
    await h.call('interrupt', [], [applied()])
    await h.call('interrupt')
    await h.advance(20)
    await h.facts({ busy: false })
    await h.tail({ text: null, messageId: 'msg_cut' })
    await h.advance(20)
    await h.transcript('the next turn begins', [h.user('try again')])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.tail({ text: 'a reply that keeps', messageId: 'msg_kept', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 18, lastEventAtMs: clock.now() })
    await h.call('interrupt', [], [outcome('refused', { detail: 'nothing to interrupt' })])
    await h.tail({ text: 'a reply that keeps going', messageId: 'msg_kept', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 24, lastEventAtMs: clock.now() })
    h.breakCarrier('ECONNREFUSED')
    await h.call('interrupt')
    h.mendCarrier()
    await h.tail({ text: null, messageId: 'msg_kept', streamBlock: 'tool_use', blockSinceMs: clock.now() })
    await h.call('interrupt', [], [applied()])
    await h.transcript('the cut turn lands', [h.assistant('msg_kept', [{ type: 'text', text: 'a reply that keeps going' }])])
    await h.facts({ busy: false })
  })

  await scenario('rewind', async h => {
    await h.hold(true)
    await h.transcript('two turns stand', [h.user('the first ask'), h.assistant('msg_1', [{ type: 'text', text: 'the first answer' }]), h.user('the second ask'), h.assistant('msg_2', [{ type: 'text', text: 'the second answer' }])])
    await h.facts({ busy: false, fileCheckpoints: { capture: true, restorable: [h.uuidOf(2)], files: ['src/a.ts'], undo: h.uuidOf(2) } })
    await h.call('addDisplayRow', [{ type: 'system', subtype: 'seat_receipt', uuid: '00000000-0000-4000-8000-0000000000aa', timestamp: new Date(clock.now()).toISOString(), content: 'a line below the second turn', level: 'info' }])
    const second = h.uuidOf(2)
    await h.call('rewind', [{ mode: 'conversation', userMessageId: second, dryRun: true }], [{ ok: true, op: 'sessionRewind', outcome: 'applied', dryRun: true, conversation: { removed: 2 } }])
    await h.call('rewind', [{ mode: 'conversation', userMessageId: second }], [{ ok: true, op: 'sessionRewind', outcome: 'applied', conversation: { removed: 2 }, code: { restored: 1 }, detail: 'two rows left the conversation' }])
    await h.cutTranscript('the conversation is cut back to the first turn', 2)
    await h.transcript('a new second turn', [h.user('the second ask, again')])
    await h.call('rewind', [{ mode: 'code', userMessageId: second, filePath: 'src/a.ts' }], [{ ok: true, op: 'sessionFileRestore', outcome: 'applied', detail: 'src/a.ts restored' }])
    await h.call('rewind', [{ mode: 'code', userMessageId: second, undo: true, dryRun: true }], [{ ok: true, op: 'sessionFileRestore', outcome: 'noop', dryRun: true }])
    await h.call('rewind', [{ mode: 'both', userMessageId: second }], [{ ok: true, op: 'sessionRewind', outcome: 'refused', refusal: 'turn-in-flight', detail: 'a turn is running' }])
    await h.call('rewind', [{ mode: 'both', userMessageId: second }], [refusedBy('nothing to rewind')])
    await h.call('rewind', [{ mode: 'both', userMessageId: second }], [{ ok: false, code: 'EREFUSED' }])
    await h.call('rewind', [{ mode: 'both', userMessageId: second }], [refusedBy('the daemon is an older build', { refusal: 'daemon-older' })])
    await h.call('rewind', [{ mode: 'both', userMessageId: second }], [{ ok: true, op: 'sessionRewind', outcome: 'queued' }])
    h.breakCarrier('ECONNREFUSED')
    await h.call('rewind', [{ mode: 'both', userMessageId: second }])
    h.mendCarrier()
    await h.facts({ busy: false })
  })

  await scenario('fold-and-its-exit', async h => {
    const fold = (extra: Row = {}): Row => ({ schema: 1, trigger: 'auto', startedAtMs: CLOCK_ZERO, stages: ['summarising', 'restoring'], stage: 'summarising', fill: 0.4, summaryTokens: 10, summaryCapTokens: 100, attempt: 1, ...extra })
    await h.hold(true)
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.tail({ stateWord: 'compacting', fold: fold() })
    await h.call('sendWords', ['words sent under the fold'], [dispatched])
    const held = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: held, value: 'words sent under the fold', mode: 'prompt' }] })
    await h.tail({ stateWord: 'compacting', fold: fold({ stage: 'restoring', fill: 0.9 }) })
    await h.advance(100)
    await h.tail({ fold: fold({ stage: 'restoring', exit: 'landed', endedAtMs: clock.now() }) })
    await h.advance(4999)
    await h.advance(1)
    await h.tail({})
    await h.tail({ stateWord: 'compacting', fold: fold({ trigger: 'manual', startedAtMs: clock.now() }) })
    await h.tail({})
    await h.advance(5000)
    await h.tail({ stateWord: 'compacting', fold: fold({ trigger: 'manual', startedAtMs: clock.now() }) })
    await h.facts({ busy: false, runnerGeneration: 1, queue: [{ uuid: held, value: 'words sent under the fold', mode: 'prompt' }] })
    await h.advance(5000)
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.tail({ stateWord: 'compacting', fold: fold({ startedAtMs: clock.now() }) })
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.tail({ fold: fold({ exit: 'failed', endedAtMs: clock.now() - 60_000, reason: 'the summary was refused' }) })
    await h.advance(0)
    await h.tail(null)
  })

  await scenario('model-and-effort', async h => {
    await h.call('setModel', ['claude-opus-5'], [applied()])
    await h.facts({ busy: false })
    await h.call('setModel', ['claude-opus-5', 'the words that asked'], [applied({ detail: 'runner-model-and-effort → claude-opus-5' })])
    await h.call('setModel', ['claude-opus-5'])
    await h.facts({ busy: false, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' } })
    await h.call('setModel', ['claude-sonnet-5-5'], [applied({ detail: 'the runner restarted on claude-sonnet-5-5', respawned: true })])
    await h.facts({ busy: true, turnStartedAt: clock.now(), model: { effective: 'claude-sonnet-5-5', setting: 'claude-sonnet-5-5' } })
    await h.call('setModel', ['claude-opus-5'], [outcome('queued')])
    await h.facts({ busy: true, model: { effective: 'claude-sonnet-5-5', setting: 'claude-sonnet-5-5' }, pendingModel: 'claude-opus-5' })
    await h.facts({ busy: false, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, modelSettled: { from: 'claude-sonnet-5-5', to: 'claude-opus-5', atMs: clock.now() } })
    await h.call('setModel', ['gpt-6.2-sol'], [outcome('refused', { detail: 'that model is not on this plan' })])
    await h.call('setModel', ['gpt-6.2-sol'], [refusedBy('the daemon refused it')])
    await h.call('setModel', ['gpt-6.2-sol'], [outcome('queued')])
    await h.call('setModel', ['gpt-6.2-sol'], [outcome('noop')])
    await h.facts({ busy: false, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' } })
    await h.call('setModel', ['gpt-6.2-sol'], [outcome('weird')])
    h.breakCarrier('ECONNREFUSED')
    await h.call('setModel', ['gpt-6.2-sol'])
    h.mendCarrier()
    await h.call('setEffort', ['high'], [applied()])
    await h.call('setEffort', ['high'])
    await h.facts({ busy: true, turnStartedAt: clock.now(), model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, effort: 'high', effortSent: 'high' })
    await h.call('setEffort', ['max'], [outcome('queued')])
    await h.call('setEffort', ['low'], [applied()])
    await h.call('setEffort', ['low'], [outcome('refused', { detail: 'this model takes no effort' })])
    await h.call('setEffort', ['low'], [refusedBy('the daemon refused it')])
    await h.call('setEffort', ['low'], [outcome('noop')])
    await h.call('setEffort', ['low'], [outcome('weird')])
    h.breakCarrier('ECONNREFUSED')
    await h.call('setEffort', ['low'])
    h.mendCarrier()
    await h.advance(4000)
  })

  await scenario('permission-mode', async h => {
    await h.call('setPermissionMode', ['implement'], [applied()])
    await h.facts({ busy: false })
    await h.call('setPermissionMode', ['implement'], [applied({ detail: 'edits are accepted from here' })])
    await h.facts({ busy: false, permissionMode: 'implement' })
    await h.call('setPermissionMode', ['implement'], [outcome('noop')])
    await h.call('setPermissionMode', ['sovereign'], [outcome('refused', { detail: 'this seat may not run sovereign' })])
    await h.call('setPermissionMode', ['apollo'], [refusedBy('the daemon refused it')])
    h.breakCarrier('ECONNREFUSED')
    await h.call('setPermissionMode', ['apollo'])
    h.mendCarrier()
    await h.facts({ busy: false, permissionMode: 'apollo' })
    await h.advance(4000)
  })

  await scenario('carrier-gone-and-back', async h => {
    h.daemonRecord('alive')
    await h.hold(true)
    await h.transcript('a turn waits on its crew', [h.user('run the errands'), h.assistant('msg_crew', [{ type: 'tool_use', id: 'toolu_crew', name: 'Crewmate', input: { prompt: 'go' } }])])
    await h.facts({ busy: true, turnStartedAt: clock.now(), work: [crewRow('agent-a', 'running')], mission: [{ id: 'm1', title: 'the mission', status: 'running' }], samples: [{ id: 's1', label: 'a sample' }] })
    await h.beat()
    h.daemonRecord('gone')
    for (let i = 0; i < 3; i++) await h.beat()
    await h.beat()
    await h.rereadFacts()
    await h.facts({ busy: true, turnStartedAt: clock.now(), work: [crewRow('agent-a', 'running')] })
    for (let i = 0; i < 3; i++) await h.beat()
    await h.dropFacts()
  })

  await scenario('transcript-unreadable', async h => {
    await h.hold(true)
    await h.spoilTranscript('a folder stands where the transcript should be', () => mkdirSync(h.transcriptPath, { recursive: true }))
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.facts({ busy: false })
    await h.spoilTranscript('the folder is gone and no transcript stands', () => rmSync(h.transcriptPath, { recursive: true, force: true }))
    await h.transcript('a readable transcript', [h.user('now it reads'), h.assistant('msg_ok', [{ type: 'text', text: 'it does' }])])
    await h.spoilTranscript('a line that is no record is appended', () => appendFileSync(h.transcriptPath, 'not-a-record\n'))
    await h.spoilTranscript('the transcript is emptied', () => writeFileSync(h.transcriptPath, ''))
  })

  await scenario('turn-completes-while-a-send-waits', async h => {
    h.workers({})
    await h.hold(true)
    await h.transcript('the first turn begins', [h.user('the first ask')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.call('sendWords', ['the next thing'], [dispatched])
    const waitingSend = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: waitingSend, value: 'the next thing', mode: 'prompt' }] })
    await h.advance(100)
    h.unwrittenTranscript([h.assistant('msg_first', [{ type: 'text', text: 'the first answer' }])])
    h.workers({ lastTurnSettledAt: clock.now(), lastDeliveryAt: clock.now() - 100 })
    await h.facts({ busy: false, runnerGeneration: 1, queue: [{ uuid: waitingSend, value: 'the next thing', mode: 'prompt' }] })
    await h.advance(100)
    h.workers({ lastTurnSettledAt: clock.now() - 100, lastDeliveryAt: clock.now() })
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.transcript('the waiting send lands and is answered', [h.user('the next thing', { uuid: waitingSend }), h.assistant('msg_second', [{ type: 'text', text: 'the second answer' }])])
    await h.advance(100)
    h.workers({ lastTurnSettledAt: clock.now(), lastDeliveryAt: clock.now() - 100 })
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.call('sendWords', ['sent at rest'], [dispatched])
    const atRest = sentId(h)
    await h.facts({ busy: false, runnerGeneration: 1, queue: [{ uuid: atRest, value: 'sent at rest', mode: 'prompt' }] })
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.advance(100)
    h.workers({ lastTurnSettledAt: clock.now(), lastDeliveryAt: clock.now() - 50 })
    await h.facts({ busy: false, runnerGeneration: 1 })
    h.workers({ lastTurnSettledAt: clock.now(), lastDeliveryAt: clock.now() - 50, endedAt: clock.now() })
    await h.facts({ busy: false, runnerGeneration: 1 })
    h.workers(null)
    await h.facts({ busy: false, runnerGeneration: 1 })
  })

  await scenario('work-checkpoints-and-verbs', async h => {
    await h.facts({
      busy: false,
      work: [crewRow('agent-a', 'running', { pendingAsks: 1 }), { id: 'sh-1', kind: 'shell', name: 'npm test', status: 'running', startTime: CLOCK_ZERO - 5000, command: 'npm test' }, crewRow('agent-b', 'completed', { endTime: CLOCK_ZERO - 1000 })],
      mission: [{ id: 'm1', title: 'the mission', status: 'running' }],
      missionCard: { title: 'the card', lines: ['one', 'two'] },
      samples: [{ id: 's1', label: 'a sample' }],
      pauseGate: { paused: false },
      advisor: { state: 'ready', model: 'claude-opus-5' },
      fileCheckpoints: { capture: true, restorable: ['u1', 'u2'], files: ['src/a.ts'], undo: 'u2' },
      editOutcomes: [{ path: 'src/a.ts', outcome: 'applied' }],
      skills: [{ name: 'review', source: 'project' }],
      mcp: [{ name: 'files', state: 'connected' }],
      spawnSwitches: { subagents: { on: false, source: 'operator' }, workflows: { on: true, source: 'default' } },
      usage: { ...baseFacts.usage, totalCostUSD: 1.25, totalInputTokens: 1000, totalOutputTokens: 200 },
      identity: { firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: 'owner@example.com' },
      streamIdleTimeoutMs: 90000,
      transcriptStoreFailing: 'the transcript store is full',
    })
    await h.facts({ busy: false, fileCheckpoints: { capture: false, restorable: [] } })
    await h.facts({ busy: false })
    await h.call('stopAgent', ['agent-a', 'enough'], [applied({ detail: 'agent-a stopped' })])
    await h.call('stopAgent', [''])
    await h.call('resumeAgent', ['agent-a'], [refusedBy('the crewmate ended')])
    await h.call('resumeAgent', ['agent-a', 'go on'], [outcome('queued')])
    await h.call('backgroundShell', [], [applied({ detail: 'the shell runs in the background' })])
    await h.call('backgroundShell', [], [applied()])
    await h.call('backgroundShell', [], [refusedBy('no shell runs')])
    await h.call('backgroundShell', [], [outcome('noop', { detail: 'nothing to background' })])
    await h.call('sendNow', [], [applied()])
    await h.call('sendNow', [], [outcome('noop')])
    await h.call('sendNow', [], [{ ok: false, code: 'EREFUSED' }])
    await h.call('pauseGate', [true], [applied({ detail: 'the gate is closed' })])
    await h.call('pauseGate', [false], [outcome('refused', { detail: 'no gate stands' })])
    await h.call('pauseGate', [false], [refusedBy('the daemon refused it')])
    await h.call('postBoard', [{ clientOpId: 'op-1', text: 'a post', kind: 'ask' }], [applied({ detail: JSON.stringify({ ok: true, event_id: 'ev-1', seq: 4, replay: false, address: '@main', recipients: ['main'] }) })])
    await h.call('postBoard', [{ clientOpId: 'op-2', text: 'a post', kind: 'ask' }], [applied({ detail: JSON.stringify({ ok: false, reason: 'no such seat', candidates: ['main'] }) })])
    await h.call('postBoard', [{ clientOpId: 'op-3', text: 'a post', kind: 'ask' }], [applied({ detail: 'not json' })])
    await h.call('postBoard', [{ clientOpId: 'op-4', text: 'a post', kind: 'ask' }], [outcome('refused')])
    await h.call('postBoard', [{ clientOpId: 'op-5', text: 'a post', kind: 'ask' }], [refusedBy('the board is closed')])
    await h.call('setKit', [{ kind: 'skill', name: 'review', on: false }], [applied({ detail: 'review is off' })])
    await h.call('setKit', [{ kind: 'skill', name: 'review', on: true }], [outcome('queued')])
    await h.call('setKit', [{ kind: 'skill', name: 'review', on: true }], [outcome('weird')])
    await h.call('setKit', [{ kind: 'skill', name: 'review', on: true }], [refusedBy('the daemon refused it')])
    await h.call('setSpawnSwitch', ['subagents', true], [applied({ detail: 'crewmates are on' })])
    await h.call('setSpawnSwitch', ['workflows', false], [outcome('noop')])
    await h.call('setSpawnSwitch', ['workflows', false], [outcome('weird')])
    await h.call('setSpawnSwitch', ['workflows', false], [refusedBy('the daemon refused it')])
    await h.call('mcpAction', ['files', 'reconnect'], [applied({ detail: 'files reconnected' })])
    await h.call('mcpAction', ['files', 'authenticate'], [outcome('refused', { detail: 'the server needs a browser' })])
    await h.call('mcpAction', ['files', 'cancel-auth'], [refusedBy('nothing to cancel')])
    await h.call('mcpTools', ['files'], [applied({ mcpTools: mcpToolsAnswerOf('files', [{ name: 'write', registeredAs: 'mcp__files__write', description: 'write a file', inputSchema: { type: 'object' }, loading: 'listed' }]) })])
    await h.call('mcpTools', ['files'], [applied({ mcpTools: { server: 'files' } })])
    await h.call('mcpTools', ['files'], [outcome('refused', { detail: 'the server is disabled' })])
    await h.call('mcpTools', ['files'], [outcome('refused')])
    await h.call('mcpTools', ['files'], [refusedBy('the daemon refused it')])
    h.breakCarrier('ECONNREFUSED')
    await h.call('stopAgent', ['agent-a'])
    await h.call('backgroundShell')
    await h.call('sendNow')
    await h.call('pauseGate', [true])
    await h.call('postBoard', [{ clientOpId: 'op-6', text: 'a post', kind: 'ask' }])
    await h.call('setKit', [{ kind: 'skill', name: 'review', on: true }])
    await h.call('setSpawnSwitch', ['subagents', false])
    await h.call('mcpAction', ['files', 'reconnect'])
    await h.call('mcpTools', ['files'])
    h.mendCarrier()
    await h.dropFacts()
  })

  await scenario('admission', async h => {
    const gate = (): { promise: Promise<string | null>; open: (refusal: string | null) => void; awaitedTimes: (n: number) => Promise<void> } => {
      let open: (refusal: string | null) => void = () => {}
      const inner = new Promise<string | null>(resolve => (open = resolve))
      let thens = 0
      let waiters: Array<{ n: number; wake: () => void }> = []
      const promise = {
        then: (onDone: (v: string | null) => unknown, onFail?: (e: unknown) => unknown) => {
          thens++
          const ready = waiters.filter(w => thens >= w.n)
          waiters = waiters.filter(w => thens < w.n)
          for (const w of ready) w.wake()
          return inner.then(onDone, onFail)
        },
        finally: (after: () => void) => inner.finally(after),
      } as unknown as Promise<string | null>
      return { promise, open, awaitedTimes: n => (thens >= n ? Promise.resolve() : new Promise(wake => waiters.push({ n, wake }))) }
    }
    const first = gate()
    await h.call('awaitAdmission', [first.promise])
    await h.step('the admission ends with no refusal', [], () => first.open(null))
    const second = gate()
    await h.call('awaitAdmission', [second.promise])
    await h.step('the admission is refused', [], () => second.open('the runner could not start'))
    const third = gate()
    await h.call('awaitAdmission', [third.promise])
    void third.awaitedTimes(2).then(() => third.open('the workspace is held by another session'))
    await h.call('sendWords', ['words sent while the runner is admitted'])
    await h.call('awaitAdmission', [Promise.resolve('the second refusal')])
    await h.advance(250)
    await h.call('sendWords', ['words that reopen the session'], [dispatched])
    await h.facts({ busy: false })
    await h.advance(250)
    await h.facts({ busy: false, runner: { state: 'starting', sinceMs: clock.now() + 500, respawns: 0, maxRespawns: 3 } })
    await h.facts({ busy: false, runner: { state: 'crashed', sinceMs: clock.now(), respawns: 1, maxRespawns: 3, reason: 'the runner fell over' } })
    await h.call('adoptRecord', [{ sessionId: 'another-session', runnerId: 'runner-x', title: 'x', projectLabel: 'x', workspaceId: work, home: h.home }])
    await h.call('adoptRecord', [{ sessionId: h.sessionId, runnerId: 'runner-new', title: 'the admission chat, renamed', projectLabel: 'proof', workspaceId: work, home: h.home, modelKey: 'claude-opus-5', effort: 'high', isolation: 'worktree-isolated', branchLabel: 'lane-x', worktreePath: join(work, 'wt') }, true])
    await h.advance(250)
    await h.call('adoptRecord', [{ sessionId: h.sessionId, runnerId: '', title: 'the admission chat, parked', projectLabel: 'proof', workspaceId: work, home: h.home, modelKey: 'claude-opus-5' }])
    await h.rereadFacts('facts no newer than the seed are read')
    await h.call('adoptRecord', [{ sessionId: h.sessionId, runnerId: 'runner-newer', title: 'the admission chat, back', projectLabel: 'proof', workspaceId: work, home: h.home, modelKey: 'claude-opus-5' }, true])
    await h.call('adoptRecord', [{ sessionId: h.sessionId, runnerId: '', title: 'the admission chat, parked again', projectLabel: 'proof', workspaceId: work, home: h.home }])
    await h.advance(250)
    await h.facts({ busy: false, runner: { state: 'starting', sinceMs: clock.now() + 900, respawns: 0, maxRespawns: 3 } })
  }, { runnerId: '', modelKey: 'claude-sonnet-5-5' })

  await scenario('notices-and-a-runner-restart', async h => {
    const first = notice('t-1', 'the first errand')
    const second = notice('t-2', 'the second errand')
    await h.hold(true)
    await h.transcript('a turn begins', [h.user('send out the crew')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1, queue: [{ value: first, mode: 'task-notification' }] })
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ value: first, mode: 'task-notification' }, { value: second, mode: 'task-notification', origin: { kind: 'task-notification' } }, { value: 'a meta line', mode: 'task-notification', isMeta: true }] })
    await h.advance(100)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ value: second, mode: 'task-notification' }] })
    await h.advance(100)
    await h.transcript('the first notice lands as a row', [h.user(first)])
    await h.facts({ busy: true, runnerGeneration: 1, queue: [], queueReady: false })
    await h.facts({ busy: true, runnerGeneration: 1, queue: [] })
    await h.call('sendWords', ['words the runner will keep'], [dispatched])
    const kept = sentId(h)
    await h.call('sendWords', ['words the runner will lose'], [dispatched])
    const lost = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: kept, value: 'words the runner will keep', mode: 'prompt' }, { uuid: lost, value: 'words the runner will lose', mode: 'prompt' }] })
    await h.tail({ text: 'words of the old runner', messageId: 'msg_old', streamBlock: 'text', blockSinceMs: clock.now() })
    await h.tail({ text: null, messageId: 'msg_old', streamBlock: 'tool_use', blockSinceMs: clock.now() })
    await h.advance(100)
    await h.facts({ busy: false, runnerGeneration: 2, queue: [], recoveredCommandIds: [kept] })
    await h.advance(100)
    await h.transcript('the kept words land under another identity', [h.user('words the runner will keep')])
    await h.facts({ busy: false, runnerGeneration: 3, queue: [] })
  })

  await scenario('leave', async h => {
    await h.call('leave', [], [applied({ detail: JSON.stringify({ note: 'stored', noteChars: 120 }) })])
    await h.call('leave', [], [applied({ detail: JSON.stringify({ note: 'skipped' }) })])
    await h.call('leave', [], [applied({ detail: JSON.stringify({ note: 'none', noteChars: -1 }) })])
    await h.call('leave', [], [applied({ detail: 'no receipt here' })])
    await h.call('leave', [], [applied({ detail: JSON.stringify({ note: 'other' }) })])
    await h.call('leave', [], [applied()])
    await h.call('leave', [], [outcome('refused', { detail: 'a turn is running' })])
    await h.call('leave', [], [outcome('refused')])
    await h.call('leave', [], [refusedBy('the daemon refused it')])
    await h.call('leave', [], ['drop'])
    const gone = new AbortController()
    gone.abort()
    await h.call('leave', [{ signal: gone.signal }])
    const skipped = new AbortController()
    await h.call('leave', [{ signal: skipped.signal }], [
      req => {
        if (req.action === 'leave') skipped.abort()
        return applied({ detail: JSON.stringify({ note: 'skipped' }) })
      },
      { apart: applied() },
    ])
  })

  await scenario('tail-and-text-rows', async h => {
    await h.hold(true)
    await h.transcript('a turn begins', [h.user('think, then call a tool')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1, work: [crewRow('agent-a', 'running'), { id: 'sh-1', kind: 'shell', name: 'npm test', status: 'running', startTime: CLOCK_ZERO }] })
    await h.tail({ wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'claude-sonnet-5-5', budgetMs: 60000, sinceMs: clock.now(), attempt: 1, promise: true }, lastEventAtMs: clock.now() })
    await h.advance(700)
    await h.tail({ wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'claude-sonnet-5-5', budgetMs: 60000, sinceMs: clock.now() - 700, attempt: 1 }, lastEventAtMs: clock.now() - 700 })
    await h.tail({ streamBlock: 'thinking', blockSinceMs: clock.now(), turnChars: 40, turnThinkingChars: 40, turnThinkingBlocks: 1, firstByteAtMs: clock.now(), lastEventAtMs: clock.now() })
    await h.advance(300)
    await h.tail({ text: 'carried', messageId: 'msg_mid', phase: 'commentary', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 47, turnThinkingChars: 40, turnThinkingBlocks: 1, turnOutputTokens: 9, lastEventAtMs: clock.now() })
    await h.tail({ text: 'carried to the owner, waiting', messageId: 'msg_mid', phase: 'commentary', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 69, turnThinkingChars: 40, turnThinkingBlocks: 1, turnOutputTokens: 14, lastEventAtMs: clock.now() })
    await h.rereadTail()
    await h.advance(100)
    await h.tail({ text: null, messageId: 'msg_mid', streamBlock: 'tool_use', blockSinceMs: clock.now(), turnChars: 69, lastEventAtMs: clock.now() })
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ value: notice('t-after', 'the errand after the words'), mode: 'task-notification' }] })
    await h.transcript('the words land as a record with a tool call', [h.assistant('msg_mid', [{ type: 'text', text: 'carried to the owner, waiting' }, { type: 'tool_use', id: 'toolu_mid', name: 'Bash', input: { command: 'sleep 1' } }])])
    await h.advance(2500)
    await h.tail({ stateWord: 'waiting-on-agents', waitingOnAgents: 2, lastEventAtMs: clock.now() - 2500 })
    await h.transcript('the tool answers', [h.toolResult('toolu_mid', 'slept')])
    await h.tail({ stateWord: 'waiting-on-agents', waitingOnAgents: 1, lastEventAtMs: clock.now() })
    await h.tail({ text: 'a draft the model takes back', messageId: 'msg_taken_back', phase: 'final_answer', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.tail({ text: null, messageId: 'msg_taken_back', streamBlock: 'tool_use', blockSinceMs: clock.now() })
    await h.tail({ text: null, withdrawn: 'msg_taken_back' })
    await h.tail({ text: 'the final words', messageId: 'msg_final', phase: 'final_answer', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.transcript('the final words land', [h.assistant('msg_final', [{ type: 'text', text: 'the final words' }])])
    await h.tail({ text: 'words nobody identified', streamBlock: 'text', blockSinceMs: clock.now() })
    await h.tail({ text: null })
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.tail(null)
    await h.advance(700_000)
    await h.transcript('a later turn retires what is left', [h.user('much later')])
  })

  await scenario('display-rows', async h => {
    const row = (subtype: string, n: number, content: string): Row => ({ type: 'system', subtype, uuid: `00000000-0000-4000-8000-0000000000b${n}`, timestamp: new Date(clock.now()).toISOString(), content, level: 'info' })
    await h.call('addDisplayRow', [row('seat_receipt', 1, 'a line before any record')])
    await h.hold(true)
    await h.transcript('a turn stands', [h.user('the ask'), h.assistant('msg_1', [{ type: 'text', text: 'the answer' }])])
    await h.call('addDisplayRow', [row('away_summary', 2, 'while you were away: one')])
    await h.call('addDisplayRow', [row('seat_receipt', 3, 'a line after the turn')])
    await h.call('addDisplayRow', [row('away_summary', 4, 'while you were away: two')])
    await h.transcript('another turn stands below', [h.user('the next ask')])
    await h.call('addDisplayRow', [createSeatReceiptMessage('a receipt the seat wrote', 'warning')])
  })

  await scenario('tool-progress', async h => {
    await h.call('attach', [], [{ apart: applied() }])
    await h.call('detach')
  }, {}, h => {
    h.seed([h.user('run the tests'), h.assistant('msg_tool', [{ type: 'tool_use', id: 'toolu_run', name: 'Bash', input: { command: 'npm test' } }])])
    h.publishFacts({ busy: true, turnStartedAt: clock.now() - 9000 })
    projections.publishSessionTail({ schema: 1, sessionId: h.sessionId, atMs: clock.now(), text: null, streamBlock: 'tool_use', blockSinceMs: clock.now() - 4000, lastEventAtMs: clock.now() - 4000 }, daemonDir)
    h.publishProgress({
      toolu_run: { toolUseID: 'toolu_inner', dataType: 'bash_progress', seq: 3, latestLine: 'ok 12 tests', elapsedTimeSeconds: 4, totalLines: 12, totalBytes: 600, budgetMs: 120000 },
      toolu_hook: { toolUseID: 'toolu_hook_inner', dataType: 'hook_progress', seq: 1, latestLine: 'the hook waits', elapsedTimeSeconds: 1, budgetMs: 5000 },
      toolu_eval: { toolUseID: 'toolu_eval_inner', dataType: 'eval_progress', seq: 1, latestLine: 'a cell runs', elapsedTimeSeconds: 2 },
      toolu_mcp: { toolUseID: 'toolu_mcp_inner', dataType: 'mcp_progress', seq: 1, latestLine: 'half way', mcpProgress: 5, mcpTotal: 10 },
      toolu_ps: { toolUseID: 'toolu_ps_inner', dataType: 'powershell_progress', seq: 1, latestLine: 'a line', totalLines: 1 },
    })
  }, 'real')

  await scenario('busy-turn-with-no-facts', async h => {
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.advance(44_999)
    await h.advance(1, [applied()])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.advance(45_000, [outcome('refused', { detail: 'no runner holds the session' })])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.advance(45_000, [refusedBy('no such session')])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    h.breakCarrier('ECONNREFUSED')
    await h.advance(45_000)
    h.mendCarrier()
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.facts({ busy: false })
    await h.advance(45_000)
  })

  await scenario('feeds-while-attached', async h => {
    await h.call('attach', [], [{ apart: applied() }])
    await h.feed('the facts', () => h.publishFacts({ busy: false, effort: 'high', work: [crewRow('agent-a', 'running')] }))
    await h.feed('the same facts, published again', () => h.publishFacts({ busy: false, effort: 'high', work: [crewRow('agent-a', 'running')] }))
    await h.feed('an ask', () => projections.publishSessionAsks({ schema: 1, sessionId: h.sessionId, asks: [{ requestId: 'ask-fed', toolUseId: 'toolu_fed', toolName: 'Bash', input: { command: 'ls' }, description: 'list the folder', askedAt: clock.now() }] }, daemonDir))
    await h.feed('the tail', () => projections.publishSessionTail({ schema: 1, sessionId: h.sessionId, atMs: clock.now(), text: 'words through the feed', messageId: 'msg_fed', turnChars: 22 }, daemonDir))
    await h.feed('tool progress', () => h.publishProgress({ toolu_fed: { toolUseID: 'toolu_fed_inner', dataType: 'bash_progress', seq: 1, latestLine: 'one line', elapsedTimeSeconds: 1, totalLines: 1, budgetMs: 60000 } }))
    await h.feed('tool progress that moved, and one that did not', () => h.publishProgress({ toolu_fed: { toolUseID: 'toolu_fed_inner', dataType: 'bash_progress', seq: 2, latestLine: 'two lines', elapsedTimeSeconds: 2, totalLines: 2, budgetMs: 60000 }, toolu_old: { toolUseID: 'toolu_old_inner', dataType: 'bash_progress', seq: 0 } }))
    await h.feed('no tool progress', () => h.publishProgress({}))
    await h.feed('nothing new', () => {})
    await h.call('detach')
  }, {}, () => {}, 'real')

  await scenario('a-watchdog-the-facts-spell-as-text', async h => {
    await h.facts({ busy: true, turnStartedAt: clock.now(), streamIdleTimeoutMs: '90000' })
    await h.tail({ text: 'words', messageId: 'msg_w', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.advance(44_000)
    await h.advance(1_000, [applied()])
    await h.advance(44_000)
    await h.advance(1_000, [applied()])
    await h.facts({ busy: false })
  })

  await scenario('the-setting-chosen-again-while-another-model-serves', async h => {
    await h.facts({ busy: false, model: { effective: 'claude-haiku-5', setting: 'claude-opus-5' } })
    await h.call('setModel', ['claude-opus-5'], [outcome('noop')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), model: { effective: 'claude-haiku-5', setting: 'claude-opus-5' } })
    await h.call('setModel', ['claude-opus-5'], [outcome('noop')])
    await h.facts({ busy: false, model: { effective: 'claude-haiku-5', setting: 'claude-opus-5' } })
  })

  const foldRecord = (extra: Row = {}): Row => ({ schema: 1, trigger: 'auto', startedAtMs: CLOCK_ZERO, stages: ['summarising', 'restoring'], stage: 'summarising', fill: 0.4, summaryTokens: 10, summaryCapTokens: 100, attempt: 1, ...extra })

  await scenario('quiet-carrier-mid-send', async h => {
    h.workers({})
    await h.hold(true)
    await h.facts({ busy: false, runnerGeneration: 1 })
    let release: (reply: Reply | 'drop') => void = () => {}
    let sent: Promise<unknown> = Promise.resolve()
    await h.step('a send begins and the carrier goes quiet', [{ hold: r => (release = r) }], () => {
      sent = h.connector.sendWords('words into a quiet carrier').then((value: unknown) => h.event({ returned: 'sendWords', value }))
    })
    const first = sentId(h)
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.tail({ text: 'a reply begins', messageId: 'msg_q', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 14, lastEventAtMs: clock.now() })
    await h.call('interrupt', [], [applied()])
    let recalled: Promise<unknown> = Promise.resolve()
    await h.step('the pending send is recalled while the carrier is quiet', [], () => {
      recalled = h.connector.withdrawSend(first).then((value: unknown) => h.event({ returned: 'withdrawSend', value }))
    })
    await h.transcript('the runner took the words though the carrier never said so', [h.user('words into a quiet carrier', { uuid: first })])
    await h.step('the quiet carrier answers at last', [], async () => {
      release(dispatched)
      await sent
      await recalled
    })
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.step('another send begins and the carrier goes quiet', [{ hold: r => (release = r) }], () => {
      sent = h.connector.sendWords('second words').then((value: unknown) => h.event({ returned: 'sendWords', value }))
    })
    const second = sentId(h)
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1, queue: [{ uuid: second, value: 'second words', mode: 'prompt' }] })
    await h.advance(700)
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.step('the quiet carrier drops the line', [], async () => {
      release('drop')
      await sent
    })
    await h.call('sendWords', ['second words'], [dispatched])
    await h.facts({ busy: false, runnerGeneration: 1 })
  })

  await scenario('two-answers-to-one-ask', async h => {
    await h.hold(true)
    await h.transcript('a turn asks twice', [h.user('build it'), h.assistant('msg_two', [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'make' } }, { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'ls' } }])])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.asks([
      { requestId: 'ask-a', toolUseId: 'toolu_a', toolName: 'Bash', input: { command: 'make' }, description: 'run make', askedAt: clock.now() },
      { requestId: 'ask-b', toolUseId: 'toolu_b', toolName: 'Bash', input: { command: 'ls' }, description: 'list the folder', askedAt: clock.now() },
    ])
    const card = (id: string): { onAbort: () => void; onAllow: (...a: unknown[]) => Promise<void>; onReject: (...a: unknown[]) => Promise<void> } =>
      (h.connector.asks() as Array<{ id: string; confirm: never }>).find(a => a.id === id)!.confirm
    const cardA = card('ask-a')
    const byRequest = (req: Reply): Reply => (req.op === 'sessionDispatch' ? dispatched : req.allow === true ? applied() : outcome('refused', { detail: 'the ask was already answered' }))
    await h.step('the card of ask-a is allowed with words and rejected in the same tick', [{ apart: byRequest }, { apart: byRequest }, { apart: byRequest }], async () => {
      await Promise.all([cardA.onAllow({ command: 'make' }, [], 'go on', undefined), cardA.onReject('no', undefined)])
      for (let i = 0; i < 2000 && h.connector.queuedSendCount() !== 1; i++) await pause(1)
    })
    await h.step('ask-b is answered twice through the door in one tick', [applied()], async () => {
      const both = await Promise.all([h.connector.answerAsk('ask-b', { kind: 'deny', feedback: 'not now' }), h.connector.answerAsk('ask-b', { kind: 'allow' })])
      h.event({ returned: 'answerAsk twice', value: both })
    })
    await h.rereadAsks()
    const again = card('ask-a')
    await h.step('the card that came back is aborted and the daemon says it was answered', [outcome('refused', { detail: 'the ask was already answered' })], () => again.onAbort())
    await h.call('settleAsk', ['ask-b'])
    await h.call('answerAsk', ['ask-b', { kind: 'allow' }])
    await h.asks([])
    await h.facts({ busy: false })
  })

  await scenario('transcript-shrinks-mid-turn', async h => {
    const row = (n: number, content: string): Row => ({ type: 'system', subtype: 'seat_receipt', uuid: `00000000-0000-4000-8000-0000000000c${n}`, timestamp: new Date(clock.now()).toISOString(), content, level: 'info' })
    await h.hold(true)
    await h.transcript('two turns stand and a third begins', [h.user('one'), h.assistant('msg_1', [{ type: 'text', text: 'first' }]), h.user('two'), h.assistant('msg_2', [{ type: 'text', text: 'second' }]), h.user('three')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.call('addDisplayRow', [row(1, 'a line under the third ask')])
    await h.tail({ text: 'mid words', messageId: 'msg_3', phase: 'commentary', streamBlock: 'text', blockSinceMs: clock.now(), turnChars: 9, lastEventAtMs: clock.now() })
    await h.tail({ text: null, messageId: 'msg_3', streamBlock: 'tool_use', blockSinceMs: clock.now() })
    await h.call('sendWords', ['queued under the turn'], [dispatched])
    const queued = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: queued, value: 'queued under the turn', mode: 'prompt' }] })
    await h.tail({ text: 'more words', messageId: 'msg_4', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.cutTranscript('the transcript shrinks to the first turn while a tail is held', 2)
    await h.call('addDisplayRow', [row(2, 'a line after the shrink')])
    await h.cutTranscript('the transcript shrinks to one row', 1)
    await h.transcript('rows return', [h.user('again'), h.assistant('msg_4', [{ type: 'text', text: 'more words' }])])
    await h.tail({ text: null, messageId: 'msg_4' })
    await h.facts({ busy: false, runnerGeneration: 1 })
  })

  await scenario('daemon-dies-and-restarts', async h => {
    h.workers({})
    await h.hold(true)
    await h.transcript('a turn begins', [h.user('long work')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1, work: [crewRow('agent-a', 'running')], mission: [{ id: 'm1', title: 'the mission', status: 'running' }] })
    await h.call('sendWords', ['queued before the daemon died'], [dispatched])
    const before = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: before, value: 'queued before the daemon died', mode: 'prompt' }], work: [crewRow('agent-a', 'running')] })
    await h.tail({ text: 'words the old daemon carried', messageId: 'msg_old', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now(), turnChars: 28 })
    h.daemonRecord('alive')
    await h.beat()
    h.daemonRecord('gone')
    for (let i = 0; i < 4; i++) await h.beat()
    await h.rereadFacts('the facts the dead daemon left are read again')
    await h.facts({ busy: false, runnerGeneration: 2, queue: [] })
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 2 })
    h.daemonRecord('alive')
    await h.beat()
    await h.tail({ text: 'the new runner speaks', messageId: 'msg_new', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.transcript('the new words land', [h.assistant('msg_new', [{ type: 'text', text: 'the new runner speaks' }])])
    await h.tail({ text: null, messageId: 'msg_new' })
    h.daemonRecord('gone')
    await h.facts({ busy: false, runnerGeneration: 2 })
  })

  await scenario('listeners-that-call-back', async h => {
    const row = (n: number, content: string): Row => ({ type: 'system', subtype: 'seat_receipt', uuid: `00000000-0000-4000-8000-0000000000d${n}`, timestamp: new Date(clock.now()).toISOString(), content, level: 'info' })
    await h.hold(true)
    await h.transcript('a turn asks', [h.user('go'), h.assistant('msg_r', [{ type: 'tool_use', id: 'toolu_r', name: 'Bash', input: { command: 'ls' } }])])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.tail({ text: 'words held', messageId: 'msg_r2', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    let once: Record<string, boolean> = { asks: true }
    h.onWake = kind => {
      if (once[kind] !== true) return
      once[kind] = false
      if (kind === 'asks') h.event({ fromListener: 'interrupt', value: h.connector.interrupt() })
      if (kind === 'records') h.connector.addDisplayRow(row(1, 'a row a records listener added') as never)
      if (kind === 'live') h.event({ fromListener: 'settleAsk', value: h.connector.settleAsk('ask-r2') ?? null })
      if (kind === 'fold') h.event({ fromListener: 'status', value: h.connector.status() })
      if (kind === 'model') h.event({ fromListener: 'interrupt', value: h.connector.interrupt() })
    }
    await h.asks(
      [
        { requestId: 'ask-r', toolUseId: 'toolu_r', toolName: 'Bash', input: { command: 'ls' }, description: 'list the folder', askedAt: clock.now() },
        { requestId: 'ask-r2', toolUseId: 'toolu_r2', toolName: 'Bash', input: { command: 'pwd' }, description: 'print the folder', askedAt: clock.now() },
      ],
      [applied()],
    )
    await h.rereadAsks()
    once = { live: true }
    await h.tail({ text: 'more words', messageId: 'msg_r3', streamBlock: 'thinking', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    once = { records: true }
    await h.transcript('a row lands and its listener adds a row', [h.toolResult('toolu_r', 'listed')])
    once = { model: true }
    await h.facts({ busy: true, runnerGeneration: 1 }, [applied()])
    once = { fold: true }
    await h.tail({ stateWord: 'compacting', fold: foldRecord(), wait: { kind: 'first-byte', cold: true, promptTokens: 1200, model: 'claude-sonnet-5-5', budgetMs: 60000, sinceMs: clock.now(), attempt: 1, promise: true }, lastEventAtMs: clock.now(), streamBlock: 'text', blockSinceMs: clock.now() })
    once = {}
    h.onWake = null
    await h.facts({ busy: false, runnerGeneration: 1 })
  })

  await scenario('send-demoted-then-delivered', async h => {
    h.workers({})
    await h.hold(true)
    await h.facts({ busy: false, runnerGeneration: 1 })
    await h.call('sendWords', ['words the runner queues'], [dispatched])
    const id = sentId(h)
    await h.advance(50)
    await h.facts({ busy: false, runnerGeneration: 1, queue: [{ uuid: id, value: 'words the runner queues', mode: 'prompt' }] })
    await h.rereadFacts()
    await h.advance(50)
    h.workers({ lastDeliveryAt: clock.now() })
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.transcript('the words land as the user row', [h.user('words the runner queues', { uuid: id })])
    await h.tail({ text: 'an answer', messageId: 'msg_later', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.transcript('the answer lands', [h.assistant('msg_later', [{ type: 'text', text: 'an answer' }])])
    await h.tail({ text: null, messageId: 'msg_later' })
    await h.advance(50)
    h.workers({ lastTurnSettledAt: clock.now(), lastDeliveryAt: clock.now() - 60 })
    await h.facts({ busy: false, runnerGeneration: 1 })
  })

  await scenario('an-echo-retired', async h => {
    await h.hold(true)
    await h.transcript('a turn begins', [h.user('a long job')])
    await h.facts({ busy: true, turnStartedAt: clock.now(), runnerGeneration: 1 })
    await h.call('sendWords', ['words whose row never lands'], [dispatched])
    const taken = sentId(h)
    await h.call('sendWords', ['words the queue keeps'], [dispatched])
    const kept = sentId(h)
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: taken, value: 'words whose row never lands', mode: 'prompt' }, { uuid: kept, value: 'words the queue keeps', mode: 'prompt' }] })
    await h.facts({ busy: true, runnerGeneration: 1, queue: [{ uuid: kept, value: 'words the queue keeps', mode: 'prompt' }] })
    await h.facts({ busy: false, runnerGeneration: 1, queue: [{ uuid: kept, value: 'words the queue keeps', mode: 'prompt' }] })
    await h.advance(600_001)
    await h.transcript('a row lands ten minutes on', [h.assistant('msg_job', [{ type: 'text', text: 'done' }])])
    await h.rereadFacts('the same facts are read again after the old echo left')
  })

  await scenario('transcript-grows-while-it-is-read', async h => {
    await h.hold(true)
    await h.transcript('a turn begins', [h.user('count to three')])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.transcriptGrowsWhileRead('one row is being read when two more are written', [h.assistant('msg_one', [{ type: 'text', text: 'one' }])], [h.user('go on'), h.assistant('msg_two', [{ type: 'text', text: 'two' }])])
    await h.transcriptGrowsWhileRead('a tool call is being read when its result is written', [h.assistant('msg_three', [{ type: 'tool_use', id: 'toolu_three', name: 'Bash', input: { command: 'echo three' } }])], [h.toolResult('toolu_three', 'three')])
    await h.facts({ busy: false })
  })

  await scenario('watcher-fires-twice', async h => {
    await h.hold(true)
    await h.watcherFiresTwice('a turn begins and the watcher fires twice for it', [h.user('say it once')])
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.tail({ text: 'once', messageId: 'msg_once', streamBlock: 'text', blockSinceMs: clock.now(), lastEventAtMs: clock.now() })
    await h.watcherFiresTwice('the answer lands and the watcher fires twice for it', [h.assistant('msg_once', [{ type: 'text', text: 'once' }])])
    await h.watcherFiresTwice('the watcher fires twice with nothing new', [])
    await h.tail({ text: null, messageId: 'msg_once' })
    await h.facts({ busy: false })
  })

  await scenario('the-two-turn-starts-differ', async h => {
    await h.hold(true)
    await h.transcript('a turn begins', [h.user('a prompt whose row is stamped before the runner starts')])
    await h.advance(250)
    await h.facts({ busy: true, turnStartedAt: clock.now() })
    await h.rereadFacts('the same facts are read again while the two starts differ')
    await h.rereadFacts('the same facts are read a third time')
    await h.transcript('a row lands while the two starts differ', [h.assistant('msg_t', [{ type: 'text', text: 'an answer' }])])
    await h.facts({ busy: false })
  })

  server.close()
  rmSync(scratch, { recursive: true, force: true })
  return { scenarios, called: [...called].sort(), woken: [...woken].sort() }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--emit')
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1]!.split(',') : []
  const recording = await recordScenarios(only)
  const text = `${JSON.stringify(recording, null, 1)}\n`
  if (at >= 0) writeFileSync(process.argv[at + 1]!, text)
  else process.stdout.write(text)
  process.exit(0)
}
