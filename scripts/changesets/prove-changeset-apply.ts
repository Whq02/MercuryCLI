#!/usr/bin/env bun
// ============================================================================
//  scripts/changesets/prove-changeset-apply.ts — the apply laws through
//  the PRODUCTION ChangeSet tool + the shared commit core:
//    · every planned file lands EXACTLY once (byte-exact, reread-verified);
//    · changedPaths excludes already-satisfied members;
//    · ONE effect → ONE ChangeReceipt → ONE canonical transaction with
//      path@version pairs (the typed intent projection);
//    · read-state coverage for every changed path;
//    · encoding/EOL/final-newline/mode preservation (CRLF · UTF-8
//      multibyte · no-final-newline · executable);
//    · repeated apply REPLAYS without a second write (tool plan_id path +
//      core idempotency path);
//    · concurrent overlapping commits serialize without deadlock (second
//      writer reads honest stale); disjoint commits stay independent;
//    · exactly one committed journal op per executed set.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-ap-home-'))
process.env.MERCURY_SIMPLE = '1'
const csHome = mkdtempSync(join(tmpdir(), 'fulcrum-ap-cs-'))
process.env.MERCURY_CHANGESET_DIR = csHome

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — apply proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
const { sha256Hex, plannedDiskBytes } = await import(
  '../../src/services/changeTransaction/changeSetPlan.ts'
)
const { runTextChangeSetCommit, commitPlanDigest } = await import(
  '../../src/services/changeTransaction/changeSetCommit.ts'
)
const { listJournalOperations } = await import('../../src/substrate/operationJournal.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { receiptsFor, _resetChangeReceiptsForTesting } = await import(
  '../../src/services/changeTransaction/receipts.ts'
)
const { transactionsFor, _resetTransactionPlaneForTesting } = await import(
  '../../src/services/primitives/transactionPlane.ts'
)
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'fulcrum-ap-fix-')))
function writeFixture(name: string, content: string | Buffer, mode?: number): string {
  const p = join(fixtures, name)
  writeFileSync(p, content)
  if (mode !== undefined) chmodSync(p, mode)
  return p
}

const owner = processMainOwner()
function makeContext() {
  const readFileState = new Map<string, unknown>()
  const empty = getEmptyToolPermissionContext()
  const permCtx = {
    ...empty,
    additionalWorkingDirectories: new Map([[fixtures, { source: 'session' }]]),
  }
  return {
    owner,
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permCtx }),
  } as never as { readFileState: Map<string, { content: string; timestamp: number }> }
}
type Ctx = ReturnType<typeof makeContext>
function primeRead(ctx: Ctx, ...paths: string[]): void {
  for (const p of paths) {
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8').replaceAll('\r\n', '\n'),
      timestamp: Date.now() + 60_000,
    } as never)
  }
}
async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-00000000ap01',
    message: { id: 'msg_fixture' },
  })
  return result as {
    data: { op: string; result: string; outcome: string; planId?: string }
    effect: {
      outcome: string
      operation: string
      changedPaths: string[]
      details?: Record<string, unknown>
      startedAt: number
      completedAt: number
      evidence: string
    }
    changeIntent?: { targetPaths: string[]; targetVersions?: { path: string; version: string }[] }
  }
}
const member = (p: string, hunks: object[], anchor?: string) => ({
  file_path: p,
  expected_anchor: anchor ?? mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n')),
  hunks,
})

