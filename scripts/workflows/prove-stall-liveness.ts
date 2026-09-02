#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-stall-liveness.ts — the stall watchdog reads
//  PROVIDER RECOVERY as liveness, not as a wedge.
//
//  The live incident: the API client's
//  stream-idle fallback (90s idle → a BLOCKING non-streaming call of up to
//  300s) and its inner 429/5xx backoff emitted nothing the workflow stall
//  watchdog could see, so every silent window >180s killed a legitimate
//  recovery ("stalled (no progress)"), restarted the agent from scratch, and
//  re-billed the full context — the biggest agents died hardest. The fix:
//  withRetry/streamCore yield an api_error system message carrying retryInMs
//  BEFORE blocking; runAgent forwards the MESSAGE on onQueryProgress; the
//  workflow watchdog extends across declared recoveries (capped), settles
//  THROTTLED past the total cap (an apiError — never the stall ladder), and a
//  stall-killed attempt with completed work RESUMES from its balanced prefix.
//
//  Hermetic: fake spawnSubagentStream via the makeWorkflowHooks deps seam
//  (the prove-structured-output-nudge precedent); stallMs compressed via
//  agent opts; scratch outside the repo; env pinned per invocation.
// ============================================================================
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
  /** scripted behavior per spawn call (index = attempt-1, last repeats) */
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
/** The REAL runAgent path THROWS when its query aborts — the fake must too,
 *  or the attempt settles down the clean path and the watchdog verdict is
 *  never read. */
const hangUntilAbort = async (args: FakeArgs): Promise<never> => {
  await new Promise<void>(resolve => {
    const sig = abortSignalOf(args)
    if (sig?.aborted) return resolve()
    sig?.addEventListener('abort', () => resolve(), { once: true })
  })
  throw new Error('aborted by watchdog')
}

const apiError = (retryInMs: number): unknown => ({
  type: 'system',
  subtype: 'api_error',
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
        // a tick lands <1s before the api_error: pins the throttle-bypass
        // ordering (the recovery branch must run BEFORE the 1s throttle)
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
        // no events, no progress — hang until the watchdog aborts
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
        // the real query THROWS when the terminal-400 latch aborts the child
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

section('(e) recoveries past the TOTAL cap settle THROTTLED — no ladder, no 45s throttle rescue')
{
  const t0 = Date.now()
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        // each declared wait is honored at RECOVERY_WAIT_CAP (600s) — three
        // pushes cross the 1200s total cap, aborting 'throttled'
        args.onQueryProgress?.(apiError(700_000))
        args.onQueryProgress?.(apiError(700_000))
        args.onQueryProgress?.(apiError(700_000))
        await hangUntilAbort(args)
      },
    ],
  })
  const res = await hooks.agent('saturated', { stallMs: 200 })
  check('agent() resolved null (throttled settle)', res === null, String(res).slice(0, 60))
  check('exactly ONE spawn (the ladder never touched it)', calls.length === 1, `${calls.length}`)
  const fails = hooks.getFailures()
  check('failures[] carries the provider-throttled verdict', fails.some(f => /provider throttled/.test(f)))
  check('no 45s throttle-rescue sleep was bought', Date.now() - t0 < 30_000)
}

section('(f) resume semantics: balanced prefix continues; unpaired tool_use restarts fresh')
{
  // f1: kill after a COMPLETE assistant text — retry must carry a continuation
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
  // f2: kill with an UNPAIRED trailing tool_use — retry must restart fresh
  const { hooks, calls } = makeRig({
    behaviors: [
      async function* (args) {
        const msg = assistantToolUse('toolu_dangling')
        args.onQueryProgress?.(msg)
        yield msg
        // a tool_use DISARMS the watchdog (long tools are legitimate); model
        // the re-arm tick the real runtime delivers around tool execution,
        // WITHOUT a pairing tool_result user message — the conversation keeps
        // the unpaired trailing tool_use while the stall can still fire.
        // (The no-tick wedge-after-tool_use case is a recorded latent gap —
        // the deliberate disarm contract, see the ledger.)
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

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} STALL-LIVENESS PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL STALL-LIVENESS PROOFS PASS')
