#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-edit-outcome-ledger.ts — FN-013 LOOP-06: every
//  terminal outcome of an edit attempt counts against the model that
//  produced it as (model, surface, outcome) — no new vocabulary, owner-
//  scoped, reaped with the owner, nothing content-shaped recorded. The
//  instrument the anchor-patch registry row's "real-model shakedown"
//  graduation always needed.
//
//    §1 ledger math: one-for-one counts; the /health projection (attempts,
//       applied, top failure); a mid-session model switch attributes
//       subsequent attempts to the new model and leaves prior counts; a
//       session with no attempts renders NO rows.
//    §2 owner isolation + reaping: two owners never share counts; owner
//       disposal reaps the ledger.
//    §3 the off arm: recording no-ops, reads answer empty, and the /health
//       check VANISHES (byte-identical report).
//    §4 the ChangeSet chokepoint, FUNCTIONAL through the real tool: a
//       refused apply counts its typed refusal code; an applied set counts
//       'applied' under the changeset surface.
//    §5 the formatter grammar readers: format → read-back round trip for
//       the refusal head and both anchor-patch spellings; foreign text
//       answers null (the drift poison).
//    §6 the wiring, structural: both toolExecution seams, the ChangeSet
//       settle, the flag row, the conditional /health composition.
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-edit-outcome-ledger.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-ledger-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_EDIT_LEDGER
delete process.env.MERCURY_CHANGESET
delete process.env.MERCURY_CHANGE_RECEIPTS

// The ChangeSet scope roots resolve from the cwd CAPTURED AT IMPORT — the
// fixture becomes the cwd before any src module loads.
const FIXTURES = mkdtempSync(join(tmpdir(), 'edit-ledger-fixture-'))
process.chdir(FIXTURES)

const ledger = await import('../../src/services/changeTransaction/editOutcomeLedger.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
const plan = await import('../../src/services/changeTransaction/changeSetPlan.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — ledger proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const ownerA = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ledger-a', lane: 'main' })
const ownerB = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ledger-b', lane: 'main' })

section('§1 ledger math, the health projection, model attribution')
{
  ledger._resetEditOutcomeLedgerForTesting()
  check('a session with no attempts renders NO rows', ledger.editOutcomeHealthRows(ownerA).length === 0)
  ledger.recordEditOutcome(ownerA, 'model-alpha', 'edit', 'applied')
  ledger.recordEditOutcome(ownerA, 'model-alpha', 'edit', 'applied')
  ledger.recordEditOutcome(ownerA, 'model-alpha', 'edit', 'error-11')
  ledger.recordEditOutcome(ownerA, 'model-alpha', 'edit', 'error-11')
  ledger.recordEditOutcome(ownerA, 'model-alpha', 'edit', 'error-13')
  ledger.recordEditOutcome(ownerA, 'model-alpha', 'changeset', 'stale-anchor')
  // The mid-session switch: later attempts attribute to the NEW model.
  ledger.recordEditOutcome(ownerA, 'model-beta', 'edit', 'applied')
  const rows = ledger.editOutcomeRows(ownerA)
  check(
    'one-for-one counts per (model, surface, outcome)',
    rows.find(r => r.model === 'model-alpha' && r.surface === 'edit' && r.outcome === 'applied')?.count === 2 &&
      rows.find(r => r.model === 'model-alpha' && r.outcome === 'error-11')?.count === 2 &&
      rows.find(r => r.model === 'model-alpha' && r.outcome === 'error-13')?.count === 1 &&
      rows.find(r => r.model === 'model-alpha' && r.surface === 'changeset' && r.outcome === 'stale-anchor')?.count === 1,
    JSON.stringify(rows),
  )
  const health = ledger.editOutcomeHealthRows(ownerA)
  const alpha = health.find(r => r.model === 'model-alpha')
  const beta = health.find(r => r.model === 'model-beta')
  check(
    'the health projection: attempts, applied, top failure with its count',
    alpha !== undefined && alpha.attempts === 6 && alpha.applied === 2 && alpha.topFailure === 'error-11' && alpha.topFailureCount === 2,
    JSON.stringify(alpha),
  )
  check('the switch left prior counts attributed and the new model its own row', beta !== undefined && beta.attempts === 1 && beta.applied === 1)
  check('no content-shaped material in any row', JSON.stringify(rows).includes('/') === false || !JSON.stringify(rows).includes('.ts'))
}

section('§2 owner isolation and reaping')
{
  ledger.recordEditOutcome(ownerB, 'model-alpha', 'edit', 'applied')
  check('two concurrent owners keep separate counts', ledger.editOutcomeHealthRows(ownerB).length === 1 && ledger.editOutcomeHealthRows(ownerA).length === 2)
  await disposeOwner(ownerB)
  check('disposal reaps the ledger with the owner', ledger.editOutcomeHealthRows(ownerB).length === 0)
  check('…without touching the sibling owner', ledger.editOutcomeHealthRows(ownerA).length === 2)
}

