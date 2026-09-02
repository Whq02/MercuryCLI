#!/usr/bin/env bun
// ============================================================================
//  scripts/changesets/prove-changeset-zero-write.ts — the zero-write
//  laws, proved against the PRODUCTION ChangeSet tool with real fixtures:
//    · preview NEVER writes (tree byte-identical, no journal op, no temps);
//    · one invalid member (stale anchor at any position) ⇒ NO member written;
//    · one denied / out-of-scope member ⇒ NO member written;
//    · drift in the first/middle/last target of a previewed plan ⇒ NO
//      member written, current anchors + reread instructions returned;
//    · cancellation before commit ⇒ NO member written;
//    · an all-no-change apply produces ONE truthful no-change effect —
//      empty changedPaths, noChangePaths named, zero filesystem writes,
//      zero journal activity;
//    · no refusal path leaves staged temps behind.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-zw-home-'))
process.env.MERCURY_SIMPLE = '1'
const csHome = mkdtempSync(join(tmpdir(), 'fulcrum-zw-cs-'))
process.env.MERCURY_CHANGESET_DIR = csHome

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — zero-write proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)
const { sha256Hex } = await import('../../src/services/changeTransaction/changeSetPlan.ts')
const { listJournalOperations } = await import('../../src/substrate/operationJournal.ts')
const { isDurableTempName } = await import('../../src/substrate/durablePublish.ts')

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'fulcrum-zw-fix-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fulcrum-zw-outside-')))

function writeFixture(name: string, content: string): string {
  const p = join(fixtures, name)
  writeFileSync(p, content)
  return p
}
const A = 'a1\na2\na3\n'
const B = 'b1\nb2\n'
const C = 'c1\nc2\nc3\n'
const aPath = writeFixture('a.ts', A)
const bPath = writeFixture('b.ts', B)
const cPath = writeFixture('c.ts', C)
const outsidePath = join(outside, 'o.ts')
writeFileSync(outsidePath, 'o1\n')

function makeContext(opts: { deny?: string[]; aborted?: boolean } = {}) {
  const readFileState = new Map<string, unknown>()
  const empty = getEmptyToolPermissionContext()
  const permCtx = {
    ...empty,
    additionalWorkingDirectories: new Map([[fixtures, { source: 'session' }]]),
    ...(opts.deny ? { alwaysDenyRules: { session: opts.deny } } : {}),
  }
  const abortController = new AbortController()
  if (opts.aborted) abortController.abort()
  return {
    owner: 'fulcrum-zw-owner',
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController,
    getAppState: () => ({ toolPermissionContext: permCtx }),
  } as never as {
    readFileState: Map<string, unknown>
  }
}
type Ctx = ReturnType<typeof makeContext>

function primeRead(ctx: Ctx, ...paths: string[]): void {
  for (const p of paths) {
    ctx.readFileState.set(p, {
      content: readFileSync(p, 'utf8').replaceAll('\r\n', '\n'),
      timestamp: Date.now() + 60_000,
      offset: undefined,
      limit: undefined,
    })
  }
}

async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-00000000fu1c',
    message: { id: 'msg_fixture' },
  })
  return result as {
    data: { op: string; result: string; outcome: string; planId?: string }
    effect: { outcome: string; operation: string; changedPaths: string[]; details?: Record<string, unknown> }
  }
}

const member = (p: string, hunks: object[], anchor?: string) => ({
  file_path: p,
  expected_anchor: anchor ?? mintFileAnchor(readFileSync(p, 'utf8').replaceAll('\r\n', '\n')),
  hunks,
})

function treeDigest(): string {
  return [aPath, bPath, cPath, outsidePath].map(p => sha256Hex(readFileSync(p))).join('|')
}
async function journalOps() {
  return listJournalOperations(join(csHome, 'journal'))
}
function strayTemps(): string[] {
  return readdirSync(fixtures).filter(isDurableTempName)
}

console.log('── Z1 preview never writes ──')
{
  const ctx = makeContext()
  primeRead(ctx, aPath, bPath)
  const before = treeDigest()
  const r = await callTool(
    { op: 'preview', changes: [member(aPath, [{ lines: '1', replace: 'A1' }]), member(bPath, [{ lines: '2', replace: 'B2' }])] },
    ctx,
  )
  check('preview returns a prepared plan', r.data.outcome === 'no-change' && /^cs-/.test(r.data.planId ?? ''))
  check('preview effect is changeset.preview (no receipt vocabulary)', r.effect.operation === 'changeset.preview' && r.effect.changedPaths.length === 0)
  check('tree byte-identical after preview', treeDigest() === before)
  check('no journal operation from a preview', (await journalOps()).length === 0)
  check('no staged temps from a preview', strayTemps().length === 0)
}

