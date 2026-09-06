#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stall-liveness-home-'))

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
}
type FakeSpec = {
  behaviors: Array<(args: FakeArgs) => AsyncGenerator<unknown, void>>
}

function makeRig(spec: FakeSpec): {
  hooks: { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>; getFailures: () => string[] }
  calls: Array<{ continuationMessages?: unknown[] }>
  frames: Array<Record<string, unknown>>
} {
  const calls: Array<{ continuationMessages?: unknown[] }> = []
  const frames: Array<Record<string, unknown>> = []
  const fakeSpawn = (args: FakeArgs): AsyncGenerator<unknown, void> => {
    const idx = Math.min(calls.length, spec.behaviors.length - 1)
    calls.push({ continuationMessages: args.continuationMessages })
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
  check('failures[] carries the refusals and the spent budget', fails.some(f => /the provider refused \d+ times in a row \(HTTP 529, overloaded\) — the 5m retry budget is spent/.test(f)), fails.join(' | '))
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

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} STALL-LIVENESS PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL STALL-LIVENESS PROOFS PASS')
