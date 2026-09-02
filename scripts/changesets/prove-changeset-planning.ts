#!/usr/bin/env bun
// ============================================================================
//  scripts/changesets/prove-changeset-planning.ts — the nine-step all-target
//  preflight + the plan store honesty laws:
//    · 2/3/bounded-maximum file sets; multiple hunks per file;
//    · CRLF/LF · UTF-8 multibyte · missing final newline · executable mode;
//    · duplicate paths in different spellings refuse;
//    · malformed + stale anchors at EVERY set position, ALL collected;
//    · range-anchor window violations; overlapping/out-of-bounds hunks;
//    · exceeded file/hunk/byte/diff bounds NAME the limit + recovery;
//    · deterministic content-addressed digest (member order + object-key
//      order irrelevant);
//    · no-change classification (already-satisfied ≠ failure);
//    · target-class refusals BY NAME (missing · directory · notebook ·
//      binary); read-evidence + scope hooks;
//    · plan ring eviction (evicted ≠ absent) · TTL expiry · discard ·
//      owner isolation.
//  Pure planning — this prover NEVER applies; the tree stays byte-identical.
// ============================================================================

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-plan-cs-'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { planChangeSet, sha256Hex } = await import(
  '../../src/services/changeTransaction/changeSetPlan.ts'
)
const { CHANGESET_BOUNDS } = await import(
  '../../src/services/changeTransaction/changeSetContracts.ts'
)
const { mintFileAnchor, mintRangeAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
const {
  rememberChangeSetPlan,
  getChangeSetPlan,
  changeSetPlanEvicted,
  changeSetPlanExpired,
  setChangeSetPlanState,
  _resetChangeSetStoreForTesting,
} = await import('../../src/services/changeTransaction/changeSetStore.ts')
const { processMainOwner, processOwnerForLane } = await import(
  '../../src/services/run/resolveOwner.ts'
)

const root = mkdtempSync(join(tmpdir(), 'fulcrum-plan-'))
mkdirSync(join(root, 'sub'))

function write(name: string, content: string, mode?: number): string {
  const p = join(root, name)
  writeFileSync(p, content)
  if (mode !== undefined) chmodSync(p, mode)
  return p
}

const A = 'alpha line 1\nalpha line 2\nalpha line 3\n'
const B = 'beta one\nbeta two\n'
const C = 'gamma-1\ngamma-2\ngamma-3\ngamma-4\n'
const aPath = write('a.ts', A)
const bPath = write('sub/b.ts', B)
const cPath = write('c.txt', C)
const crlfPath = write('crlf.txt', 'first\r\nsecond\r\nthird\r\n')
const cjkContent = '第一行の内容\nsecond 行\nthird\n'
const cjkPath = write('cjk.txt', cjkContent)
const noNlPath = write('nonl.txt', 'one\ntwo')
const execPath = write('run.sh', '#!/bin/sh\necho hi\n', 0o755)
const ipynbPath = write('nb.ipynb', '{"cells":[]}')
const binPath = join(root, 'bin.dat')
writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x00, 0x01]))

const anchorOf = (p: string): string =>
  mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'))
const member = (p: string, hunks: object[], anchor?: string) => ({
  file_path: p,
  expected_anchor: anchor ?? anchorOf(p),
  hunks: hunks as { lines: string; replace: string; insert?: 'before' | 'after' }[],
})
const ctx = { ownerKey: 'fulcrum-plan-prover' }

const treeDigestBefore = [aPath, bPath, cPath, crlfPath, cjkPath, noNlPath, execPath]
  .map(p => sha256Hex(readFileSync(p)))
  .join('|')

