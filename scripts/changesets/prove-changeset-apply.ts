#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-ap-home-'))
process.env.MERCURY_BARE = '1'
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

console.log('── A6 the read evidence Edit accepts, through the real Read tool ──')
{
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const parent = { uuid: '00000000-0000-0000-0000-00000000ap06', message: { id: 'msg_fixture' } }
  const rows = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
  const readAnchor = async (ctx: Ctx, input: Record<string, unknown>): Promise<string | undefined> => {
    const r = await (FileReadTool as { call: Function }).call(input, ctx, null, parent)
    return (r.data as { file?: { anchor?: string } }).file?.anchor
  }
  const windowed = writeFixture('window.txt', rows)
  const wCtx = makeContext()
  const ra = await readAnchor(wCtx, { file_path: windowed, offset: 10, limit: 5 })
  check('a windowed Read mints a range anchor', typeof ra === 'string' && ra.startsWith('ra:'), String(ra))
  const r1 = await callTool({ op: 'apply', changes: [{ file_path: windowed, expected_anchor: ra, hunks: [{ lines: '12', replace: 'ROW 12' }] }] }, wCtx)
  check('a hunk inside the read window applies on the range anchor', r1.effect.outcome === 'succeeded' && readFileSync(windowed, 'utf8').split('\n')[11] === 'ROW 12', r1.data.result)

  const multi = writeFixture('multi.txt', rows)
  const mCtx = makeContext()
  const fullAnchor = await readAnchor(mCtx, { file_path: multi })
  await readAnchor(mCtx, { file_path: multi, ranges: ['3', '7'] })
  check('a ranges Read leaves a partial-view read state', (mCtx.readFileState.get(multi) as { isPartialView?: boolean } | undefined)?.isPartialView === true)
  const r2 = await callTool({ op: 'apply', changes: [{ file_path: multi, expected_anchor: fullAnchor, hunks: [{ lines: '7', replace: 'ROW 7' }] }] }, mCtx)
  check('the full-read anchor still carries the edit after a ranges re-read', r2.effect.outcome === 'succeeded' && readFileSync(multi, 'utf8').split('\n')[6] === 'ROW 7', r2.data.result)

  const dropped = writeFixture('dropped-state.txt', rows)
  const dCtx = makeContext()
  const droppedAnchor = await readAnchor(dCtx, { file_path: dropped })
  dCtx.readFileState.delete(dropped)
  const r3 = await callTool({ op: 'apply', changes: [{ file_path: dropped, expected_anchor: droppedAnchor, hunks: [{ lines: '2', replace: 'ROW 2' }] }] }, dCtx)
  check('a matching full-file anchor is read knowledge without a read-state entry', r3.effect.outcome === 'succeeded' && readFileSync(dropped, 'utf8').split('\n')[1] === 'ROW 2', r3.data.result)

  const unread = writeFixture('unread.txt', rows)
  const r4 = await callTool({ op: 'apply', changes: [{ file_path: unread, expected_anchor: 'fa:000000000000', hunks: [{ lines: '2', replace: 'ROW 2' }] }] }, makeContext())
  check("an unread file refuses in Edit's words, writing nothing", r4.effect.outcome === 'failed' && /\[not-read\] Read the file before editing it/.test(r4.data.result) && readFileSync(unread, 'utf8') === rows, r4.data.result)

  const outside = writeFixture('outside.txt', rows)
  const oCtx = makeContext()
  const outsideAnchor = await readAnchor(oCtx, { file_path: outside, offset: 10, limit: 5 })
  const r5 = await callTool({ op: 'apply', changes: [{ file_path: outside, expected_anchor: outsideAnchor, hunks: [{ lines: '25', replace: 'ROW 25' }] }] }, oCtx)
  check('a hunk outside every shown line refuses with the smallest Read', r5.effect.outcome === 'failed' && /\[not-read\]/.test(r5.data.result) && /Read\(offset: 25, limit: 1\)/.test(r5.data.result) && readFileSync(outside, 'utf8') === rows, r5.data.result)

  const long = 'prefix_' + 'x'.repeat(2986) + '_suffix'
  const clipped = writeFixture('clipped.txt', long + '\nshort\n')
  const cCtx = makeContext()
  const clippedAnchor = await readAnchor(cCtx, { file_path: clipped })
  const clippedMember = { file_path: clipped, expected_anchor: clippedAnchor, hunks: [{ lines: '1', replace: 'replacement' }] }
  const r6 = await callTool({ op: 'apply', changes: [clippedMember] }, cCtx)
  check('a hunk over a clipped line refuses naming the lossless read', r6.effect.outcome === 'failed' && r6.data.result.includes(`[not-read] Line 1 was clipped; Read(file_path: ${JSON.stringify(clipped)}, offset: 1, limit: 1, lossless: true)`) && readFileSync(clipped, 'utf8').startsWith(long), r6.data.result)
  await readAnchor(cCtx, { file_path: clipped, offset: 1, limit: 1, lossless: true })
  const r7 = await callTool({ op: 'apply', changes: [clippedMember] }, cCtx)
  check('the same set lands once the clipped line was read lossless', r7.effect.outcome === 'succeeded' && readFileSync(clipped, 'utf8') === 'replacement\nshort\n', r7.data.result)
}

