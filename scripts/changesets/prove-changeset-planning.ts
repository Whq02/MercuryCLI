#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const { rememberAnchoredSnapshot, _resetSnapshotRingForTesting } = await import(
  '../../src/services/changeTransaction/snapshotRing.ts'
)
const { LOSSY_DECODE_MESSAGE } = await import('../../src/utils/fileRead.ts')

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

  const gone = write('gone.txt', 'bye\n')
  const from = write('from.txt', 'carried\n')
  const shapes = planChangeSet(
    [
      { file_path: gone, expected_anchor: anchorOf(gone), op: 'delete' as const },
      { file_path: from, expected_anchor: anchorOf(from), hunks: [], op: 'move' as const, new_path: join(root, 'to.txt') },
      member(aPath, [{ lines: '1', replace: 'alpha one' }]),
    ],
    ctx,
  )
  check('delete and move members plan beside an edit in one set', shapes.ok === true, shapes.ok ? '' : (shapes as { message: string }).message)
  if (shapes.ok) {
    const realRoot = realpathSync(root)
    const del = shapes.plan.targets.find(t => t.canonicalPath === join(realRoot, 'gone.txt'))
    const mv = shapes.plan.targets.find(t => t.canonicalPath === join(realRoot, 'from.txt'))
    check('a delete member needs no hunks and plans empty content', del?.fileOp === 'delete' && del.plannedContent === '' && del.changed === true)
    check('a move member carries its destination and unchanged content', mv?.fileOp === 'move' && mv.newPath === join(realRoot, 'to.txt') && mv.plannedContent === 'carried\n' && mv.changed === true)
    check('changedPaths names source and destination', shapes.plan.changedPaths.includes(join(realRoot, 'from.txt')) && shapes.plan.changedPaths.includes(join(realRoot, 'to.txt')))
  }
  const taken = planChangeSet([{ file_path: from, expected_anchor: anchorOf(from), op: 'move' as const, new_path: bPath }], ctx)
  check('a move onto an existing path refuses by name', taken.ok === false && taken.code === 'destination')
  const deleteWithHunks = planChangeSet([{ file_path: gone, expected_anchor: anchorOf(gone), op: 'delete' as const, hunks: [{ lines: '1', replace: 'x' }] }], ctx)
  check('a delete member carrying hunks refuses as a schema error', deleteWithHunks.ok === false && deleteWithHunks.code === 'schema')
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

