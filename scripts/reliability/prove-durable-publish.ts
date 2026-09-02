// prove-durable-publish — the ONE durable publication primitive.
//
//   §1 contract: round-trip, atomic replace, no temp residue
//   §2 concurrent same-path publishes never collide (the FC2 class, in-process)
//   §3 typed failure phases (fault-injected): prior committed content is
//      preserved, the primitive's own temp is cleaned, the phase is named
//   §4 abrupt death at exact phases (kill children): destination is always
//      old-complete or new-complete; crash orphans match the owned pattern
//      and are swept by the age-gated cleaner
//   §5 the sync twin honors the same contract
//   §6 migration ratchet: every migrated writer imports the primitive and its
//      old hand-rolled tmp+rename publication fingerprint is absent
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  cleanupOrphanDurableTemps,
  durableAtomicPublish,
  durableAtomicPublishSync,
  DurablePublishError,
  isDurableTempName,
} from '../../src/substrate/durablePublish.ts'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'hermes-durpub-'))
const BUN = process.execPath
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(isDurableTempName)

// ── §1 contract ──────────────────────────────────────────────────────────────
{
  const p = join(tmp, 's1', 'store.json')
  await durableAtomicPublish(p, 'first')
  ok(readFileSync(p, 'utf8') === 'first', '§1 publish round-trip')
  await durableAtomicPublish(p, 'second')
  ok(readFileSync(p, 'utf8') === 'second', '§1 atomic replace')
  ok(tempsIn(join(tmp, 's1')).length === 0, '§1 no temp residue after success')
}

// ── §2 concurrent same-path publishes (the FC2 class) ───────────────────────
{
  const dir = join(tmp, 's2')
  const p = join(dir, 'hot.json')
  let anomalies = 0
  for (let i = 0; i < 30; i++) {
    const a = 'A'.repeat(32 * 1024)
    const b = 'B'.repeat(1024)
    const settled = await Promise.allSettled([
      durableAtomicPublish(p, a),
      durableAtomicPublish(p, b),
    ])
    if (settled.some(s => s.status === 'rejected')) anomalies++
    else {
      const got = readFileSync(p, 'utf8')
      if (got !== a && got !== b) anomalies++
    }
  }
  ok(anomalies === 0, `§2 30 overlapping publish rounds: zero collisions/tears (${anomalies})`)
  ok(tempsIn(dir).length === 0, '§2 zero orphan temps after the storm')
}

// ── §3 typed failure phases preserve the committed destination ──────────────
{
  const dir = join(tmp, 's3')
  const p = join(dir, 'victim.json')
  await durableAtomicPublish(p, 'committed')
  for (const phase of ['create-temp', 'write', 'flush-file', 'rename'] as const) {
    process.env.MERCURY_FAULT_INJECT = `${phase}@victim.json:throw`
    let caught: unknown = null
    try {
      await durableAtomicPublish(p, 'doomed')
    } catch (e) {
      caught = e
    }
    delete process.env.MERCURY_FAULT_INJECT
    const typed = caught instanceof DurablePublishError && caught.phase === phase
    ok(typed, `§3 ${phase}: typed DurablePublishError with the failing phase`)
    ok(readFileSync(p, 'utf8') === 'committed', `§3 ${phase}: prior committed content preserved`)
    ok(tempsIn(dir).length === 0, `§3 ${phase}: own temp cleaned`)
  }
  // flush-dir fails AFTER the rename: typed, but the publication is visible.
  process.env.MERCURY_FAULT_INJECT = 'flush-dir@victim.json:throw'
  let caught: unknown = null
  try {
    await durableAtomicPublish(p, 'landed')
  } catch (e) {
    caught = e
  }
  delete process.env.MERCURY_FAULT_INJECT
  ok(
    caught instanceof DurablePublishError &&
      caught.phase === 'flush-dir' &&
      readFileSync(p, 'utf8') === 'landed',
    '§3 flush-dir: typed failure AFTER the visible rename (documented)',
  )
}