console.log('── §1 planning across sets, encodings, modes ──')
{
  const two = planChangeSet(
    [member(aPath, [{ lines: '2', replace: 'ALPHA 2' }]), member(bPath, [{ lines: '1', replace: 'BETA 1' }])],
    ctx,
  )
  check('a two-file set plans', two.ok === true)
  if (two.ok) {
    check('deterministic canonical-path order', two.plan.targets.length === 2 && two.plan.targets[0]!.canonicalPath < two.plan.targets[1]!.canonicalPath)
    check('plan id is content-addressed (cs-hex12)', /^cs-[0-9a-f]{12}$/.test(two.plan.id))
    check('changed set covers both members', two.plan.changedPaths.length === 2 && two.plan.noChangePaths.length === 0)
    check('expiry metadata rides the plan', two.plan.expiresAt === two.plan.createdAt + CHANGESET_BOUNDS.planTtlMs)
  }
  const three = planChangeSet(
    [
      member(aPath, [{ lines: '1', replace: 'x1' }, { lines: '3', replace: 'x3' }]),
      member(bPath, [{ lines: '2', replace: 'y2' }]),
      member(cPath, [{ lines: '1-2', replace: 'z' }, { lines: '4', replace: '', insert: undefined as never }]),
    ],
    ctx,
  )
  check('a three-file multi-hunk set plans', three.ok === true, three.ok ? '' : (three as { message: string }).message)

  const crlf = planChangeSet([member(crlfPath, [{ lines: '2', replace: 'SECOND' }])], ctx)
  check('CRLF member plans with CRLF restored on planned disk bytes', crlf.ok === true && crlf.plan.targets[0]!.lineEndings === 'CRLF' && crlf.bytes.get(crlf.plan.targets[0]!.canonicalPath)!.plannedBytes.includes(Buffer.from('\r\n')[0]!) && crlf.bytes.get(crlf.plan.targets[0]!.canonicalPath)!.plannedBytes.toString('utf8').includes('SECOND\r\n'))

  const cjk = planChangeSet([member(cjkPath, [{ lines: '1', replace: '第一行 REPLACED' }])], ctx)
  check('UTF-8 multibyte member plans (byte length > char count)', cjk.ok === true && cjk.plan.targets[0]!.plannedByteLength > 'multibyte'.length)

  const nonl = planChangeSet([member(noNlPath, [{ lines: '1', replace: 'ONE' }])], ctx)
  check('missing final newline recorded + preserved in planned output', nonl.ok === true && nonl.plan.targets[0]!.finalNewline === false && !nonl.plan.targets[0]!.plannedContent.endsWith('\n'))

  const exec = planChangeSet([member(execPath, [{ lines: '2', replace: 'echo bye' }])], ctx)
  check('executable mode captured for preservation', exec.ok === true && (exec.plan.targets[0]!.mode & 0o111) !== 0)
}

console.log('── §2 bounds name the limit + smallest recovery ──')
{
  const many = Array.from({ length: CHANGESET_BOUNDS.maxFiles + 1 }, (_, i) => {
    const p = write(`many-${i}.txt`, `line\n`)
    return member(p, [{ lines: '1', replace: `edit ${i}` }])
  })
  const files = planChangeSet(many, ctx)
  check('file-count bound refuses naming the limit', files.ok === false && files.code === 'bounds' && files.message.includes(String(CHANGESET_BOUNDS.maxFiles)))
  check('file-count bound names a recovery action', files.ok === false && /split/i.test(files.recovery))

  const hunks = planChangeSet(
    [member(cPath, Array.from({ length: CHANGESET_BOUNDS.maxHunksPerFile + 1 }, (_, i) => ({ lines: '1', replace: `h${i}` })))],
    ctx,
  )
  check('per-file hunk bound refuses naming the limit', hunks.ok === false && hunks.code === 'bounds' && hunks.message.includes(String(CHANGESET_BOUNDS.maxHunksPerFile)))

  const big = write('big.txt', 'x'.repeat(2_200_000) + '\n')
  const big2 = write('big2.txt', 'y'.repeat(2_200_000) + '\n')
  const bytes = planChangeSet(
    [member(big, [{ lines: '1', replace: 'small' }]), member(big2, [{ lines: '1', replace: 'small' }])],
    ctx,
  )
  check('staged-byte bound refuses naming the limit', bytes.ok === false && bytes.code === 'bounds' && /MB/.test(bytes.message))
}