console.log('── A1 a three-file apply lands exactly + ONE effect/receipt/transaction ──')
{
  _resetChangeReceiptsForTesting()
  _resetTransactionPlaneForTesting()
  const x = writeFixture('x.ts', 'x1\nx2\nx3\n')
  const y = writeFixture('y.ts', 'y1\ny2\n')
  const z = writeFixture('z.ts', 'z1\n')
  const ctx = makeContext()
  primeRead(ctx, x, y, z)
  const r = await callTool(
    {
      op: 'apply',
      changes: [
        member(x, [{ lines: '2', replace: 'X2' }, { lines: '3', replace: 'x4-inserted', insert: 'after' as never }]),
        member(y, [{ lines: '1-2', replace: 'Y-merged' }]),
        member(z, [{ lines: '1', replace: 'Z1' }]),
      ],
    },
    ctx,
  )
  check('outcome succeeded', r.effect.outcome === 'succeeded', r.data.result)
  check('every planned file landed exactly', readFileSync(x, 'utf8') === 'x1\nX2\nx3\nx4-inserted\n' && readFileSync(y, 'utf8') === 'Y-merged\n' && readFileSync(z, 'utf8') === 'Z1\n')
  check('changedPaths is the exact written set', r.effect.changedPaths.length === 3 && r.effect.changedPaths.every(p => [x, y, z].includes(p)))
  check('read-state refreshed for EVERY changed path', [x, y, z].every(p => (ctx.readFileState.get(p) as { content: string } | undefined)?.content === readFileSync(p, 'utf8')))
  check('the typed intent projection carries path@version pairs', (r.changeIntent?.targetVersions?.length ?? 0) === 3 && r.changeIntent!.targetVersions!.every(v => /^(fa|ra):/.test(v.version)))

  // Feed the SAME exactly-once seam production uses.
  observeToolTerminal({
    owner,
    toolName: 'ChangeSet',
    toolUseId: 'tu-a1',
    input: { op: 'apply' },
    ok: true,
    durationMs: 5,
    effect: r.effect as never,
    intentProjection: r.changeIntent as never,
    cwd: fixtures,
  })
  const receipts = receiptsFor(owner)
  check('exactly ONE ChangeReceipt minted', receipts.length === 1)
  check('the receipt intent prefers the typed projection (3 targets)', receipts[0]?.intent.targetPaths.length === 3 && (receipts[0]?.intent.targetVersions?.length ?? 0) === 3)
  const txns = transactionsFor(owner)
  check('exactly ONE canonical transaction, settled', txns.length === 1 && txns[0]?.state === 'settled')
  check('the transaction carries ALL path@version expected versions', (txns[0]?.expectedVersions.length ?? 0) === 3 && txns[0]!.expectedVersions.every(v => /@(fa|ra):/.test(v)))
  check('the transaction result refs carry every changed path', (txns[0]?.resultRefs.length ?? 0) === 3)

  const ops = (await listJournalOperations(join(csHome, 'journal'))).filter(o => o.state === 'committed')
  check('exactly one committed journal op for the set', ops.length === 1)

  const dead = r.effect.details
  check('details carry plan id + counts + operation id', typeof dead?.planId === 'string' && dead?.files === 3 && typeof dead?.operationId === 'string')
}

console.log('── A2 changedPaths excludes already-satisfied members ──')
{
  const m = writeFixture('m.ts', 'm1\nm2\n')
  const n = writeFixture('n.ts', 'n1\n')
  const ctx = makeContext()
  primeRead(ctx, m, n)
  const r = await callTool(
    { op: 'apply', changes: [member(m, [{ lines: '1', replace: 'M1' }]), member(n, [{ lines: '1', replace: 'n1' }])] },
    ctx,
  )
  check('mixed set succeeds', r.effect.outcome === 'succeeded')
  check('changedPaths excludes the satisfied member', r.effect.changedPaths.length === 1 && r.effect.changedPaths[0] === m)
  check('noChangePaths NAMES the satisfied member', Array.isArray(r.effect.details?.noChangePaths) && (r.effect.details!.noChangePaths as string[])[0] === n)
  check('the satisfied member was not rewritten', readFileSync(n, 'utf8') === 'n1\n')
}

console.log('── A3 encoding/EOL/final-newline/mode preservation ──')
{
  const crlf = writeFixture('pres-crlf.txt', 'one\r\ntwo\r\nthree\r\n')
  const cjk = writeFixture('pres-cjk.txt', '第一\nsecond\n')
  const nonl = writeFixture('pres-nonl.txt', 'p\nq')
  const exec = writeFixture('pres-run.sh', '#!/bin/sh\necho a\n', 0o755)
  const ctx = makeContext()
  primeRead(ctx, crlf, cjk, nonl, exec)
  const r = await callTool(
    {
      op: 'apply',
      changes: [
        member(crlf, [{ lines: '2', replace: 'TWO' }]),
        member(cjk, [{ lines: '2', replace: '第二' }]),
        member(nonl, [{ lines: '2', replace: 'Q' }]),
        member(exec, [{ lines: '2', replace: 'echo b' }]),
      ],
    },
    ctx,
  )
  check('the preservation set applies', r.effect.outcome === 'succeeded', r.data.result)
  check('CRLF preserved on disk', readFileSync(crlf, 'utf8') === 'one\r\nTWO\r\nthree\r\n')
  check('multibyte lands exactly', readFileSync(cjk, 'utf8') === '第一\n第二\n')
  check('missing final newline preserved', readFileSync(nonl, 'utf8') === 'p\nQ')
  check('executable mode preserved', (statSync(exec).mode & 0o111) !== 0)
}

