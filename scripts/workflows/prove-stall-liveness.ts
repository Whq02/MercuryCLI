#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stall-liveness-home-'))
const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')

const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

type FakeArgs = {
  onQueryProgress?: (ev?: unknown) => void
  continuationMessages?: unknown[]
  toolUseContext?: { abortController?: AbortController }
  agentId?: string
  prompt?: string
}
type FakeSpec = {
  behaviors: Array<(args: FakeArgs) => AsyncGenerator<unknown, void>>
}

function makeRig(spec: FakeSpec): {
  hooks: { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>; getFailures: () => string[] }
  calls: Array<{ continuationMessages?: unknown[]; agentId?: string; prompt?: string }>
  frames: Array<Record<string, unknown>>
} {
  const calls: Array<{ continuationMessages?: unknown[]; agentId?: string; prompt?: string }> = []
  const frames: Array<Record<string, unknown>> = []
  const fakeSpawn = (args: FakeArgs): AsyncGenerator<unknown, void> => {
    const idx = Math.min(calls.length, spec.behaviors.length - 1)
    calls.push({ continuationMessages: args.continuationMessages, agentId: args.agentId, prompt: args.prompt })
    return spec.behaviors[idx]!(args)
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
        },
        mcp: { tools: [] },
      }),
      options: {
        agentDefinitions: { activeAgents: [] },
        mainLoopModel: 'claude-opus-5',
      },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: unknown) => {
      const data = (f as { data?: Record<string, unknown> }).data
      if (data) frames.push(data)
    },
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never) as {
    agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>
    getFailures: () => string[]
  }
  return { hooks, calls, frames }
}
const abortSignalOf = (args: FakeArgs): AbortSignal | undefined =>
  args.toolUseContext?.abortController?.signal
const hangUntilAbort = async (args: FakeArgs): Promise<never> => {
  await new Promise<void>(resolve => {
    const sig = abortSignalOf(args)
    if (sig?.aborted) return resolve()
    sig?.addEventListener('abort', () => resolve(), { once: true })
  })
  throw new Error('aborted by watchdog')
}

const apiError = (retryInMs: number, status?: number): unknown => ({
  type: 'system',
  subtype: 'api_error',
  ...(status !== undefined ? { errorDetail: { status } } : {}),
  retryInMs,
  retryAttempt: 1,
  maxRetries: 10,
})
const assistantText = (text: string): unknown => ({
  type: 'assistant',
  message: {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { output_tokens: 5 },
  },
})
const assistantToolUse = (id: string): unknown => ({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
    stop_reason: 'tool_use',
    usage: { output_tokens: 5 },
  },
})

console.log('============================================================')
console.log(' stall-liveness — declared recovery is progress, wedges still die')
console.log('============================================================')

section('(a) a declared backoff LONGER than stallMs does not kill the attempt')
{
  const { hooks, calls, frames } = makeRig({
    behaviors: [
      async function* (args) {
        args.onQueryProgress?.({ type: 'stream_event' })
        args.onQueryProgress?.(apiError(600))
        await sleep(600)
        const msg = assistantText('recovered fine')
        args.onQueryProgress?.(msg)
        yield msg
      },
    ],
  })
  const res = await hooks.agent('do the thing', { stallMs: 200 })
  check('agent resolved with the recovered text', String(res).includes('recovered fine'), String(res).slice(0, 80))
  check('exactly ONE spawn (no stall retry)', calls.length === 1, `${calls.length}`)
  check('no frame carries attempt 2', !frames.some(f => (f.attempt as number) > 1))
  check(
    'the recovery was surfaced (waiting: provider-backoff frame)',
    frames.some(f => f.waiting === 'provider-backoff' && f.retryInMs === 600),
  )
}

section('(b) a genuine wedge still dies at stallMs and exhausts the ladder')
{
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        await hangUntilAbort(args)
      },
    ],
  })
  let threw = ''
  try {
    await hooks.agent('wedge', { stallMs: 150 })
  } catch (e) {
    threw = String(e)
  }
  check('the ladder exhausted and threw the stall verdict', /stalled on all/.test(threw), threw.slice(0, 100))
  check('spawned 1 + MAX_STALL_RETRIES times', calls.length === 6, `${calls.length}`)
}

section('(c) deterministic-400 fails immediately — no retry, no recovery wait')
{
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        const msg = {
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            content: [{ type: 'text', text: 'prompt is too long: 214431 tokens > 204698 maximum' }],
            stop_reason: null,
            usage: { output_tokens: 0 },
          },
        }
        args.onQueryProgress?.(msg)
        yield msg
        await hangUntilAbort(args)
      },
    ],
  })
  const res = await hooks.agent('overflow', { stallMs: 200 })
  check('agent() resolved null (terminal apiError)', res === null, String(res).slice(0, 60))
  check('exactly ONE spawn (never retried)', calls.length === 1, `${calls.length}`)
  const fails = hooks.getFailures()
  check('failures[] carries the deterministic-400', fails.some(f => /prompt is too long/i.test(f)))
}