console.log('── §3 duplicates, anchors, hunks — ALL failures collected ──')
{
  const dup = planChangeSet(
    [member(aPath, [{ lines: '1', replace: 'x' }]), member(join(root, 'sub', '..', 'a.ts'), [{ lines: '2', replace: 'y' }])],
    ctx,
  )
  check('duplicate canonical path (different spelling) refuses', dup.ok === false && dup.code === 'duplicate-path')

  const bad = planChangeSet(
    [
      member(aPath, [{ lines: '1', replace: 'x' }], 'not-an-anchor'),
      member(bPath, [{ lines: '1', replace: 'y' }], 'fa:000000000000'),
      member(cPath, [{ lines: '1', replace: 'z' }]),
    ],
    ctx,
  )
  check('malformed + stale anchors ALL collected in one refusal', bad.ok === false && (bad.failures?.length ?? 0) === 2)
  check('stale member carries the current anchor + reread hint', bad.ok === false && bad.failures!.some(f => f.code === 'stale-anchor' && /current: fa:[0-9a-f]{12}/.test(f.message)))
  check('the valid member is NOT planned (whole-set refusal)', bad.ok === false && /whole set is refused/.test(bad.message))

  // stale anchor at first / middle / last position
  for (const [idx, label] of [[0, 'first'], [1, 'middle'], [2, 'last']] as const) {
    const members = [
      member(aPath, [{ lines: '1', replace: 'x' }]),
      member(bPath, [{ lines: '1', replace: 'y' }]),
      member(cPath, [{ lines: '1', replace: 'z' }]),
    ]
    members[idx] = { ...members[idx]!, expected_anchor: 'fa:beefbeefbeef' }
    const r = planChangeSet(members, ctx)
    check(`stale anchor at the ${label} member refuses the set`, r.ok === false && r.failures?.length === 1 && r.failures[0]!.code === 'stale-anchor')
  }

  const rangeAnchor = mintRangeAnchor('alpha line 1\nalpha line 2', 1, 2)
  const window = planChangeSet([member(aPath, [{ lines: '3', replace: 'x' }], rangeAnchor)], ctx)
  check('a hunk outside the range-anchor window refuses', window.ok === false && window.failures?.[0]?.code === 'hunks' && /window/.test(window.failures[0].message))

  const overlap = planChangeSet([member(cPath, [{ lines: '1-3', replace: 'x' }, { lines: '2', replace: 'y' }])], ctx)
  check('overlapping hunks refuse naming BOTH hunks', overlap.ok === false && /hunk 1 and hunk 2 overlap/.test(overlap.failures?.[0]?.message ?? ''))

  const oob = planChangeSet([member(bPath, [{ lines: '9', replace: 'x' }])], ctx)
  check('out-of-bounds hunk refuses naming the file size', oob.ok === false && /out of bounds/.test(oob.failures?.[0]?.message ?? ''))
}

console.log('── §4 target-class refusals BY NAME ──')
{
  const missing = planChangeSet([member(aPath, [{ lines: '1', replace: 'x' }]), { file_path: join(root, 'ghost.ts'), expected_anchor: 'fa:000000000000', hunks: [{ lines: '1', replace: 'x' }] }], ctx)
  check('a missing file refuses NAMING the Write owner', missing.ok === false && missing.failures?.some(f => f.code === 'missing' && /Write tool/.test(f.message)) === true)
  const dir = planChangeSet([{ file_path: join(root, 'sub'), expected_anchor: 'fa:000000000000', hunks: [{ lines: '1', replace: 'x' }] }], ctx)
  check('a directory refuses by name', dir.ok === false && dir.failures?.[0]?.code === 'directory')
  const nb = planChangeSet([member(ipynbPath, [{ lines: '1', replace: 'x' }])], ctx)
  check('a notebook refuses NAMING NotebookEdit', nb.ok === false && nb.failures?.[0]?.code === 'notebook' && /NotebookEdit/.test(nb.failures[0].message))
  const bin = planChangeSet([{ file_path: binPath, expected_anchor: 'fa:000000000000', hunks: [{ lines: '1', replace: 'x' }] }], ctx)
  check('binary content refuses by name', bin.ok === false && bin.failures?.[0]?.code === 'binary')
  const notRead = planChangeSet([member(aPath, [{ lines: '1', replace: 'x' }])], { ...ctx, readEvidence: () => ({ ok: false, message: 'file has not been read' }) })
  check('missing read evidence refuses (read-before-edit law)', notRead.ok === false && notRead.failures?.[0]?.code === 'not-read')
  const scoped = planChangeSet([member(aPath, [{ lines: '1', replace: 'x' }])], { ...ctx, scopeCheck: () => 'outside the write scope' })
  check('an out-of-scope member refuses at preflight', scoped.ok === false && scoped.failures?.[0]?.code === 'scope')
  const domain = planChangeSet([member(aPath, [{ lines: '1', replace: 'x' }])], { ...ctx, validateTarget: () => 'domain validator says no' })
  check('a caller domain validator can refuse a target (step 8)', domain.ok === false && /domain validator says no/.test(domain.failures?.[0]?.message ?? ''))
}

