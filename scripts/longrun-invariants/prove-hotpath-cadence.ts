#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-hotpath-cadence.ts — the hot-path cadence tranche
//  (post-queue; the read-only cadence investigation, adjudicated CONFIRMED).
//
//  C1 — attachment orchestrator deadline: expired optional work used to
//  START anyway (the deadline gated only the race arm) and a raced-out
//  producer kept running with no reuse, so outstanding late work grew per
//  collection. Now: expired optional work returns without starting
//  (recorded 'skipped'), consume-once producers ride a priority lane, and
//  ambient producers single-flight by label.
//
//  C2 — snapshot cadence: a successful same-tree validation never refreshed
//  a currency timestamp, so past the build age EVERY collection >10s apart
//  re-paid the 0.5–1.5s tree digest; mutation invalidation cleared every
//  workspace's digest; the capsule paid the snapshot before its own cheap
//  unchanged-identity check.
//
//  C3 — transcript cadence: the turn-boundary flush fired on tool-loop rows
//  (tool results are user-shaped; mid-loop assistant rows carry tool_use),
//  defeating the writer's batching; collectReplIds walked the full
//  transcript twice per appended message (the material quadratic).
// ============================================================================
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'hotpath-cadence-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_PROJECT_INTEL = '1'

await import('../../src/tasks.js')
const { makeMaybe, getAttachments } = await import('../../src/utils/attachments/orchestrator.js')
const { pulseNow } = await import('../../src/utils/pulse/turnPhase.js')
const { getProjectSnapshot, _resetProjectIntelForTesting } = await import(
  '../../src/services/projectIntel/snapshot.js'
)
const { isTurnBoundaryRow } = await import('../../src/hooks/useLogMessages.js')
const { cleanMessagesForLogging, collectReplIds, collectReplIdsInto } = await import(
  '../../src/utils/sessionStorage/chain.js'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

section('C1 §maybe — expired optional work never starts; priority still runs')
{
  // deadlines are in pulseNow() units (monotonic) — 0 is always in the past
  const expired = makeMaybe(false, 0)
  let optionalStarts = 0
  const optional = await expired('opt', async () => {
    optionalStarts++
    return ['x']
  })
  check('expired optional work returns [] WITHOUT starting', optional.length === 0 && optionalStarts === 0)
  let priorityStarts = 0
  const priority = await expired(
    'prio',
    async () => {
      priorityStarts++
      return ['kept']
    },
    { priority: true },
  )
  check('expired PRIORITY work still runs to completion (consume-once law)',
    priorityStarts === 1 && priority.length === 1)
}
{
  const live = makeMaybe(false, pulseNow() + 60_000)
  let starts = 0
  const slowBody = (): Promise<string[]> =>
    new Promise(resolve => {
      starts++
      setTimeout(() => resolve(['done']), 150)
    })
  const [a, b] = await Promise.all([
    live('ambient_probe', slowBody),
    live('ambient_probe', slowBody),
  ])
  check('two concurrent collections SINGLE-FLIGHT the same ambient label',
    starts === 1 && a[0] === 'done' && b[0] === 'done', String(starts))
  await live('ambient_probe', slowBody)
  check('after settle, a fresh collection runs it again', starts === 2)
  let scopedStarts = 0
  const scopedBody = (): Promise<string[]> =>
    new Promise(resolve => {
      scopedStarts++
      setTimeout(() => resolve(['s']), 120)
    })
  await Promise.all([
    live('scoped_probe', scopedBody, { inputScoped: true }),
    live('scoped_probe', scopedBody, { inputScoped: true }),
  ])
  check('input-scoped producers NEVER reuse a prior in-flight instance', scopedStarts === 2)
}

section('C1 §end-to-end — phase-one exhaustion cannot unbound the collection')
{
  process.env.MERCURY_PULSE_FIXTURE = 'stuck-user-input-producer=2600,stuck-producer=4000'
  const ctx = {
    agentId: 'cadence-probe-agent', // subagent shape: lean producer set
    getAppState: () => ({ tasks: {} }),
    options: { agentDefinitions: { activeAgents: [] }, tools: [], mainLoopModel: 'claude-opus-5' },
  } as never
  const queued = [{ value: 'queued operator note', mode: 'prompt' }] as never
  const t0 = Date.now()
  const attachments = (await getAttachments('hello there', ctx, null, queued)) as Array<{
    type: string
  }>
  const wall = Date.now() - t0
  check(
    'the collection stays bounded although phase one spent the whole budget (< 3500ms, not the 4000ms stuck producer)',
    wall < 3_500,
    `${wall}ms`,
  )
  check(
    'the consume-once queued command SURVIVED the exhausted budget (priority lane)',
    attachments.some(a => a.type === 'queued_command'),
    JSON.stringify(attachments.map(a => a.type)),
  )
  delete process.env.MERCURY_PULSE_FIXTURE
}

section('C2 — a successful validation refreshes currency; scoped invalidation')
{
  const ws = mkdtempSync(join(tmpdir(), 'hotpath-cadence-ws-'))
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: ws })
  writeFileSync(join(ws, 'a.txt'), 'one\n')
  execSync('git add -A && git commit -qm init', { cwd: ws })

  _resetProjectIntelForTesting()
  const fresh = getProjectSnapshot(ws, { maxStaleMs: 120_000 })
  check('cold read builds fresh', fresh?.from === 'fresh', fresh?.from)
  // age the snapshot past the TTL (the same generation object is cached)
  fresh!.snapshot.generation.scannedAtMs = Date.now() - 200_000
  const validated = getProjectSnapshot(ws, { maxStaleMs: 120_000 })
  check('the aged read validates against the live tree', validated?.from === 'cache-validated', validated?.from)
  const after = getProjectSnapshot(ws, { maxStaleMs: 120_000 })
  check(
    "validation REFRESHED currency — the next read is 'cache-ttl', not another digest",
    after?.from === 'cache-ttl',
    after?.from,
  )
  rmSync(ws, { recursive: true, force: true })

  const vs = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'verification', 'verificationState.ts'),
    'utf8',
  )
  check('mutation invalidation is cwd-scoped with the conservative fallback',
    vs.includes('digestCache.delete(cwd)') && vs.includes('else digestCache.clear()'))
  const eo = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'run', 'effectObserver.ts'),
    'utf8',
  )
  // 3.4 reshaped the call (the digestReceipted opts rider) — the pin holds
  // the same fact: the observer passes ITS event's cwd, never ambient state.
  check('the effect observer passes its event cwd', eo.includes('markMutation(event.owner, event.effect.changedPaths, event.cwd, {'))
  const cc = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'attachments', 'contextCapsule.ts'),
    'utf8',
  )
  check('the capsule computes its semantic identity BEFORE the snapshot read',
    cc.indexOf('const semDigest = createHash') !== -1 && cc.indexOf('const semDigest = createHash') < cc.indexOf('getProjectSnapshotAsync(workspace'))
  check('an unchanged identity reuses whatever snapshot is cached (no freshness demand)',
    cc.includes('semanticallyUnchanged ? Number.POSITIVE_INFINITY : 120_000'))
}