section('(e) refusals past the retry budget settle typed — no ladder, no 45s throttle rescue')
{
  const t0 = Date.now()
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        args.onQueryProgress?.(apiError(700_000, 529))
        args.onQueryProgress?.(apiError(700_000, 529))
        args.onQueryProgress?.(apiError(700_000, 529))
        await hangUntilAbort(args)
      },
    ],
  })
  const res = await hooks.agent('saturated', { stallMs: 200 })
  check('agent() resolved null (the typed settle)', res === null, String(res).slice(0, 60))
  check('exactly ONE spawn (the ladder never touched it)', calls.length === 1, `${calls.length}`)
  const fails = hooks.getFailures()
  check('failures[] carries the refusals and the spent budget', fails.some(f => /the provider refused \d+ times in a row \(HTTP 529, overloaded\) — the 20m retry budget is spent/.test(f)), fails.join(' | '))
  check('no 45s throttle-rescue sleep was bought', Date.now() - t0 < 30_000)
}

section('(e2) a fault past the budget is not a refusal: honoured whole, the budget untouched, the stall verdict still stands')
{
  const t0 = Date.now()
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        args.onQueryProgress?.(apiError(300, 503))
        args.onQueryProgress?.(apiError(300, 503))
        args.onQueryProgress?.(apiError(300, 503))
        await hangUntilAbort(args)
      },
    ],
  })
  let threw = ''
  try {
    await hooks.agent('faulting', { stallMs: 200 })
  } catch (e) {
    threw = String(e)
  }
  const fails = hooks.getFailures()
  check('the faults never spent the budget: no refusal verdict anywhere', !/retry budget is spent/.test(threw) && !fails.some(f => /retry budget is spent/.test(f)), `${threw.slice(0, 100)} | ${fails.join(' | ')}`)
  check('the silence after the faults is the stall verdict, and the ladder ran', /stalled on all/.test(threw) && calls.length === 6, `${threw.slice(0, 100)} calls=${calls.length}`)
  check('bounded: the leg ended well inside a minute', Date.now() - t0 < 60_000, String(Date.now() - t0))
}

section('(f) resume semantics: balanced prefix continues; unpaired tool_use restarts fresh')
{
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        const msg = assistantText('half the work is done')
        args.onQueryProgress?.(msg)
        yield msg
        await hangUntilAbort(args)
      },
      async function* (args) {
        const msg = assistantText('finished')
        args.onQueryProgress?.(msg)
        yield msg
      },
    ],
  })
  const res = await hooks.agent('resume me', { stallMs: 150 })
  check('retry succeeded with the finish', String(res).includes('finished'), String(res).slice(0, 60))
  check('two spawns (one stall, one resume)', calls.length === 2, `${calls.length}`)
  const cont = calls[1]?.continuationMessages
  check('the retry CONTINUED the conversation (non-empty continuation)', Array.isArray(cont) && cont.length >= 2)
  const lastMsg = Array.isArray(cont) ? (cont[cont.length - 1] as { message?: { content?: unknown } }) : undefined
  check(
    'the continuation ends with the resume prompt',
    JSON.stringify(lastMsg ?? {}).includes('cut off by a no-progress timeout'),
  )
  check(
    'the preserved work rides the continuation',
    JSON.stringify(cont ?? []).includes('half the work is done'),
  )
}
{
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        const msg = assistantToolUse('toolu_dangling')
        args.onQueryProgress?.(msg)
        yield msg
        await sleep(50)
        args.onQueryProgress?.({ type: 'stream_event' })
        await hangUntilAbort(args)
      },
      async function* (args) {
        const msg = assistantText('fresh run done')
        args.onQueryProgress?.(msg)
        yield msg
      },
    ],
  })
  const res = await hooks.agent('dangling', { stallMs: 150 })
  check('retry succeeded fresh', String(res).includes('fresh run done'), String(res).slice(0, 60))
  check('two spawns', calls.length === 2, `${calls.length}`)
  check(
    'an unpaired trailing tool_use resumes NOTHING (fresh restart)',
    calls[1]?.continuationMessages === undefined,
  )
}

section('source locks — the forward stays live and honest')
{
  const runAgentSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'runAgent.ts'), 'utf8')
  check('runAgent forwards the MESSAGE on onQueryProgress', /onQueryProgress\?\.\(message( as Message)?\)/.test(runAgentSrc))
  const streamSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'anthropic', 'streamCore.ts'), 'utf8')
  check(
    'both non-streaming fallback sites yield the recovery signal before blocking',
    (streamSrc.match(/yield createSystemAPIErrorMessage\(/g) ?? []).length >= 2,
  )
}