console.log('── Z2 one invalid member ⇒ NO member written (fast apply path) ──')
{
  const ctx = makeContext()
  primeRead(ctx, aPath, bPath, cPath)
  const before = treeDigest()
  const r = await callTool(
    {
      op: 'apply',
      changes: [
        member(aPath, [{ lines: '1', replace: 'A1-new' }]),
        member(bPath, [{ lines: '1', replace: 'B1-new' }], 'fa:deaddeadbeef'),
        member(cPath, [{ lines: '1', replace: 'C1-new' }]),
      ],
    },
    ctx,
  )
  check('the whole set refuses (failed effect)', r.effect.outcome === 'failed')
  check('the refusal names the stale member + reread', /stale/i.test(r.data.result) && /Nothing was written/.test(r.data.result))
  check('NO member was written — tree byte-identical', treeDigest() === before)
  check('no journal operation minted', (await journalOps()).length === 0)
}

console.log('── Z3 one out-of-scope member ⇒ NO member written ──')
{
  const ctx = makeContext()
  primeRead(ctx, aPath, outsidePath)
  const before = treeDigest()
  const r = await callTool(
    { op: 'apply', changes: [member(aPath, [{ lines: '1', replace: 'A1-scope' }]), member(outsidePath, [{ lines: '1', replace: 'O1-scope' }])] },
    ctx,
  )
  check('the set refuses with the scope law named', r.effect.outcome === 'failed' && /scope/.test(r.data.result))
  check('NO member written (including the in-scope one)', treeDigest() === before)
}

console.log('── Z4 one deny-rule member ⇒ NO member written ──')
{
  // deny rules use the absolute-pattern spelling: Edit(//abs/path)
  const ctx = makeContext({ deny: [`Edit(/${bPath})`] })
  primeRead(ctx, aPath, bPath)
  const before = treeDigest()
  const r = await callTool(
    { op: 'apply', changes: [member(aPath, [{ lines: '1', replace: 'A1-deny' }]), member(bPath, [{ lines: '1', replace: 'B1-deny' }])] },
    ctx,
  )
  check('a denied path refuses the WHOLE set', r.effect.outcome === 'failed' && /den/i.test(r.data.result))
  check('NO member written under a deny rule', treeDigest() === before)
}

console.log('── Z5 drift at first/middle/last of a previewed plan ⇒ zero writes ──')
for (const [idx, label, drift] of [
  [0, 'first', aPath],
  [1, 'middle', bPath],
  [2, 'last', cPath],
] as const) {
  void idx
  const ctx = makeContext()
  primeRead(ctx, aPath, bPath, cPath)
  const pv = await callTool(
    {
      op: 'preview',
      changes: [
        member(aPath, [{ lines: '1', replace: `A-${label}` }]),
        member(bPath, [{ lines: '1', replace: `B-${label}` }]),
        member(cPath, [{ lines: '1', replace: `C-${label}` }]),
      ],
    },
    ctx,
  )
  const original = readFileSync(drift)
  writeFileSync(drift, `drifted-${label}\n`)
  const before = treeDigest()
  const r = await callTool({ op: 'apply', plan_id: pv.data.planId }, ctx)
  check(`drift at the ${label} target refuses with current anchors`, r.effect.outcome === 'failed' && /current anchor fa:[0-9a-f]{12}/.test(r.data.result) && /re-read/i.test(r.data.result))
  check(`drift at the ${label} target wrote NOTHING`, treeDigest() === before)
  writeFileSync(drift, original)
}

console.log('── Z6 cancellation before commit ⇒ zero writes ──')
{
  const ctx = makeContext({ aborted: true })
  primeRead(ctx, aPath, bPath)
  const before = treeDigest()
  const r = await callTool(
    { op: 'apply', changes: [member(aPath, [{ lines: '1', replace: 'A-cancel' }]), member(bPath, [{ lines: '1', replace: 'B-cancel' }])] },
    ctx,
  )
  check('cancellation refuses honestly', r.effect.outcome === 'failed' && /[Cc]ancelled/.test(r.data.result))
  check('cancellation wrote NOTHING', treeDigest() === before)
}

console.log('── Z7 all-no-change ⇒ ONE truthful no-change effect, zero writes ──')
{
  // Re-seed the fixture contents so this section is independent of any
  // earlier section's behavior.
  writeFileSync(aPath, A)
  writeFileSync(bPath, B)
  const ctx = makeContext()
  primeRead(ctx, aPath, bPath)
  const before = treeDigest()
  const mtimeBefore = statSync(aPath).mtimeMs
  const r = await callTool(
    { op: 'apply', changes: [member(aPath, [{ lines: '1', replace: 'a1' }]), member(bPath, [{ lines: '2', replace: 'b2' }])] },
    ctx,
  )
  check('outcome is the truthful no-change', r.effect.outcome === 'no-change' && r.effect.operation === 'file.changeSet')
  check('changedPaths is EMPTY', r.effect.changedPaths.length === 0)
  check('noChangePaths are NAMED in the details', Array.isArray(r.effect.details?.noChangePaths) && (r.effect.details!.noChangePaths as string[]).length === 2)
  check('zero filesystem writes (bytes + mtime untouched)', treeDigest() === before && statSync(aPath).mtimeMs === mtimeBefore)
  check('zero journal activity for a no-change set', (await journalOps()).length === 0)
}

console.log('── Z8 no refusal path leaves staged temps ──')
{
  check('fixture dir holds zero durable temps after every refusal above', strayTemps().length === 0)
}

console.log(failures === 0 ? '\nprove-changeset-zero-write: GREEN' : `\nprove-changeset-zero-write: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
