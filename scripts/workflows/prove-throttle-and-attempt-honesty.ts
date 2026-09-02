#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-throttle-and-attempt-honesty.ts
//  PROOF (workflow-hardening riders): the /workflows card is HONEST about
//  provider throttling and about attempts.
//
//  §A A RATE-LIMITED AGENT SAYS SO: the anthropic lane answers two real
//     HTTP 429s (retry-after set) before serving; the client's declared
//     recovery must surface on the agent's frames as
//     waiting:'provider-backoff' with a visible schedule (retryInMs or the
//     blocking-recovery ceiling), the shared livePulse projector must
//     render it as a backoff word — never "thinking" — and the agent still
//     completes. The throttle is RECOVERY, not the stall ladder: attempt
//     stays 1.
//
//  §B "attempt N" MEANS REAL ATTEMPTS: the operator's retry surface
//     (the per-agent controller's 'user-retry' abort) cuts attempt 1; the
//     ladder re-runs; the frames show attempt 2 and the agent completes.
//
//  Run: ~/.bun/bin/bun run scripts/workflows/prove-throttle-and-attempt-honesty.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkflowAgentFixture } from '../lib/workflowAgentFixture.ts'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — throttle/attempt prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'wf-throttle-'))

console.log('============================================================')
console.log(' Workflow honesty riders — 429 backoff visible · real attempts')
console.log('============================================================')

const fixture = await startWorkflowAgentFixture({
  port: 34907,
  throttle: { lane: 'anthropic', times: 2, retryAfterSec: 2 },
  // Held responses give §B's mid-flight retry cut a real window to land in
  // (an instant seat settled before the operator's signal could arrive).
  latencyMs: { anthropic: 700 },
})

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-throttle-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { makeWorkflowHooks } = await import('${REPO}/src/tools/WorkflowTool/agentHooks.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { agentPulse, agentPulseWord } = await import('${REPO}/src/tools/WorkflowTool/livePulse.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))

let state: any = getDefaultAppState()
const setAppState = (fn: any) => { state = typeof fn === 'function' ? fn(state) : fn }
const ctx: any = {
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  options: {
    mainLoopModel: 'claude-opus-4-8',
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
  toolUseId: 'throttle-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

// ── §A the throttled agent ──────────────────────────────────────────────────
{
  const frames: any[] = []
  const hooks: any = makeWorkflowHooks({
    toolUseContext: ctx,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: any) => frames.push(JSON.parse(JSON.stringify(f?.data ?? null))),
    workflowRunId: 'throttle-run',
  } as any)
  const result = await hooks.agent('throttled agent: run the echo you are told, then reply done', {})
  const agentFrames = frames.filter((f: any) => f?.type === 'workflow_agent')
  const backoffFrames = agentFrames.filter((f: any) => f.waiting === 'provider-backoff')
  const scheduleVisible = backoffFrames.filter(
    (f: any) =>
      (typeof f.retryInMs === 'number' && f.retryInMs > 0) ||
      (typeof f.recoveryTimeoutMs === 'number' && f.recoveryTimeoutMs > 0),
  )
  const pulseWords = backoffFrames.map((f: any) =>
    agentPulseWord(
      agentPulse(
        {
          state: 'progress',
          waiting: f.waiting,
          retryInMs: f.retryInMs,
          recoveryTimeoutMs: f.recoveryTimeoutMs,
          retryAttempt: f.retryAttempt,
          lastProgressAt: Date.now(),
        },
        Date.now(),
      ),
    ),
  )
  emit({
    ev: 'throttle',
    result,
    backoffFrameCount: backoffFrames.length,
    scheduleVisibleCount: scheduleVisible.length,
    sampleFrame: backoffFrames[0] ?? null,
    pulseWords: [...new Set(pulseWords)],
    finalState: agentFrames.at(-1)?.state,
    maxAttempt: Math.max(...agentFrames.map((f: any) => f?.attempt ?? 1)),
  })
}

// ── §B the operator retry: attempt 2 is a REAL attempt ──────────────────────
{
  const frames: any[] = []
  const controllers = new Map<string, AbortController>()
  const hooks: any = makeWorkflowHooks({
    toolUseContext: ctx,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: any) => frames.push(JSON.parse(JSON.stringify(f?.data ?? null))),
    workflowRunId: 'retry-run',
    onAgentController: (id: string, c: AbortController | null) => {
      if (c) controllers.set(id, c)
      else controllers.delete(id)
    },
  } as any)
  // Cut attempt 1 with the operator's retry signal shortly after launch.
  const cutTimer = setInterval(() => {
    const [first] = controllers.values()
    if (first && !first.signal.aborted) {
      first.abort('user-retry')
      clearInterval(cutTimer)
    }
  }, 300)
  const result = await hooks.agent('retry agent: run the echo you are told, then reply done', {})
  clearInterval(cutTimer)
  const agentFrames = frames.filter((f: any) => f?.type === 'workflow_agent')
  emit({
    ev: 'retry',
    result,
    maxAttempt: Math.max(...agentFrames.map((f: any) => f?.attempt ?? 1)),
    attempt2Reason: agentFrames.find((f: any) => f?.attempt === 2)?.lastAttemptReason ?? null,
    finalState: agentFrames.at(-1)?.state,
  })
}
process.exit(0)
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: { ...process.env, ...fixture.env },
})
let out = ''
let errTail = ''
child.stdout.on('data', (d: Buffer) => (out += d.toString()))
child.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-1500)))
const status: number | null = await new Promise(resolve => {
  const killer = setTimeout(() => child.kill('SIGKILL'), 150_000)
  child.on('close', s => {
    clearTimeout(killer)
    resolve(s)
  })
})
const lines = out
  .split('\n')
  .filter(l => l.startsWith('@@'))
  .map(l => {
    try {
      return JSON.parse(l.slice(2)) as Record<string, unknown>
    } catch {
      return {}
    }
  })