section('C3 — the flush fires on turn boundaries; REPL-id work is linear')
{
  const userPrompt = { type: 'user', message: { role: 'user', content: 'do it' } } as never
  const toolResult = {
    type: 'user',
    toolUseResult: { ok: true },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  } as never
  const midLoop = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'now I will' }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
  } as never
  const finalText = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'all done' }] },
  } as never
  check('a real user prompt is a boundary', isTurnBoundaryRow(userPrompt) === true)
  check('a tool result (user-shaped) is NOT a boundary', isTurnBoundaryRow(toolResult) === false)
  check('a mid-loop tool-use assistant row is NOT a boundary', isTurnBoundaryRow(midLoop) === false)
  check('the settling assistant text IS a boundary', isTurnBoundaryRow(finalText) === true)

  // the incremental set must agree with the full collection, at O(slice)
  const replUse = (id: string): unknown => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'REPL', input: {} }] },
  })
  const all = [userPrompt, replUse('r1'), toolResult, replUse('r2'), finalText] as never[]
  const full = collectReplIds(all as never)
  const incremental = new Set<string>()
  for (const m of all) collectReplIdsInto(incremental, [m] as never)
  check('incremental REPL-id maintenance ≡ the full collection',
    full.size === incremental.size && [...full].every(id => incremental.has(id)))
  const viaSet = cleanMessagesForLogging(all as never, all as never, incremental)
  const viaFull = cleanMessagesForLogging(all as never, all as never)
  check('cleanMessagesForLogging with the maintained set ≡ the historical path',
    JSON.stringify(viaSet) === JSON.stringify(viaFull))

  const hook = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'hooks', 'useLogMessages.ts'),
    'utf8',
  )
  check('the hook maintains ONE append-only set (no per-append full walk)',
    hook.includes('collectReplIdsInto(replIdsRef.current, slice)') &&
      hook.includes('replIds,'))
  check('the flush barrier is boundary-driven with a bounded max latency',
    hook.includes('slice.some(isTurnBoundaryRow)') &&
      hook.includes('FLUSH_MAX_LATENCY_MS'))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} HOT-PATH CADENCE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL HOT-PATH CADENCE PROOFS PASS')
process.exit(0)
