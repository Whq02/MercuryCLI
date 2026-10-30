#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'hotpath-cadence-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_PROJECT_INTEL = '1'

await import('../../src/tasks.js')
const { makeMaybe, getAttachments } = await import('../../src/utils/attachments/orchestrator.js')
const { getProjectSnapshot, _resetProjectIntelForTesting } = await import(
  '../../src/services/projectIntel/snapshot.js'
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
  const expired = makeMaybe(0)
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
  const live = makeMaybe(performance.now() + 60_000)
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
    agentId: 'cadence-probe-agent',
    messages: [],
    getAppState: () => ({ tasks: {} }),
    options: { agentDefinitions: { activeAgents: [] }, tools: [], engineModel: 'claude-opus-5' },
  } as never
  const queued = [{ value: 'queued operator note', mode: 'prompt' }] as never
  const t0 = Date.now()
  const attachments = (await getAttachments('hello there', ctx, queued)) as Array<{
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

section('C3 — the runner records its new tail and owns the durable flush')
{
  const runner = readFileSync(join(import.meta.dir, '../../src/rows/turn.ts'), 'utf8')
  check('the runner records only the new message suffix', runner.includes('const pending = turnMessages.slice(this.recordCursor)') && runner.includes('this.recordCursor = turnMessages.length'))
  check('the runner serialises recording through its parent-hint chain', runner.includes('this.recordChain = this.recordChain.then(hint =>') && runner.includes('recordTranscript(pending,'))
  const { recordTranscript, flushSessionStorage, setSessionFileForTesting } = await import('../../src/utils/sessionStorage/writer.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
  const file = join(HOME, 'runner-tail.jsonl')
  setSessionFileForTesting(file)
  const prompt = createUserMessage({ content: 'do it' })
  const reply = createAssistantMessage({ content: 'all done' })
  const parent = await recordTranscript([prompt])
  await recordTranscript([reply], parent ?? undefined, [prompt, reply])
  await flushSessionStorage()
  const rows = decodeTranscriptBuffer<{ uuid?: string; parentUuid?: string }>(readFileSync(file)).entries
  check('the flush lands each row once and preserves the parent chain', rows.filter(row => row.uuid === prompt.uuid).length === 1 && rows.filter(row => row.uuid === reply.uuid).length === 1 && rows.find(row => row.uuid === reply.uuid)?.parentUuid === prompt.uuid)
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} HOT-PATH CADENCE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL HOT-PATH CADENCE PROOFS PASS')
process.exit(0)