const throttleLeg = lines.find(l => l.ev === 'throttle') as
  | { result?: unknown; backoffFrameCount?: number; scheduleVisibleCount?: number; sampleFrame?: unknown; pulseWords?: string[]; finalState?: string; maxAttempt?: number }
  | undefined
const retryLeg = lines.find(l => l.ev === 'retry') as
  | { result?: unknown; maxAttempt?: number; attempt2Reason?: string | null; finalState?: string }
  | undefined

section('§A the 429 is visible: backoff frames with a schedule, honest word')
check('child exited 0', status === 0, `status ${status}; stderr: ${errTail.slice(-400)}`)
check('the fixture really threw two 429s', (fixture.throttled['anthropic'] ?? 0) === 2, JSON.stringify(fixture.throttled))
check('backoff frames were emitted', (throttleLeg?.backoffFrameCount ?? 0) >= 1, JSON.stringify(throttleLeg).slice(0, 400))
check(
  'the retry schedule is VISIBLE on the frame (retryInMs or the recovery ceiling)',
  (throttleLeg?.scheduleVisibleCount ?? 0) >= 1,
  JSON.stringify(throttleLeg?.sampleFrame),
)
check(
  'the shared pulse word says backoff/retrying — never thinking',
  (throttleLeg?.pulseWords ?? []).length > 0 &&
    (throttleLeg?.pulseWords ?? []).every(w => /backoff|retrying/.test(w) && !/thinking/.test(w)),
  JSON.stringify(throttleLeg?.pulseWords),
)
check('the throttled agent still completes', throttleLeg?.finalState === 'done' && throttleLeg?.result === 'wf-anthropic-done.', JSON.stringify({ state: throttleLeg?.finalState, result: throttleLeg?.result }))
check('throttle recovery is NOT an attempt (attempt stays 1)', throttleLeg?.maxAttempt === 1, `maxAttempt=${throttleLeg?.maxAttempt}`)

section('§B attempt chips mean real attempts')
check('the operator retry produced attempt 2', retryLeg?.maxAttempt === 2, JSON.stringify(retryLeg))
check(
  "attempt 2 carries the honest reason ('retry requested by user')",
  /retry requested by user/.test(String(retryLeg?.attempt2Reason ?? '')),
  String(retryLeg?.attempt2Reason),
)
check('the retried agent completes', retryLeg?.finalState === 'done' && retryLeg?.result === 'wf-anthropic-done.', JSON.stringify({ state: retryLeg?.finalState, result: retryLeg?.result }))

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n❌ THROTTLE/ATTEMPT HONESTY RED (${failures} failing)` : '\n✅ THROTTLE/ATTEMPT HONESTY GREEN')
process.exit(failures ? 1 : 0)