section('§3 the off arm removes the counters entirely')
{
  process.env.MERCURY_EDIT_LEDGER = '0'
  ledger.recordEditOutcome(ownerA, 'model-gamma', 'edit', 'applied')
  check('recording no-ops under the off arm', ledger.editOutcomeRows(ownerA).length === 0)
  check('reads answer empty under the off arm', ledger.editOutcomeHealthRows(ownerA).length === 0)
  delete process.env.MERCURY_EDIT_LEDGER
  check('the counts recorded while ON survive the toggle (the off arm hides, the on arm speaks)', ledger.editOutcomeHealthRows(ownerA).length === 2)
  check("no 'model-gamma' row appeared (the off-arm record truly no-opped)", !ledger.editOutcomeRows(ownerA).some(r => r.model === 'model-gamma'))
}

section('§4 the ChangeSet chokepoint through the REAL tool')
{
  ledger._resetEditOutcomeLedgerForTesting()
  const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const target = join(FIXTURES, 'target.txt')
  writeFileSync(target, 'line one\nline two\nline three\n')
  const readFileState = new Map<string, unknown>()
  const ctx = {
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    agentId: undefined,
    options: { mainLoopModel: 'model-chokepoint', tools: [] },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
  const parent = { uuid: '00000000-0000-0000-0000-000000000004', message: { id: 'msg_fixture' } }
  // A refused apply: the target was never read ⇒ the typed 'not-read' code.
  await (ChangeSetTool as { call: Function }).call(
    { op: 'apply', changes: [{ file_path: target, expected_anchor: 'fa:0000000000000000', hunks: [{ lines: '2', replace: 'LINE TWO' }] }] },
    ctx,
    null,
    parent,
  )
  const owner = (await import('../../src/services/run/resolveOwner.ts')).ownerFromToolUseContext(ctx as never)
  const afterRefusal = ledger.editOutcomeRows(owner)
  check(
    "the refused apply counted its TYPED code under (model-chokepoint, changeset)",
    afterRefusal.length === 1 && afterRefusal[0]!.model === 'model-chokepoint' && afterRefusal[0]!.surface === 'changeset' && afterRefusal[0]!.outcome !== 'failed' && afterRefusal[0]!.count === 1,
    JSON.stringify(afterRefusal),
  )
  // An applied set: prime the read, mint the real anchor, apply.
  const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
  const content = readFileSync(target, 'utf8')
  readFileState.set(target, { content, timestamp: Date.now() + 60_000, offset: undefined, limit: undefined })
  await (ChangeSetTool as { call: Function }).call(
    { op: 'apply', changes: [{ file_path: target, expected_anchor: mintFileAnchor(content), hunks: [{ lines: '2', replace: 'LINE TWO' }] }] },
    ctx,
    null,
    parent,
  )
  const afterApply = ledger.editOutcomeRows(owner)
  check(
    "the applied set counted 'applied' one-for-one",
    afterApply.find(r => r.outcome === 'applied' && r.surface === 'changeset')?.count === 1,
    JSON.stringify(afterApply),
  )
}

section('§5 the formatter grammar readers (one owner, drift-pinned)')
{
  const rendered = plan.formatChangeSetRefusal({
    ok: false,
    code: 'stale-anchor',
    message: 'the fixture drifted',
    recovery: 're-read the file',
  } as never)
  check('format → read-back round trip', plan.changeSetRefusalCodeOfResult(rendered) === 'stale-anchor', rendered.split('\n')[0])
  check('the parse spelling reads back', plan.anchorPatchCodeOfResult('patch parse failed [bad-header] at line 2: x') === 'bad-header')
  check('the reject spelling reads back', plan.anchorPatchCodeOfResult('patch rejected [stale-anchor]: y') === 'stale-anchor')
  check('foreign text answers null (the drift poison)', plan.changeSetRefusalCodeOfResult('some other refusal') === null && plan.anchorPatchCodeOfResult('nope') === null)
}

section('§6 the wiring, structural')
{
  const root = join(import.meta.dir, '../../')
  const toolExec = readFileSync(join(root, 'src/services/tools/toolExecution.ts'), 'utf8')
  check('the validation-refusal seam counts coded Edit refusals', /verdict\.result === false[\s\S]{0,900}recordEditOutcome/.test(toolExec))
  check('the terminal-effect seam counts applied/no-change for file.edit', /op === 'file\.edit'[\s\S]{0,700}recordEditOutcome/.test(toolExec))
  const changeSet = readFileSync(join(root, 'src/tools/ChangeSetTool/ChangeSetTool.ts'), 'utf8')
  check('the ChangeSet settle chokepoint counts applies with typed codes', /input\.op === 'apply'[\s\S]{0,900}changeSetRefusalCodeOfResult/.test(changeSet))
  const registry = readFileSync(join(root, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('the display-tier flag row stands with its off arm', registry.includes("env: 'MERCURY_EDIT_LEDGER'") && registry.includes('counters are removed entirely'))
  const health = readFileSync(join(root, 'src/utils/healthReport.ts'), 'utf8')
  check('the /health check vanishes with the flag off (conditional composition)', /editOutcomeHealthChecks\(\)/.test(health) && /if \(!editOutcomeLedgerEnabled\(\)\) return \[\]/.test(health))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-edit-outcome-ledger — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-edit-outcome-ledger — all checks pass')
process.exit(0)
