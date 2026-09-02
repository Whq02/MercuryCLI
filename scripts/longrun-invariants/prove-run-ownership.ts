#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-run-ownership.ts — run ownership + evidence
//  destination.
//
//  What the code did vs the invariant it missed:
//   • Resume-conflict detection read only this process's memory, and owner
//     identity in the manifest was a bare PID — a second session saw no
//     conflict, and after a crash a RECYCLED pid answered "someone holds
//     this pid", holding the run unresumable forever (the check never asked
//     "is the RECORDED owner alive").
//   • Transcript destinations were recomputed from the mutable session
//     identity at every write — /clear or a cross-session resume split one
//     agent's chain across directories no single reader reconstructs.
//
//  The invariant: ownership is a claim file (random instance id + monotonic
//  epoch); owner-liveness is the manifest heartbeat; a stale owner's late
//  writes are fenced (manifest) and filtered (journal); the transcript
//  destination is captured once at launch; and the manifest's append-only
//  transcriptDirs list lets every reader fall back across the whole set.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'run-ownership-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const {
  claimRun,
  readRunClaim,
  recordedOwnerAlive,
  diskResumability,
  createManifestWriteChain,
  RUN_MANIFEST_STALE_MS,
} = await import('../../src/tools/WorkflowTool/runManifest.js')
const { LocalFileJournal, indexJournal } = await import(
  '../../src/tools/WorkflowTool/agentHooks.js'
)
const { resolveAgentTranscriptFile, agentTranscriptFile } = await import(
  '../../src/tools/WorkflowTool/agentTranscriptReader.js'
)
const { recordSidechainTranscript, registerAgentTranscriptDestination, getProject } =
  await import('../../src/utils/sessionStorage/writer.js')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.js')
const { asAgentId } = await import('../../src/types/ids.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the claim: random instance id + monotonic epoch, never a pid')
{
  const runDir = mkdtempSync(join(tmpdir(), 'run-ownership-claim-'))
  const first = await claimRun(runDir)
  check('launch claims epoch 1', first.epoch === 1, String(first.epoch))
  check('the identity is a random instance id, not the pid', /^[0-9a-f-]{36}$/.test(first.instanceId))
  const second = await claimRun(runDir)
  check('a re-claim bumps the epoch monotonically', second.epoch === 2)
  check('…under a FRESH instance id', second.instanceId !== first.instanceId)
  const onDisk = await readRunClaim(runDir)
  check('the claim round-trips from disk', onDisk?.epoch === 2 && onDisk.instanceId === second.instanceId)
  const [a, b] = await Promise.all([claimRun(runDir), claimRun(runDir)])
  check(
    'two CONCURRENT re-claims mint distinct epochs (lockfile serialization)',
    new Set([a.epoch, b.epoch]).size === 2 && Math.max(a.epoch, b.epoch) === 4,
    JSON.stringify([a.epoch, b.epoch]),
  )
  rmSync(runDir, { recursive: true, force: true })
}

section('§B owner liveness is the heartbeat — a recycled pid cannot hold a run')
{
  const NOW = 1_000_000_000
  check('running + fresh heartbeat ⇒ the recorded owner is alive',
    recordedOwnerAlive({ status: 'running' }, NOW - 5_000, NOW) === true)
  check('running + stale heartbeat ⇒ the recorded owner is gone',
    recordedOwnerAlive({ status: 'running' }, NOW - RUN_MANIFEST_STALE_MS - 1_000, NOW) === false)
  check('a settled run has no live owner', recordedOwnerAlive({ status: 'paused' }, NOW, NOW) === false)

  const dir = mkdtempSync(join(tmpdir(), 'run-ownership-resume-'))
  writeFileSync(join(dir, 'workflow.js'), "export const meta={name:'x',description:'y'}\nreturn 1\n")
  const deps = {
    // a RECYCLED pid: alive, but it is NOT the recorded owner
    pidAlive: () => true,
    fileExists: (p: string) => existsSync(p),
    readFileText: (p: string) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    sha256: (t: string) => t,
    nowMs: NOW,
  }
  const base = { runDir: dir, ownerPid: 4242, scriptPath: join(dir, 'workflow.js') }
  const recycled = diskResumability(
    { ...base, status: 'running' as const, mtimeMs: NOW - RUN_MANIFEST_STALE_MS - 60_000 },
    deps,
  )
  check(
    'stale heartbeat + ALIVE recycled pid ⇒ recoverable (the unresumable-forever fix)',
    recycled.ok === true,
    JSON.stringify(recycled),
  )
  const healthy = diskResumability(
    { ...base, status: 'running' as const, mtimeMs: NOW - 5_000 },
    deps,
  )
  check(
    'fresh heartbeat ⇒ refused as owned by the RECORDED owner',
    healthy.ok === false && /heartbeat fresh/.test((healthy as { reason: string }).reason),
    JSON.stringify(healthy),
  )
  const legacy = diskResumability({ ...base, status: 'running' as const }, { ...deps, nowMs: undefined })
  check('callers without an mtime keep the legacy pid rule',
    legacy.ok === false && /still owned by live pid/.test((legacy as { reason: string }).reason))
  rmSync(dir, { recursive: true, force: true })
}

