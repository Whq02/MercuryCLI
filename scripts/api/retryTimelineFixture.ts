import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

type Reply = { label: string; status: number; headers: Record<string, string>; body: string; drop?: true }
type Scripted = Reply | ((request: Record<string, unknown>) => Reply)

export const frames = (rows: unknown[], done = false): string => rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
export const streamed = (label: string, body: string): Reply => ({ label, status: 200, headers: { 'content-type': 'text/event-stream' }, body })
export const collected = (label: string, body: unknown): Reply => ({ label, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
export const refused = (label: string, status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ label, status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
export const dropped = (label: string, body: string): Reply => ({ label, status: 200, headers: { 'content-type': 'text/event-stream' }, body, drop: true })

type CallArgs = { signal: AbortSignal; onWait: (wait: unknown) => void; agentId?: string }
type Call = (args: CallArgs) => AsyncGenerator<unknown>
type Wait = { kind?: string; attempt?: number; of?: number; delayMs?: number; held?: unknown } | null
type Item = { type?: string; subtype?: string; retryInMs?: number; retryAttempt?: number; maxRetries?: number; isApiErrorMessage?: boolean; error?: unknown; message?: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } }

const SILENT_WAIT_FLOOR_MS = 40
const CANCEL_AFTER_ROW_MS = 50
const CANCEL_AFTER_REFUSAL_MS = 600
const CANCEL_PROMPT_MS = 2000

type Stage = { script: Scripted[]; served: number; lastAtMs: number; announcedMs: number | undefined; namedSeconds: number | undefined; rows: string[]; refusalSent?: () => void }
let stage: Stage | null = null
let waitLine: (wait: never) => string = () => ''
const outside: string[] = []

export async function openStandIn(args: {
  provider: string
  isModelCall: (method: string, path: string) => boolean
  side?: (method: string, path: string) => unknown
  env: (base: string) => Record<string, string>
}): Promise<{ base: string; close: () => Promise<void> }> {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const home = mkdtempSync(join(tmpdir(), `retry-timeline-${args.provider}-`))
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const method = (req.method ?? 'GET').toUpperCase()
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (stage === null || !args.isModelCall(method, path)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(args.side?.(method, path) ?? {}))
        return
      }
      let request: Record<string, unknown> = {}
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        request = {}
      }
      const now = Date.now()
      const n = ++stage.served
      const gapMs = now - stage.lastAtMs
      const scripted = stage.script[Math.min(n, stage.script.length) - 1]!
      const reply = typeof scripted === 'function' ? scripted(request) : scripted
      const when =
        n === 1
          ? 'request 1'
          : stage.announcedMs !== undefined
            ? gapMs >= stage.announcedMs * 0.9
              ? `request ${n} after the ${stage.announcedMs} ms it announced`
              : `request ${n} EARLY, ${gapMs} ms after the last with ${stage.announcedMs} ms announced`
            : gapMs >= SILENT_WAIT_FLOOR_MS
              ? `request ${n} after a wait nothing announced`
              : `request ${n} at once`
      const named = stage.namedSeconds === undefined ? '' : gapMs >= stage.namedSeconds * 900 ? `, not shorter than the ${stage.namedSeconds} s the 429 named` : `, SHORTER (${gapMs} ms) than the ${stage.namedSeconds} s the 429 named`
      stage.rows.push(`wire   ${when}${named} → ${reply.label}`)
      stage.lastAtMs = now
      stage.announcedMs = undefined
      stage.namedSeconds = reply.headers['retry-after'] === undefined ? undefined : Number(reply.headers['retry-after'])
      res.writeHead(reply.status, reply.headers)
      if (reply.status !== 200) stage.refusalSent?.()
      if (reply.drop !== true) {
        res.end(reply.body)
        return
      }
      const cut = (): void => void setTimeout(() => res.socket?.destroy(), 25)
      if (reply.body === '') {
        res.flushHeaders()
        cut()
      } else res.write(reply.body, cut)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_DISABLE_NONSTREAMING_FALLBACK', 'MERCURY_STREAM_IDLE_TIMEOUT_MS', 'NODE_ENV']) delete process.env[name]
  Object.assign(process.env, {
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_RECOVERY_BUDGET_MINUTES: '1',
    MERCURY_BUSY_RETRY_SCALE: '0.05',
    MERCURY_RECONNECT_SCALE: '0.01',
    MERCURY_RECONNECT_BUDGET_MINUTES: '0',
    MERCURY_MAX_RETRIES: '2',
    ...args.env(base),
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
    if (url.startsWith(base)) return realFetch(input as never, init)
    outside.push(url)
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('the stand-in refuses every address but its own'), { code: 'ECONNREFUSED' }) }))
  }) as typeof fetch
  Math.random = () => 0.5
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const bootstrap = await import('../../src/boot/process-state/processState.ts')
  bootstrap.setIsInteractive(false)
  const idle = await import('../../src/models/roads/streamIdleBudget.ts')
  waitLine = idle.requestWaitLine as (wait: never) => string
  return {
    base,
    close: async () => {
      globalThis.fetch = realFetch
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export async function callParams(model: string, args: CallArgs, extra: Record<string, unknown> = {}): Promise<never> {
  const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  return {
    messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'Say hello.' } }],
    systemPrompt: asSystemPrompt(['Only answer the request.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: args.signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, onWait: args.onWait, ...(args.agentId !== undefined ? { agentId: args.agentId } : {}), ...extra },
  } as never
}

const steady = (text: string): string => text.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT').replace(/over \d+ s\b/g, 'over N s').replace(/\s+/g, ' ')

function said(item: Item): string {
  if (item.type === 'system' && item.subtype === 'api_error') {
    return `said   notice · attempt ${item.retryAttempt} of ${item.maxRetries} · in ${item.retryInMs} ms · ${steady(String((item.error as { message?: unknown } | undefined)?.message ?? ''))}`
  }
  if (item.type === 'assistant') {
    const text = steady((item.message?.content ?? []).map(block => block.text ?? `[${block.type}]`).join(''))
    const usage = item.message?.usage
    const counted = `usage in ${usage?.input_tokens ?? '-'} out ${usage?.output_tokens ?? '-'}`
    return item.isApiErrorMessage === true ? `said   red · ${String(item.error ?? 'untyped')} · ${text} · ${counted}` : `said   answer · ${text} · ${counted}`
  }
  return `said   ${item.type ?? 'item'}${item.subtype !== undefined ? `/${item.subtype}` : ''}`
}

async function play(title: string, script: Scripted[], call: Call, opts: { agent?: true; cancel?: true; env?: Record<string, string> } = {}): Promise<string[]> {
  const rows: string[] = []
  const kept = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    kept.set(name, process.env[name])
    process.env[name] = value
  }
  const controller = new AbortController()
  let cancelledAtMs: number | undefined
  const cancel = (): void => {
    if (cancelledAtMs !== undefined) return
    cancelledAtMs = Date.now()
    rows.push('cancel the user cancels')
    controller.abort()
  }
  let armed = opts.cancel === true
  const arm = (afterMs: number): void => {
    if (!armed) return
    armed = false
    setTimeout(cancel, afterMs)
  }
  const current: Stage = { script, served: 0, lastAtMs: Date.now(), announcedMs: undefined, namedSeconds: undefined, rows, refusalSent: () => void setTimeout(() => arm(0), CANCEL_AFTER_REFUSAL_MS) }
  stage = current
  let streamEvents = 0
  const flushEvents = (): void => {
    if (streamEvents > 0) rows.push(`said   ${streamEvents} stream ${streamEvents === 1 ? 'event' : 'events'}`)
    streamEvents = 0
  }
  const onWait = (raw: unknown): void => {
    const wait = raw as Wait
    flushEvents()
    if (wait === null) {
      rows.push('row    cleared')
      return
    }
    if (wait.kind !== 'retry') {
      rows.push(`row    ${wait.kind}${(wait.attempt ?? 1) > 1 ? ` (attempt ${wait.attempt})` : ''}`)
      return
    }
    const held = wait.held !== undefined && wait.held !== null
    if (held) current.announcedMs = wait.delayMs
    rows.push(`row    ${held ? `held for ${wait.delayMs} ms · ` : ''}${steady(waitLine(wait as never))}`)
    arm(CANCEL_AFTER_ROW_MS)
  }
  let end = 'end    returned'
  try {
    for await (const raw of call({ signal: controller.signal, onWait, ...(opts.agent === true ? { agentId: 'agent-fixture' } : {}) })) {
      const item = raw as Item
      if (item.type === 'stream_event') {
        streamEvents++
        continue
      }
      flushEvents()
      if (item.type === 'system' && item.subtype === 'api_error') {
        current.announcedMs = item.retryInMs
        arm(CANCEL_AFTER_ROW_MS)
      }
      rows.push(said(item))
    }
  } catch (error) {
    end = `end    threw ${(error as { name?: string } | null)?.name ?? 'value'}: ${steady(String((error as { message?: unknown } | null)?.message ?? error))}`
  }
  flushEvents()
  const endedAtMs = Date.now()
  if (opts.cancel === true) {
    const prompt = cancelledAtMs !== undefined && endedAtMs - cancelledAtMs < CANCEL_PROMPT_MS
    rows.push(cancelledAtMs === undefined ? `${end} before any cancel` : prompt ? `${end} at once` : `${end} LATE, ${endedAtMs - cancelledAtMs} ms after the cancel`)
    const servedAtEnd = current.served
    await new Promise(resolve => setTimeout(resolve, 250))
    rows.push(current.served === servedAtEnd ? 'wire   no request after the cancel' : `wire   ${current.served - servedAtEnd} REQUEST(S) AFTER THE CANCEL`)
  } else rows.push(end)
  stage = null
  for (const [name, value] of kept) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return [`── ${title}`, ...rows.map(row => `  ${row}`)]
}

