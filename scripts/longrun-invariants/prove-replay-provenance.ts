#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-replay-provenance.ts — replay provenance.
//
//  What the code did vs the invariant it missed: a cached workflow result
//  was re-presented with provenance rebuilt from CURRENT settings — the
//  cache key hashes only the named opts, so a run that never named a model
//  still hits after the session default changes, and the replayed row then
//  displayed the NEW model beside freshly executed work (the `cached` badge
//  labels the mixing; the model/effort claim was unlabeled). Journal append
//  failures were swallowed while the tool's own contract promises complete
//  replay, and no degraded state existed anywhere.
//
//  The invariant: a replayed row shows what RAN — joined at HIT time from
//  the per-agent launch-parity metadata via the journal row's agentId, or
//  says 'provenance unknown' (never a fresh default); the cache key inputs
//  are UNCHANGED (older journals stay valid); appends are serialized; the
//  first failed append or skipped line marks the journal degraded and fires
//  the surface callback once.
//
//  Seams: real makeWorkflowHooks with a real LocalFileJournal on disk and
//  the real writeAgentMetadata record (§A), the journal class itself (§B),
//  wiring pins (§C).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'replay-prov-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { makeWorkflowHooks, LocalFileJournal, agentCacheKey } = await import(
  '../../src/tools/WorkflowTool/agentHooks.js'
)
const { writeAgentMetadata } = await import('../../src/utils/sessionStorage.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Frames = Array<Record<string, unknown>>
function makeRig(opts: {
  runDir: string
  mainLoopModel: string
  snapshot?: unknown
  journal?: InstanceType<typeof LocalFileJournal>
  spawnText?: string
}): { hooks: { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }; frames: Frames } {
  const frames: Frames = []
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
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: opts.mainLoopModel },
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
    journal: opts.journal,
    journalSnapshot: opts.snapshot,
    spawnSubagentStream: (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: opts.spawnText ?? 'live-answer' }],
          stop_reason: 'end_turn',
          usage: { output_tokens: 3 },
        },
      }
    }) as never,
  } as never) as { hooks: never } & { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }
  return { hooks: hooks as never, frames }
}