section("(g) a fast tool round then silence: the round's end un-parks the watchdog, throttle or not")
{
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        const call = assistantToolUse('toolu_fast')
        args.onQueryProgress?.(call)
        yield call
        await sleep(2)
        args.onQueryProgress?.({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fast', content: 'ok' }] } })
        await hangUntilAbort(args)
      },
    ],
  })
  const t0 = Date.now()
  let threw = ''
  try {
    await Promise.race([
      hooks.agent('fast round then silence', { stallMs: 200 }),
      sleep(8_000).then(() => {
        throw new Error('no cut within 8 s — the watchdog stayed parked past the fast round')
      }),
    ])
  } catch (e) {
    threw = String(e)
  }
  check("the silence after a fast round is cut by the stall budget — never left to the provider's guard", /stalled on all/.test(threw), threw.slice(0, 140))
  check('the ladder ran its attempts inside the bound (the watchdog armed on every round\'s end)', calls.length === 6 && Date.now() - t0 < 8_000, `${calls.length} attempts in ${Date.now() - t0} ms`)
}

section("(h) a tool round with progress ticks, then silence: a tool's own progress never un-parks the watchdog; the round's end does")
{
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        const call = assistantToolUse('toolu_ticking')
        args.onQueryProgress?.(call)
        yield call
        for (let i = 0; i < 4; i++) {
          await sleep(60)
          args.onQueryProgress?.({ type: 'progress', toolUseID: 'toolu_ticking', data: { type: 'bash_progress', output: `line ${i}` } })
        }
        args.onQueryProgress?.({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ticking', content: 'ok' }] } })
        await hangUntilAbort(args)
      },
    ],
  })
  const t0 = Date.now()
  let threw = ''
  try {
    await Promise.race([
      hooks.agent('ticking round then silence', { stallMs: 200 }),
      sleep(8_000).then(() => {
        throw new Error('no cut within 8 s')
      }),
    ])
  } catch (e) {
    threw = String(e)
  }
  check("the silence after a ticking round is cut by the stall budget (the ticks never armed it; the result row did)", /stalled on all/.test(threw), threw.slice(0, 140))
  check('the ladder ran its attempts inside the bound', calls.length === 6 && Date.now() - t0 < 8_000, `${calls.length} attempts in ${Date.now() - t0} ms`)
}

section('(i) a stream alive with activity relays alone (the provider pings, the model thinks with the display off) is never cut by the workflow clock')
{
  const { hooks, calls, frames } = makeRig({
    behaviors: [
      async function* (args) {
        args.onQueryProgress?.({ type: 'stream_request_start' })
        const until = Date.now() + 700
        while (Date.now() < until) {
          await sleep(60)
          args.onQueryProgress?.({ type: 'stream_activity', atMs: Date.now() })
        }
        const msg = assistantText('alive on pings alone')
        args.onQueryProgress?.(msg)
        yield msg
      },
    ],
  })
  const res = await hooks.agent('ping-fed', { stallMs: 200 })
  check('the agent resolved after 700 ms of relays past a 200 ms stall budget', String(res).includes('alive on pings alone'), String(res).slice(0, 80))
  check('exactly ONE spawn: no stall cut, no retry', calls.length === 1 && !frames.some(f => (f.attempt as number) > 1), `${calls.length}`)
}