console.log('── §3b a stale anchor relocates through the ring exactly as Edit does ──')
{
  const block = ['function target() {', "  return 'before'", '}'].join('\n')
  const v1 = ['// head 1', '// head 2', '// head 3', '// head 4', '', block, '', '// tail'].join('\n') + '\n'
  const banner = ['// gen 1', '// gen 2', '// gen 3', '// gen 4', '// gen 5'].join('\n')
  const shifted = write('shift.ts', v1)
  const staleAnchor = mintFileAnchor(v1)
  rememberAnchoredSnapshot(ctx.ownerKey as never, staleAnchor, v1, shifted)
  writeFileSync(shifted, banner + '\n' + v1)
  const moved = planChangeSet(
    [member(shifted, [{ lines: '7', replace: "  return 'after'" }], staleAnchor), member(bPath, [{ lines: '1', replace: 'BETA' }])],
    ctx,
  )
  check('a pure line shift plans with the stale anchor', moved.ok === true, moved.ok ? '' : (moved as { message: string }).message)
  if (moved.ok) {
    const t = moved.plan.targets.find(x => x.canonicalPath === realpathSync(shifted))
    check('the hunk landed at the MOVED position (line 12)', t?.hunkSpans[0]?.start === 12 && t.plannedContent.split('\n')[11] === "  return 'after'")
    check('the target names the relocation with the line offset', /stale anchor recovered: lines 7 → 12/.test(t?.staleRecovery ?? ''), t?.staleRecovery ?? '')
    check('the target carries the fresh anchor of the content it edits', t?.expectedAnchor === mintFileAnchor(banner + '\n' + v1))
    check('the untouched member rides the same plan', moved.plan.changedPaths.length === 2)
  }
  const inside = write('inside.ts', v1)
  rememberAnchoredSnapshot(ctx.ownerKey as never, staleAnchor, v1, inside)
  writeFileSync(inside, v1.replace("  return 'before'", "  return 'REWRITTEN by someone else'"))
  const changed = planChangeSet([member(inside, [{ lines: '7', replace: "  return 'after'" }], staleAnchor)], ctx)
  check('a change INSIDE the hunk window refuses stale-anchor', changed.ok === false && changed.failures?.[0]?.code === 'stale-anchor')
  const twice = write('twice.ts', v1)
  rememberAnchoredSnapshot(ctx.ownerKey as never, staleAnchor, v1, twice)
  writeFileSync(twice, '// banner\n' + v1 + '\n' + v1)
  const ambiguous = planChangeSet([member(twice, [{ lines: '7', replace: "  return 'after'" }], staleAnchor)], ctx)
  check('two matching positions refuse rather than guess', ambiguous.ok === false && ambiguous.failures?.[0]?.code === 'stale-anchor')
  _resetSnapshotRingForTesting()
  const miss = write('ringmiss.ts', '// pad\n' + v1)
  const ringMiss = planChangeSet([member(miss, [{ lines: '7', replace: 'x' }], staleAnchor)], ctx)
  check('a ring miss refuses with the stale-anchor message', ringMiss.ok === false && ringMiss.failures?.[0]?.code === 'stale-anchor' && /current: fa:/.test(ringMiss.failures[0].message))
  rememberAnchoredSnapshot(ctx.ownerKey as never, staleAnchor, v1, miss)
  process.env.MERCURY_EDIT_STALE_RECOVERY = '0'
  const offArm = planChangeSet([member(miss, [{ lines: '7', replace: 'x' }], staleAnchor)], ctx)
  delete process.env.MERCURY_EDIT_STALE_RECOVERY
  check('MERCURY_EDIT_STALE_RECOVERY=0 refuses the recoverable case', offArm.ok === false && offArm.failures?.[0]?.code === 'stale-anchor')
  const onArm = planChangeSet([member(miss, [{ lines: '7', replace: 'x' }], staleAnchor)], ctx)
  check('the same input relocates once the flag is back on', onArm.ok === true && onArm.plan.targets[0]!.hunkSpans[0]?.start === 8)
  const deleteStale = planChangeSet([{ file_path: miss, expected_anchor: staleAnchor, op: 'delete' as const }], ctx)
  check('a stale whole-file op (delete) never relocates', deleteStale.ok === false && deleteStale.failures?.[0]?.code === 'stale-anchor')
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
  const cp1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x97, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a, 0x6f, 0x6b, 0x0a])
  const ansiPath = join(root, 'ansi.txt')
  writeFileSync(ansiPath, cp1252)
  const lossy = planChangeSet([{ file_path: ansiPath, expected_anchor: mintFileAnchor(cp1252.toString('utf8')), hunks: [{ lines: '2', replace: 'OK' }] }], ctx)
  check('a lossy decode (cp1252) refuses with the Edit words, never rewriting the bytes', lossy.ok === false && lossy.failures?.[0]?.code === 'encoding' && lossy.failures[0].message === LOSSY_DECODE_MESSAGE && readFileSync(ansiPath).equals(cp1252))
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
  check('the bounded diff still carries the exact line counts of the whole change (+390 −390), never the cut\'s', r.ok === true && r.plan.targets[0]!.diff.added === 390 && r.plan.targets[0]!.diff.removed === 390, r.ok ? `added=${r.plan.targets[0]!.diff.added} removed=${r.plan.targets[0]!.diff.removed}` : 'plan refused')
  const small = planChangeSet([member(aPath, [{ lines: '1', replace: 'alpha one\nalpha one-b' }])], ctx)
  check('a small change counts its lines exactly too (+2 −1)', small.ok === true && small.plan.targets[0]!.diff.added === 2 && small.plan.targets[0]!.diff.removed === 1 && small.plan.targets[0]!.diff.omittedHunks === 0, small.ok ? `added=${small.plan.targets[0]!.diff.added} removed=${small.plan.targets[0]!.diff.removed}` : 'plan refused')
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