section('§A a replayed row shows what RAN, never the current default')
const runDir = mkdtempSync(join(tmpdir(), 'replay-prov-run-'))
{
  // Run 1 under default 'claude-model-one': two agents, no model named.
  const journal1 = new LocalFileJournal(runDir)
  const rig1 = makeRig({ runDir, mainLoopModel: 'claude-model-one', journal: journal1, snapshot: await journal1.load() })
  const r1 = await rig1.hooks.agent('first job')
  const r2 = await rig1.hooks.agent('second job')
  check('run 1 executed live', String(r1).includes('live-answer') && String(r2).includes('live-answer'))
  // journal now holds started+result rows; give agent ONE a launch-parity
  // metadata record (the real runAgent writes this; the rig bypasses it).
  const rows = readFileSync(join(runDir, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as { type: string; agentId?: string; key?: string })
  const firstResult = rows.find(r => r.type === 'result')
  check('journal rows carry agentId (the join key)', typeof firstResult?.agentId === 'string' && firstResult.agentId.length > 0)
  await writeAgentMetadata(firstResult!.agentId as never, {
    agentType: 'general-purpose',
    model: 'claude-model-that-ran',
    effortOverride: 'high',
  } as never)

  // Run 2 under a CHANGED default: both agents hit the cache.
  const journal2 = new LocalFileJournal(runDir)
  const rig2 = makeRig({ runDir, mainLoopModel: 'claude-model-two', journal: journal2, snapshot: await journal2.load() })
  const h1 = await rig2.hooks.agent('first job')
  const h2 = await rig2.hooks.agent('second job')
  check('both replays served from cache', String(h1).includes('live-answer') && String(h2).includes('live-answer'))
  const cachedFrames = rig2.frames.filter(f => f.cached === true)
  check('two cached frames emitted', cachedFrames.length === 2, String(cachedFrames.length))
  const withMeta = cachedFrames.find(f => f.agentId === firstResult!.agentId)
  const withoutMeta = cachedFrames.find(f => f.agentId !== firstResult!.agentId)
  check(
    'the recorded model renders — never the new session default',
    withMeta?.model === 'claude-model-that-ran',
    String(withMeta?.model),
  )
  check('the recorded effort rides along', withMeta?.effort === 'high', String(withMeta?.effort))
  check(
    "no metadata (legacy row) reads 'provenance unknown' — never the new default",
    withoutMeta?.model === 'provenance unknown',
    String(withoutMeta?.model),
  )
  check(
    'neither replayed frame claims the changed default',
    !cachedFrames.some(f => f.model === 'claude-model-two'),
  )
}
{
  // An EXPLICITLY named model rode the cache key, so it is itself faithful.
  const dir = mkdtempSync(join(tmpdir(), 'replay-prov-named-'))
  const j1 = new LocalFileJournal(dir)
  const rigA = makeRig({ runDir: dir, mainLoopModel: 'claude-model-one', journal: j1, snapshot: await j1.load() })
  await rigA.hooks.agent('named job', { model: 'claude-named' })
  const j2 = new LocalFileJournal(dir)
  const rigB = makeRig({ runDir: dir, mainLoopModel: 'claude-model-two', journal: j2, snapshot: await j2.load() })
  await rigB.hooks.agent('named job', { model: 'claude-named' })
  const cached = rigB.frames.find(f => f.cached === true)
  check('an explicit model replays as itself (keyed — faithful by construction)',
    cached?.model === 'claude-named', String(cached?.model))
  rmSync(dir, { recursive: true, force: true })
}
check(
  'the cache key inputs are UNCHANGED (key-stability law: old journals stay valid)',
  agentCacheKey('p', { model: 'm' }, '') === agentCacheKey('p', { model: 'm' }, '') &&
    agentCacheKey('p', undefined, '').startsWith('v2:'),
  agentCacheKey('p', undefined, ''),
)

section('§B the journal: serialized appends + the honest degraded state')
{
  const dir = mkdtempSync(join(tmpdir(), 'replay-prov-serial-'))
  const j = new LocalFileJournal(join(dir, 'r'))
  // fire 30 appends WITHOUT awaiting — the chain must land them in call order
  const writes: Promise<void>[] = []
  for (let i = 0; i < 30; i++) {
    writes.push(j.append({ type: 'started', key: `k${i}`, agentId: `a${i}` }))
  }
  await Promise.all(writes)
  const lines = readFileSync(join(dir, 'r', 'journal.jsonl'), 'utf8').trim().split('\n')
  check('30 concurrent appends land as 30 intact lines', lines.length === 30, String(lines.length))
  check(
    'lines land in CALL order (serialized, never interleaved)',
    lines.every((l, i) => (JSON.parse(l) as { key: string }).key === `k${i}`),
  )
  check('a healthy journal is not degraded', j.degraded() === undefined)
  rmSync(dir, { recursive: true, force: true })
}
{
  // parent path is a FILE — every append fails; degraded fires ONCE.
  const dir = mkdtempSync(join(tmpdir(), 'replay-prov-fail-'))
  writeFileSync(join(dir, 'blocked'), 'a file where the dir belongs')
  let fired = 0
  const j = new LocalFileJournal(join(dir, 'blocked', 'sub'), {
    onDegraded: () => fired++,
  })
  let rejected = 0
  await j.append({ type: 'started', key: 'k', agentId: 'a' }).catch(() => rejected++)
  await j.append({ type: 'started', key: 'k2', agentId: 'a2' }).catch(() => rejected++)
  check('failed appends reject to their caller', rejected === 2)
  check('the journal is DEGRADED after the first failure', /journal append failed/.test(j.degraded() ?? ''), j.degraded())
  check('the surface callback fired exactly ONCE', fired === 1, String(fired))
  rmSync(dir, { recursive: true, force: true })
}
{
  // a corrupt line degrades the LOAD and still serves the good rows
  const dir = mkdtempSync(join(tmpdir(), 'replay-prov-corrupt-'))
  mkdirSync(join(dir, 'r'), { recursive: true })
  writeFileSync(
    join(dir, 'r', 'journal.jsonl'),
    `${JSON.stringify({ type: 'result', key: 'k1', agentId: 'a1', result: 'one' })}\n{TORN LINE\n${JSON.stringify({ type: 'result', key: 'k2', agentId: 'a2', result: 'two' })}\n`,
  )
  let reason = ''
  const j = new LocalFileJournal(join(dir, 'r'), { onDegraded: r => (reason = r) })
  const snap = await j.load()
  check('the good rows still load', snap.results.size === 2)
  check(
    'a skipped line marks the journal degraded with an honest count',
    /1 unparseable journal line/.test(reason),
    reason,
  )
  rmSync(dir, { recursive: true, force: true })
}

section('§C wiring pins')
{
  const wt = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'WorkflowTool.tsx'),
    'utf8',
  )
  check(
    'WorkflowTool surfaces journal degradation into the live progress log',
    wt.includes('onDegraded: reason =>') && wt.includes('journal degraded — cached replay may be incomplete'),
  )
  const hooks = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'agentHooks.js').replace('.js', '.ts'),
    'utf8',
  )
  check(
    'the cached frame joins the launch-parity record at hit time',
    hooks.includes('readAgentMetadata(entry.agentId'),
  )
}

rmSync(runDir, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} REPLAY-PROVENANCE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL REPLAY-PROVENANCE PROOFS PASS')