section("(j) the real road: a pinging stream reaches the workflow clock and the runner's idle deadline as life through the transport relay")
{
  const PING_MS = 250
  const PING_FOR_MS = 5_000
  const STALL_MS = 2_000
  const IDLE_MINUTES = '0.04'
  const DONE = 'PING-PROBE-DONE'
  const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
  const finalTurn = (): string =>
    [
      sse('message_start', { type: 'message_start', message: { id: `msg_ping_${Date.now() % 1e6}`, type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: DONE } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
  const requests: Array<{ at: number; endedAt?: number; pings: number }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
        return
      }
      const hit = { at: Date.now(), pings: 0 } as { at: number; endedAt?: number; pings: number }
      requests.push(hit)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const answer = (): void => {
        hit.endedAt = Date.now()
        if (!res.destroyed) res.end(finalTurn())
      }
      if (requests.length > 1) {
        answer()
        return
      }
      const pinger = setInterval(() => {
        if (res.destroyed) {
          clearInterval(pinger)
          hit.endedAt = Date.now()
          return
        }
        if (Date.now() - hit.at >= PING_FOR_MS) {
          clearInterval(pinger)
          answer()
          return
        }
        hit.pings++
        res.write('event: ping\ndata: {"type":"ping"}\n\n')
      }, PING_MS)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const scratch = mkdtempSync(join(tmpdir(), 'stall-liveness-real-'))
  const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stall-liveness-child-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))
let state: any = getDefaultAppState()
const setAppState = (fn: any) => { state = typeof fn === 'function' ? fn(state) : fn }
const ctx: any = {
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  options: {
    mainLoopModel: 'claude-sonnet-5',
    mcpClients: [],
    mcpResources: {},
    tools: [],
    commands: [],
    debug: false,
    verbose: false,
    isNonInteractiveSession: false,
    agentDefinitions: { activeAgents: [], allAgents: [] },
  },
  abortController: new AbortController(),
  toolUseId: 'ping-probe-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}
const script = [
  "export const meta = { name: 'ping-probe', description: 'one agent on a pinging stream', phases: [{ title: 'Probe' }] }",
  "phase('Probe')",
  "const report = await agent('ping probe: reply with one line', { stallMs: ${STALL_MS} })",
  "return { report }",
].join('\n')
try {
  const startedAt = Date.now()
  const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
  const d: any = (res as any).data
  emit({ ev: 'launched', runId: d.runId, error: d.error })
  const deadline = Date.now() + 60_000
  let task: any
  for (;;) {
    task = Object.values(state.tasks ?? {}).find((t: any) => t.type === 'local_workflow')
    if (task && task.status !== 'running') break
    if (Date.now() > deadline) { emit({ ev: 'timeout', status: task?.status, progress: task?.workflowProgress?.slice(-6) }); process.exit(1) }
    await new Promise(r => setTimeout(r, 100))
  }
  const agents = (task.workflowProgress ?? []).filter((e: any) => e.type === 'workflow_agent')
  emit({
    ev: 'settled',
    status: task.status,
    error: task.error,
    elapsedMs: Date.now() - startedAt,
    result: JSON.stringify(task.result ?? null).slice(0, 300),
    legs: agents.map((a: any) => ({ index: a.index, state: a.state, attempt: a.attempt, lastAttemptReason: a.lastAttemptReason, error: a.error, resultPreview: a.resultPreview })),
    logs: (task.logs ?? []).slice(-8),
  })
  process.exit(0)
} catch (e) {
  emit({ ev: 'threw', message: (e as Error).message, stack: String((e as Error).stack).slice(0, 600) })
  process.exit(1)
}
`
  writeFileSync(join(scratch, 'child.ts'), CHILD)
  const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
    cwd: scratch,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_AGENT_IDLE_MINUTES: IDLE_MINUTES,
      MERCURY_DYNAMIC_WORKFLOWS: '1',
    },
  })
  let out = ''
  let errTail = ''
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  child.stderr.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000)
  })
  const status: number | null = await new Promise(resolve => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', s => {
      clearTimeout(killer)
      resolve(s)
    })
  })
  const lines: Array<Record<string, unknown>> = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('@@')) continue
    try {
      lines.push(JSON.parse(line.slice(2)))
    } catch {
      void 0
    }
  }
  const settled = lines.find(l => l.ev === 'settled') as { status?: string; legs?: Array<Record<string, unknown>>; logs?: string[]; result?: string } | undefined
  const legs = settled?.legs ?? []
  const first = requests[0]
  console.log(`  record · requests on the wire: ${requests.length} · first request held ${first?.endedAt !== undefined ? first.endedAt - first.at : '?'} ms with ${first?.pings ?? 0} pings · legs ${JSON.stringify(legs).slice(0, 300)} · logs ${JSON.stringify(settled?.logs ?? []).slice(0, 300)}`)
  check('the child ran the workflow to completion', status === 0 && settled?.status === 'completed', `status ${status} · ${JSON.stringify(settled).slice(0, 400)} · stderr ${errTail.slice(-400)}`)
  check(`the pinging request was never cut: ONE request on the wire, held past the ${STALL_MS} ms stall budget and the ${IDLE_MINUTES}-minute idle deadline`, requests.length === 1 && first !== undefined && first.endedAt !== undefined && first.endedAt - first.at >= PING_FOR_MS - PING_MS, `requests=${requests.length} held=${first ? String((first.endedAt ?? 0) - first.at) : '?'}ms`)
  check('the agent settled done on its first attempt with the fixture\'s reply', legs.length === 1 && legs[0]!.state === 'done' && (legs[0]!.attempt === undefined || legs[0]!.attempt === 1) && (String(settled?.result ?? '').includes(DONE) || String(legs[0]!.resultPreview ?? '').includes(DONE)), JSON.stringify(legs).slice(0, 300))
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} STALL-LIVENESS PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL STALL-LIVENESS PROOFS PASS')