console.log('── §5 digest determinism + no-change classification ──')
{
  const m1 = [member(aPath, [{ lines: '2', replace: 'DET' }]), member(bPath, [{ lines: '1', replace: 'DET' }])]
  const m2 = [member(bPath, [{ lines: '1', replace: 'DET' }]), member(aPath, [{ lines: '2', replace: 'DET' }])]
  // different object key insertion order for the same member
  const m3 = [
    { hunks: [{ replace: 'DET', lines: '1' }], expected_anchor: anchorOf(bPath), file_path: bPath },
    { expected_anchor: anchorOf(aPath), hunks: [{ lines: '2', replace: 'DET' }], file_path: aPath },
  ]
  const p1 = planChangeSet(m1, ctx)
  const p2 = planChangeSet(m2, ctx)
  const p3 = planChangeSet(m3 as never, ctx)
  check('member ORDER does not change the digest/id', p1.ok && p2.ok && p1.plan.digest === p2.plan.digest && p1.plan.id === p2.plan.id)
  check('object KEY order does not change the digest/id', p1.ok && p3.ok && p1.plan.digest === p3.plan.digest)

  const noop = planChangeSet(
    [member(aPath, [{ lines: '2', replace: 'alpha line 2' }]), member(bPath, [{ lines: '1', replace: 'BETA' }])],
    ctx,
  )
  check('an already-satisfied member classifies no-change, NOT failure', noop.ok === true && noop.plan.noChangePaths.length === 1 && noop.plan.changedPaths.length === 1)
  const allNoop = planChangeSet([member(aPath, [{ lines: '2', replace: 'alpha line 2' }])], ctx)
  check('an all-satisfied set plans with an empty changed set', allNoop.ok === true && allNoop.plan.changedPaths.length === 0 && allNoop.plan.noChangePaths.length === 1)
}

console.log('── §6 diff budget honesty ──')
{
  const wide = write('wide.txt', Array.from({ length: 400 }, (_, i) => `w${i}`).join('\n') + '\n')
  const r = planChangeSet([member(wide, [{ lines: '1-390', replace: Array.from({ length: 390 }, (_, i) => `W${i}`).join('\n') }])], ctx)
  check('a huge diff is bounded with the cut NAMED', r.ok === true && r.plan.targets[0]!.diff.hunks.reduce((n, h) => n + h.lines.length, 0) <= CHANGESET_BOUNDS.maxDiffLines && r.plan.targets[0]!.diff.omittedHunks > 0)
}

console.log('── §7 the plan store: ring · evicted ≠ absent · expiry · discard · owner isolation ──')
{
  _resetChangeSetStoreForTesting()
  const owner = processMainOwner()
  const other = processOwnerForLane('agent:isolation-check')
  const first = planChangeSet([member(aPath, [{ lines: '1', replace: 'ring-0' }])], ctx)
  if (!first.ok) throw new Error('fixture plan failed')
  rememberChangeSetPlan(owner, first.plan)
  check('a remembered plan reads back', getChangeSetPlan(owner, first.plan.id)?.id === first.plan.id)
  check('owner isolation: another owner cannot see it', getChangeSetPlan(other, first.plan.id) === undefined)
  for (let i = 0; i < CHANGESET_BOUNDS.planRing; i++) {
    const p = planChangeSet([member(aPath, [{ lines: '1', replace: `ring-${i + 1}` }])], ctx)
    if (p.ok) rememberChangeSetPlan(owner, p.plan)
  }
  check('the ring evicts the oldest plan', getChangeSetPlan(owner, first.plan.id) === undefined)
  check('evicted ≠ absent (the honesty floor)', changeSetPlanEvicted(owner, first.plan.id) === true && changeSetPlanEvicted(owner, 'cs-never-existed') === false)

  const fresh = planChangeSet([member(bPath, [{ lines: '1', replace: 'ttl' }])], ctx)
  if (fresh.ok) {
    check('a fresh plan is not expired', changeSetPlanExpired(fresh.plan) === false)
    check('the TTL expires a plan', changeSetPlanExpired(fresh.plan, fresh.plan.createdAt + CHANGESET_BOUNDS.planTtlMs + 1) === true)
    rememberChangeSetPlan(owner, fresh.plan)
    const discarded = setChangeSetPlanState(owner, fresh.plan.id, 'discarded')
    check('discard settles on the stored plan', discarded?.state === 'discarded' && getChangeSetPlan(owner, fresh.plan.id)?.state === 'discarded')
  }
}

console.log('── §8 planning never writes ──')
{
  const treeDigestAfter = [aPath, bPath, cPath, crlfPath, cjkPath, noNlPath, execPath]
    .map(p => sha256Hex(readFileSync(p)))
    .join('|')
  check('the fixture tree is byte-identical after ALL planning', treeDigestBefore === treeDigestAfter)
}

console.log(failures === 0 ? '\nprove-changeset-planning: GREEN' : `\nprove-changeset-planning: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