section('§C the manifest fence: a superseded owner cannot clobber the new one')
{
  const published: string[] = []
  let owned = true
  let fenced = 0
  const chain = createManifestWriteChain(
    async m => {
      published.push(m.status)
    },
    () => {},
    { stillOwner: async () => owned, onFenced: () => fenced++ },
  )
  const snap = (status: string): never =>
    ({ version: 1, runId: 'r', runDir: '/x', startTime: 0, status, ownerPid: 1, agentCount: 0, totalTokens: 0, totalToolCalls: 0, agents: [] }) as never
  check('an owned write lands', (await chain.write(snap('running'), false)) === true && published.length === 1)
  owned = false
  const late = await chain.write(snap('killed'), true)
  check('a superseded owner\'s write is SKIPPED, never published', late === false && published.length === 1)
  check('the fence reported exactly once', ((await chain.write(snap('killed'), true)), fenced) === 1)
  check('a fenced terminal write does not zombie-latch', chain.finalized() === false)
}

section('§D the journal epoch fence: a woken stale owner\'s late rows are filtered')
{
  const dir = mkdtempSync(join(tmpdir(), 'run-ownership-journal-'))
  const j1 = new LocalFileJournal(join(dir, 'r'), { epoch: 1 })
  await j1.append({ type: 'result', key: 'k1', agentId: 'a1', result: 'epoch1-original' })
  const j2 = new LocalFileJournal(join(dir, 'r'), { epoch: 2 })
  await j2.append({ type: 'result', key: 'k2', agentId: 'a2', result: 'epoch2-fresh' })
  // the zombie wakes and appends AFTER the takeover — same key as epoch 2's
  await j1.append({ type: 'result', key: 'k2', agentId: 'a1-zombie', result: 'stale-shadow' })
  const snap = await new LocalFileJournal(join(dir, 'r')).load()
  check('rows are epoch-stamped on disk',
    readFileSync(join(dir, 'r', 'journal.jsonl'), 'utf8').includes('"epoch":2'))
  check('the pre-takeover epoch-1 row is KEPT (cache reuse law)',
    snap.results.get('k1')?.result === 'epoch1-original')
  check('the post-takeover epoch-1 row is FILTERED (never shadows the new owner)',
    snap.results.get('k2')?.result === 'epoch2-fresh',
    String(snap.results.get('k2')?.result))
  check('legacy journals (no epochs anywhere) load untouched', (() => {
    const legacy = indexJournal([
      { type: 'result', key: 'a', agentId: 'x', result: 1 } as never,
      { type: 'result', key: 'b', agentId: 'y', result: 2 } as never,
    ])
    return legacy.results.size === 2
  })())
  rmSync(dir, { recursive: true, force: true })
}

section('§E the destination is captured at launch; readers fall back across dirs')
{
  const agentId = 'a-dest-capture'
  const captured = join(mkdtempSync(join(tmpdir(), 'run-ownership-dest-')), 'agent-a-dest-capture.jsonl')
  registerAgentTranscriptDestination(agentId, captured)
  await recordSidechainTranscript(
    [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-000000000077',
        parentUuid: null,
        isSidechain: true,
        message: { role: 'user', content: 'captured-destination row' },
        timestamp: new Date(1700000000000).toISOString(),
      },
    ] as never,
    agentId,
  )
  await getProject().flush()
  check('the sidechain write landed at the CAPTURED destination', existsSync(captured))
  const derived = getAgentTranscriptPath(asAgentId(agentId))
  check('…not at the live-derived path', !existsSync(derived), derived)

  const oldDir = mkdtempSync(join(tmpdir(), 'run-ownership-old-'))
  const newDir = mkdtempSync(join(tmpdir(), 'run-ownership-new-'))
  writeFileSync(agentTranscriptFile(oldDir, 'agX'), '{"type":"user"}\n')
  check(
    'the reader falls back to the OLD destination when the primary is empty',
    resolveAgentTranscriptFile([newDir, oldDir], 'agX') === agentTranscriptFile(oldDir, 'agX'),
  )
  check(
    'with no file anywhere the primary path is still named (honest missing state)',
    resolveAgentTranscriptFile([newDir, oldDir], 'agY') === agentTranscriptFile(newDir, 'agY'),
  )
  rmSync(oldDir, { recursive: true, force: true })
  rmSync(newDir, { recursive: true, force: true })
}

section('§F wiring pins (WorkflowTool)')
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'WorkflowTool.tsx'),
    'utf8',
  )
  check('the run is claimed at launch/resume (inside the atomic-launch guard) (transcriptDir → runDir)',
    src.includes('claim = await claimRun(runDir)'))
  check('the manifest stamps the owner claim',
    src.includes('owner: { instanceId: claim.instanceId, epoch: claim.epoch }'))
  check('the manifest carries the append-only transcriptDirs union',
    src.includes('transcriptDirs: [...transcriptDirsSeen]'))
  check('the write chain is fenced on the live claim', src.includes('stillOwner: async () =>'))
  check('the journal stamps the owner epoch', src.includes('epoch: claim.epoch'))
  check('resume refuses under a fresh heartbeat (cross-process conflict)',
    src.includes('recordedOwnerAlive(prior, prior.mtimeMs, Date.now())'))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} RUN-OWNERSHIP PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL RUN-OWNERSHIP PROOFS PASS')
process.exit(0)