console.log('── A4 repeated apply replays without a second write ──')
{
  const f = writeFixture('replay.ts', 'r1\nr2\n')
  const ctx = makeContext()
  primeRead(ctx, f)
  const pv = await callTool({ op: 'preview', changes: [member(f, [{ lines: '1', replace: 'R1' }])] }, ctx)
  const first = await callTool({ op: 'apply', plan_id: pv.data.planId }, ctx)
  check('the previewed plan applies', first.effect.outcome === 'succeeded' && readFileSync(f, 'utf8') === 'R1\nr2\n')
  const mtime = statSync(f).mtimeMs
  const again = await callTool({ op: 'apply', plan_id: pv.data.planId }, ctx)
  check('a second apply of the committed plan REPLAYS (no-change effect)', again.effect.outcome === 'no-change' && /replayed/i.test(again.data.result))
  check('the replay wrote nothing (mtime + bytes stable)', statSync(f).mtimeMs === mtime && readFileSync(f, 'utf8') === 'R1\nr2\n')
  check('the replay names the prior changed paths', Array.isArray(again.effect.details?.priorChangedPaths) && (again.effect.details!.priorChangedPaths as string[])[0] === f)

  // The core idempotency path: the SAME planDigest re-committed replays.
  const g = writeFixture('replay-core.ts', 'g1\n')
  const original = readFileSync(g)
  const planned = plannedDiskBytes('G1\n', 'utf8', 'LF')
  const target = {
    canonicalPath: g,
    originalDigest: sha256Hex(original),
    plannedDigest: sha256Hex(planned),
    originalBytes: original,
    plannedBytes: planned,
    mode: 0o644,
  }
  const digest = commitPlanDigest([target])
  const c1 = await runTextChangeSetCommit({ ownerKey: 'core-replay', source: 'changeset', planDigest: digest, targets: [target] })
  const c2 = await runTextChangeSetCommit({ ownerKey: 'core-replay', source: 'changeset', planDigest: digest, targets: [target] })
  check('core: first commit lands', c1.kind === 'committed' && readFileSync(g, 'utf8') === 'G1\n')
  check('core: second commit REPLAYS without writing', c2.kind === 'replayed' && readFileSync(g, 'utf8') === 'G1\n')
  const c3 = await runTextChangeSetCommit({ ownerKey: 'other-owner', source: 'changeset', planDigest: digest, targets: [target] })
  check('core: a DIFFERENT owner does not replay (isolation) — honest stale instead', c3.kind === 'stale')
}

console.log('── A5 concurrency: overlapping serializes, disjoint independent ──')
{
  const shared = writeFixture('conc-shared.ts', 's1\ns2\n')
  const solo1 = writeFixture('conc-solo1.ts', 'k1\n')
  const solo2 = writeFixture('conc-solo2.ts', 'l1\n')
  const mk = (p: string, from: string, to: string) => {
    const original = readFileSync(p)
    const planned = plannedDiskBytes(readFileSync(p, 'utf8').replace(from, to), 'utf8', 'LF')
    return {
      canonicalPath: p,
      originalDigest: sha256Hex(original),
      plannedDigest: sha256Hex(planned),
      originalBytes: original,
      plannedBytes: planned,
      mode: 0o644,
    }
  }
  const tA = mk(shared, 's1', 'S1-A')
  const tB = mk(shared, 's1', 'S1-B')
  const [ra, rb] = await Promise.all([
    runTextChangeSetCommit({ ownerKey: 'conc-a', source: 'changeset', planDigest: commitPlanDigest([tA]), targets: [tA] }),
    runTextChangeSetCommit({ ownerKey: 'conc-b', source: 'changeset', planDigest: commitPlanDigest([tB]), targets: [tB] }),
  ])
  const kinds = [ra.kind, rb.kind].sort()
  check('overlapping commits: one lands, one reads honest stale (no deadlock)', kinds[0] === 'committed' && kinds[1] === 'stale')
  const sharedNow = readFileSync(shared, 'utf8')
  check('the shared file holds exactly one writer’s planned output', sharedNow === 'S1-A\ns2\n' || sharedNow === 'S1-B\ns2\n')

  const t1 = mk(solo1, 'k1', 'K1')
  const t2 = mk(solo2, 'l1', 'L1')
  const [r1, r2] = await Promise.all([
    runTextChangeSetCommit({ ownerKey: 'conc-1', source: 'changeset', planDigest: commitPlanDigest([t1]), targets: [t1] }),
    runTextChangeSetCommit({ ownerKey: 'conc-2', source: 'changeset', planDigest: commitPlanDigest([t2]), targets: [t2] }),
  ])
  check('disjoint commits both land independently', r1.kind === 'committed' && r2.kind === 'committed' && readFileSync(solo1, 'utf8') === 'K1\n' && readFileSync(solo2, 'utf8') === 'L1\n')
}

console.log(failures === 0 ? '\nprove-changeset-apply: GREEN' : `\nprove-changeset-apply: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