export type Wire = { answer: Scripted; tooMany: (retryAfterSeconds?: number) => Reply; overloaded: Reply; partial: Reply; nothing: Reply }

export async function playAll(call: Call, wire: Wire): Promise<string[]> {
  const lines: string[] = []
  const run = async (title: string, script: Scripted[], opts: Parameters<typeof play>[3] = {}): Promise<void> => void lines.push(...(await play(title, script, call, opts)))
  await run('a 429 with Retry-After: 1, then an answer', [wire.tooMany(1), wire.answer])
  await run('a 429 with Retry-After: 1, every time', [wire.tooMany(1)])
  await run('a 429 with Retry-After: 3600, longer than the recovery budget of one minute', [wire.tooMany(3600), wire.answer])
  await run('a 429 without Retry-After, then an answer', [wire.tooMany(), wire.answer])
  await run('a 429 without Retry-After, every time', [wire.tooMany()])
  await run('an overload, then an answer', [wire.overloaded, wire.answer])
  await run("an overload, then an answer, on an agent's call", [wire.overloaded, wire.answer], { agent: true })
  await run('an overload, every time', [wire.overloaded])
  await run('a stream dropped after its first words, then an answer', [wire.partial, wire.answer])
  await run('a stream dropped before its first event, then an answer', [wire.nothing, wire.answer])
  await run('a stream dropped before its first event, every time, with the reconnect budget at 51 ms', [wire.nothing], { env: { MERCURY_RECONNECT_BUDGET_MINUTES: '0.00085' } })
  await run('a cancel during the wait a 429 with Retry-After: 30 asks for', [wire.tooMany(30), wire.answer], { cancel: true })
  await run("a cancel during the wait a 429 with Retry-After: 30 asks for, on an agent's call", [wire.tooMany(30), wire.answer], { agent: true, cancel: true })
  if (outside.length > 0) lines.push(`── ${outside.length} request(s) tried to leave for another address: ${[...new Set(outside)].join(', ')}`)
  return lines
}

export function settle(name: string, lines: string[], want: readonly string[]): never {
  console.log(lines.join('\n'))
  let failures = 0
  for (let i = 0; i < Math.max(want.length, lines.length); i++) {
    if (want[i] === lines[i]) continue
    failures++
    if (failures <= 12) console.log(`[FAIL] line ${i + 1}\n  recorded on the base: ${want[i] ?? '(nothing)'}\n  this tree:            ${lines[i] ?? '(nothing)'}`)
  }
  console.log(failures === 0 ? `\n${name}: the timeline is the one recorded on the base (${lines.length} lines)` : `\n${name}: ${failures} line(s) differ from the timeline recorded on the base — a retry wait, counter or sentence moved; the door is src/engine/requests/withRetry.ts`)
  process.exit(failures === 0 ? 0 : 1)
}