// ── §4 abrupt death at exact phases (real children) ─────────────────────────
{
  const dir = join(tmp, 's4')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'target.json')
  writeFileSync(p, 'old-complete')
  const runKill = (phase: string): ReturnType<typeof spawnSync> =>
    spawnSync(BUN, ['run', join(import.meta.dir, 'helpers', 'durablePublishKillChild.ts')], {
      env: {
        ...process.env,
        RELIA_TARGET: p,
        RELIA_CONTENT: 'new-complete',
        MERCURY_FAULT_INJECT: `${phase}@target.json:kill`,
      },
      encoding: 'utf8',
      timeout: 20_000,
    })
  // Killed before the rename: destination stays old-complete, orphan temp remains.
  const preRename = runKill('rename')
  ok(preRename.signal === 'SIGKILL', '§4 child died at the rename boundary')
  ok(readFileSync(p, 'utf8') === 'old-complete', '§4 kill@rename: destination stays old-complete')
  const orphans = tempsIn(dir)
  ok(orphans.length === 1, `§4 kill@rename leaves exactly the owned orphan temp (${orphans.length})`)
  const removed = await cleanupOrphanDurableTemps(dir, { olderThanMs: 0 })
  ok(
    removed.length === 1 && tempsIn(dir).length === 0,
    '§4 the sweeper removes exactly the owned orphan (pattern-scoped)',
  )
  // Killed after the rename (at flush-dir): destination is new-complete.
  const postRename = runKill('flush-dir')
  ok(
    postRename.signal === 'SIGKILL' && readFileSync(p, 'utf8') === 'new-complete',
    '§4 kill@flush-dir: destination is new-complete (rename already landed)',
  )
  // A non-matching file is never swept.
  writeFileSync(join(dir, 'unrelated.tmp'), 'keep me')
  const removed2 = await cleanupOrphanDurableTemps(dir, { olderThanMs: 0 })
  ok(
    removed2.length <= 1 && readFileSync(join(dir, 'unrelated.tmp'), 'utf8') === 'keep me',
    '§4 the sweeper never touches files outside the owned pattern',
  )
}

// ── §5 sync twin parity ──────────────────────────────────────────────────────
{
  const dir = join(tmp, 's5')
  const p = join(dir, 'sync.json')
  durableAtomicPublishSync(p, 'sync-first')
  durableAtomicPublishSync(p, 'sync-second')
  ok(readFileSync(p, 'utf8') === 'sync-second', '§5 sync twin round-trip + replace')
  process.env.MERCURY_FAULT_INJECT = 'write@sync.json:throw'
  let caught: unknown = null
  try {
    durableAtomicPublishSync(p, 'doomed')
  } catch (e) {
    caught = e
  }
  delete process.env.MERCURY_FAULT_INJECT
  ok(
    caught instanceof DurablePublishError &&
      caught.phase === 'write' &&
      readFileSync(p, 'utf8') === 'sync-second' &&
      tempsIn(dir).length === 0,
    '§5 sync twin: typed phase + preserved destination + cleaned temp',
  )
}

// ── §6 migration ratchet ─────────────────────────────────────────────────────
{
  const repo = join(import.meta.dir, '..', '..')
  const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')
  const migrated: Array<[string, RegExp]> = [
    ['src/substrate/fileStore.ts', /await writeFile\(tmp/],
    ['src/services/run/runSidecar.ts', /\.tmp-\$\{process\.pid\}/],
    ['src/utils/swarm/teamHelpers.ts', /renameSync\(tmp/],
    ['src/memdir/experienceCards.ts', /await rename\(tmp/],
    ['src/memdir/tasteLoop.ts', /await rename\(tmp/],
    ['src/memdir/mnemeConsolidate.ts', /renameSync\(`\$\{p\}\.tmp`/],
    ['src/tools/WorkflowTool/runManifest.ts', /await rename\(tmp/],
    ['src/services/mcp/config.ts', /await rename\(tempPath, mcpJsonPath\)/],
    ['src/utils/tabula/tabulaStore.ts', /renameSync\(tmp/],
    ['src/substrate/themis/drift.ts', /await rename\(`\$\{p\}\.tmp`/],
    ['src/substrate/themis/auditChain.ts', /await rename\(tmp, st\.headFile\)/],
    ['src/substrate/themis/integrity.ts', /await rename\(`\$\{p\}\.tmp`/],
    ['src/tools/ToolSearchTool/cooccurPrior.ts', /renameSync\(tmp/],
    ['src/utils/artifacts/store.ts', /await rename\(tmpPath, metaPath\)/],
    ['src/utils/cache/cacheClock.ts', /renameSync\(tmpPath, finalPath\)/],
    ['src/utils/cockpit/critterProfile.ts', /renameSync\(tmp/],
  ]
  let allClean = true
  for (const [rel, oldFingerprint] of migrated) {
    const src = read(rel)
    const imports = src.includes("durablePublish.js'") || rel.endsWith('durablePublish.ts')
    const oldGone = !oldFingerprint.test(src)
    if (!imports || !oldGone) {
      allClean = false
      console.log(`     ${rel}: imports=${imports} oldGone=${oldGone}`)
    }
  }
  ok(allClean, `§6 all ${migrated.length} migrated writers import the primitive; old fingerprints gone`)
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-durable-publish' : `\nFAIL prove-durable-publish (${failures})`)
process.exit(failures === 0 ? 0 : 1)