console.log('── A7 a stale anchor relocates end to end, exactly as Edit does ──')
{
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const parent = { uuid: '00000000-0000-0000-0000-00000000ap07', message: { id: 'msg_fixture' } }
  const readAnchor = async (ctx: Ctx, path: string): Promise<string | undefined> => {
    const r = await (FileReadTool as { call: Function }).call({ file_path: path }, ctx, null, parent)
    return (r.data as { file?: { anchor?: string } }).file?.anchor
  }
  const block = ['function target() {', "  return 'before'", '}'].join('\n')
  const v1 = ['// head 1', '// head 2', '// head 3', '// head 4', '', block, '', '// tail'].join('\n') + '\n'
  const banner = ['// gen 1', '// gen 2', '// gen 3', '// gen 4', '// gen 5'].join('\n')
  const shifted = writeFixture('shift.ts', v1)
  const sCtx = makeContext()
  const staleAnchor = await readAnchor(sCtx, shifted)
  writeFileSync(shifted, banner + '\n' + v1)
  primeRead(sCtx, shifted)
  const r8 = await callTool({ op: 'apply', changes: [{ file_path: shifted, expected_anchor: staleAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] }] }, sCtx)
  check('a pure line shift lands at the moved position through the tool', r8.effect.outcome === 'succeeded' && readFileSync(shifted, 'utf8').split('\n')[11] === "  return 'after'" && readFileSync(shifted, 'utf8').startsWith(banner), r8.data.result)
  check('the result names the relocation with the line offset', /note: stale anchor recovered: lines 7 → 12/.test(r8.data.result), r8.data.result)
  const inside = writeFixture('inside.ts', v1)
  const iCtx = makeContext()
  const insideAnchor = await readAnchor(iCtx, inside)
  const rewritten = v1.replace("  return 'before'", "  return 'REWRITTEN by someone else'")
  writeFileSync(inside, rewritten)
  primeRead(iCtx, inside)
  const r9 = await callTool({ op: 'apply', changes: [{ file_path: inside, expected_anchor: insideAnchor, hunks: [{ lines: '7', replace: "  return 'after'" }] }] }, iCtx)
  check('a change inside the hunk window refuses stale-anchor, writing nothing', r9.effect.outcome === 'failed' && /\[stale-anchor\]/.test(r9.data.result) && readFileSync(inside, 'utf8') === rewritten, r9.data.result)
}

console.log('── A8 delete and move members through changes[] ──')
{
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const parent = { uuid: '00000000-0000-0000-0000-00000000ap08', message: { id: 'msg_fixture' } }
  const readAnchor = async (ctx: Ctx, path: string): Promise<string | undefined> => {
    const r = await (FileReadTool as { call: Function }).call({ file_path: path }, ctx, null, parent)
    return (r.data as { file?: { anchor?: string } }).file?.anchor
  }
  const doomed = writeFixture('to-delete.txt', 'bye\n')
  const source = writeFixture('to-move.txt', 'carried\n')
  const destination = join(fixtures, 'moved.txt')
  const ctx = makeContext()
  const doomedAnchor = await readAnchor(ctx, doomed)
  const sourceAnchor = await readAnchor(ctx, source)
  const r10 = await callTool(
    {
      op: 'apply',
      changes: [
        { file_path: doomed, expected_anchor: doomedAnchor, op: 'delete' },
        { file_path: source, expected_anchor: sourceAnchor, op: 'move', new_path: destination, hunks: [{ lines: '1', replace: 'CARRIED' }] },
      ],
    },
    ctx,
  )
  check('delete and move members apply in one set', r10.effect.outcome === 'succeeded' && !existsSync(doomed) && !existsSync(source) && readFileSync(destination, 'utf8') === 'CARRIED\n', r10.data.result)
  check('the moved file lands in the read state at its new path only', (ctx.readFileState.get(destination) as { content: string } | undefined)?.content === 'CARRIED\n' && ctx.readFileState.get(source) === undefined && ctx.readFileState.get(doomed) === undefined)
  const occupied = writeFixture('occupied.txt', 'x\n')
  const src = writeFixture('src.txt', 'y\n')
  const oCtx = makeContext()
  const srcAnchor = await readAnchor(oCtx, src)
  const r11 = await callTool({ op: 'apply', changes: [{ file_path: src, expected_anchor: srcAnchor, op: 'move', new_path: occupied }] }, oCtx)
  check('a move onto an existing path refuses the set, writing nothing', r11.effect.outcome === 'failed' && /destination/.test(r11.data.result) && readFileSync(src, 'utf8') === 'y\n' && readFileSync(occupied, 'utf8') === 'x\n', r11.data.result)
  const unreadDelete = writeFixture('unread-delete.txt', 'z\n')
  const r12 = await callTool({ op: 'apply', changes: [{ file_path: unreadDelete, expected_anchor: mintFileAnchor('other\n'), op: 'delete' }] }, makeContext())
  check('a delete of a file never read refuses, writing nothing', r12.effect.outcome === 'failed' && /\[not-read\]/.test(r12.data.result) && existsSync(unreadDelete), r12.data.result)
}

{
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const empty = writeFixture('empty-notes.txt', '')
  const other = writeFixture('registered.txt', 'before\n')
  const ctx = makeContext()
  const read = await FileReadTool.call({ file_path: empty } as never, ctx as never)
  const anchor = (read.data as { file?: { anchor?: string } }).file?.anchor
  const words = JSON.stringify(FileReadTool.mapToolResultToToolResultBlockParam(read.data as never, 'empty-read'))
  check('Read returns and displays the empty file full-file anchor', anchor === mintFileAnchor('') && words.includes(`anchor: ${anchor}`), words)
  primeRead(ctx, other)
  const result = await callTool({ op: 'apply', changes: [
    member(empty, [{ lines: '1', replace: 'notes', insert: 'before' }], anchor ?? ''),
    member(other, [{ lines: '1', replace: 'after' }]),
  ] }, ctx)
  check('an empty file and its registration join one atomic change set', result.effect.outcome === 'succeeded' && readFileSync(empty, 'utf8') === 'notes' && readFileSync(other, 'utf8') === 'after\n', result.data.result)
}

console.log("── A9 edits members through changes[]: Edit's exact-string lane in one atomic set ──")
{
  type Edit = { old_string: string; new_string: string; replace_all?: boolean }
  const editsMember = (p: string, edits: Edit[], anchor?: string) => ({ file_path: p, expected_anchor: anchor ?? mintFileAnchor(readFileSync(p, 'utf8')), edits })
  const e1 = writeFixture('edits-1.ts', 'const a = 1\nconst b = 2\n')
  const e2 = writeFixture('edits-2.ts', 'left\nright\n')
  const ctx = makeContext()
  primeRead(ctx, e1, e2)
  const pv = await callTool({ op: 'preview', changes: [editsMember(e1, [{ old_string: 'const b = 2', new_string: 'const b = 3' }]), member(e2, [{ lines: '1', replace: 'LEFT' }])] }, ctx)
  check('a preview counts an edits member the way it counts hunks', pv.data.outcome === 'no-change' && /2 file\(s\) to change, 2 hunk\(s\)\./.test(pv.data.result) && pv.data.result.includes('edits-1.ts'), pv.data.result)
  const landed = await callTool({ op: 'apply', plan_id: pv.data.planId }, ctx)
  check('the previewed edits member lands beside the hunks member', landed.effect.outcome === 'succeeded' && readFileSync(e1, 'utf8') === 'const a = 1\nconst b = 3\n' && readFileSync(e2, 'utf8') === 'LEFT\nright\n', landed.data.result)
  check('the apply result counts the edit and names the file with its fresh anchor', /2 file\(s\), 2 hunk\(s\), verified by reread:/.test(landed.data.result) && new RegExp(`edits-1\\.ts \\(anchor: ${mintFileAnchor('const a = 1\nconst b = 3\n')}\\)`).test(landed.data.result), landed.data.result)
  check('read-state is refreshed for the edits member', (ctx.readFileState.get(e1) as { content: string } | undefined)?.content === 'const a = 1\nconst b = 3\n')

  const f1 = writeFixture('fast-1.ts', 'one TODO\ntwo TODO\n')
  const f2 = writeFixture('fast-2.ts', 'TODO\n')
  const f3 = writeFixture('fast-3.ts', 'a TODO b TODO\n')
  const fCtx = makeContext()
  primeRead(fCtx, f1, f2, f3)
  const everywhere = await callTool({ op: 'apply', changes: [f1, f2, f3].map(p => editsMember(p, [{ old_string: 'TODO', new_string: 'DONE', replace_all: true }])) }, fCtx)
  check('replace_all across three files lands every occurrence in one set', everywhere.effect.outcome === 'succeeded' && readFileSync(f1, 'utf8') === 'one DONE\ntwo DONE\n' && readFileSync(f2, 'utf8') === 'DONE\n' && readFileSync(f3, 'utf8') === 'a DONE b DONE\n', everywhere.data.result)
  check('the result counts every changed line region (2 + 1 + 1)', /3 file\(s\), 4 hunk\(s\)/.test(everywhere.data.result) && everywhere.effect.changedPaths.length === 3, everywhere.data.result)

  const both = await callTool({ op: 'apply', changes: [{ ...editsMember(f2, [{ old_string: 'DONE', new_string: 'x' }]), hunks: [{ lines: '1', replace: 'y' }] }] }, fCtx)
  check('a member carrying hunks and edits refuses by name, writing nothing', both.effect.outcome === 'failed' && /^ChangeSet refused \(schema\)/.test(both.data.result) && /hunks and edits/.test(both.data.result) && /Nothing was written\./.test(both.data.result) && readFileSync(f2, 'utf8') === 'DONE\n', both.data.result)

  const nu = writeFixture('not-unique.ts', 'beta one\nbeta two\n')
  const nCtx = makeContext()
  primeRead(nCtx, nu, f2)
  const notUnique = await callTool({ op: 'apply', changes: [editsMember(nu, [{ old_string: 'beta', new_string: 'BETA' }]), editsMember(f2, [{ old_string: 'DONE', new_string: 'done' }])] }, nCtx)
  check("a non-unique old_string refuses the whole set in Edit's words with the line numbers", notUnique.effect.outcome === 'failed' && /\[edits\] edit 1: Found 2 matches of the string to replace, but replace_all is false, so nothing was written\. The matches are at lines 1, 2; Read\(offset: 1, limit: 2\) shows the first with its neighbours\./.test(notUnique.data.result) && readFileSync(nu, 'utf8') === 'beta one\nbeta two\n' && readFileSync(f2, 'utf8') === 'DONE\n', notUnique.data.result)
  const nuMtime = statSync(nu).mtimeMs
  const satisfied = await callTool({ op: 'apply', changes: [editsMember(nu, [{ old_string: 'beta one ', new_string: 'beta one' }])] }, nCtx)
  check('an all-satisfied edits set reports no change and writes nothing', satisfied.effect.outcome === 'no-change' && /^No changes needed — every member of plan cs-[0-9a-f]{12} is already satisfied/.test(satisfied.data.result) && statSync(nu).mtimeMs === nuMtime, satisfied.data.result)
  const missing = await callTool({ op: 'apply', changes: [editsMember(nu, [{ old_string: 'beta twoo', new_string: 'x' }])] }, nCtx)
  check("an old_string the file lacks refuses in Edit's words and names the closest lines read", missing.effect.outcome === 'failed' && /\[edits\] edit 1: The old_string was not found in the file\./.test(missing.data.result) && /The lines read this session closest to old_string, numbered with their anchor:/.test(missing.data.result) && /2\tbeta two/.test(missing.data.result), missing.data.result)
  const unread = writeFixture('unread-edits.ts', 'beta one\nbeta two\n')
  const unreadRefusal = await callTool({ op: 'apply', changes: [editsMember(unread, [{ old_string: 'beta', new_string: 'x' }], 'fa:000000000000')] }, makeContext())
  check('an unread file refuses before any match line is named', unreadRefusal.effect.outcome === 'failed' && /\[not-read\] Read the file before editing it/.test(unreadRefusal.data.result) && !/Found 2 matches/.test(unreadRefusal.data.result) && readFileSync(unread, 'utf8') === 'beta one\nbeta two\n', unreadRefusal.data.result)

  const prose = writeFixture('prose.md', 'She said “hello” to him.\n')
  const pCtx = makeContext()
  primeRead(pCtx, prose)
  const styled = await callTool({ op: 'apply', changes: [editsMember(prose, [{ old_string: 'said "hello"', new_string: 'said "hello" and "bye"' }])] }, pCtx)
  check("new quotes take the prose file's curly style through the tool", styled.effect.outcome === 'succeeded' && readFileSync(prose, 'utf8') === 'She said “hello” and “bye” to him.\n', styled.data.result)

  const description = await (ChangeSetTool as { prompt: (input: { tools: unknown[]; model: string }) => Promise<string> }).prompt({ tools: [], model: '' })
  check('the tool description says a member carries hunks or edits', description.includes('edits: [{ old_string, new_string, replace_all? }]') && description.includes('a member carries hunks or edits, not both'), description)
  const shape = (ChangeSetTool.inputSchema as unknown as { shape: { changes: { unwrap: () => { element: { shape: Record<string, unknown> } } } } }).shape.changes.unwrap().element.shape
  check('the schema carries edits beside hunks on a member', 'edits' in shape && 'hunks' in shape, Object.keys(shape).join(','))
}

console.log(failures === 0 ? '\nprove-changeset-apply: GREEN' : `\nprove-changeset-apply: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
