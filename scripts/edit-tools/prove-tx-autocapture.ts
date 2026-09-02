#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-tx-autocapture.ts — automatic closed-loop
//  evidence capture, proved through the REAL effect-observer seam.
//
//  Laws:
//    C. classification is the bounded registry — mapped operations only
//    O. no open transaction ⇒ no record write (and near-zero work)
//    A. auto rows appear EXACTLY ONCE for success, failure, no-change and
//       indeterminate effects; apply rows carry the REAL receipt ref; the
//       vacuous stabilize is auto-noted only without a diagnostics provider
//    D. duplicate/replayed events (same toolUseId) never double-record —
//       including across a simulated resume
//    M. manual and automatic rows coexist; completion still refuses a
//       missing green check and passes once the auto evidence is complete
//    G. MERCURY_TX_AUTOCAPTURE=0 ⇒ zero captures (manual surface exactly)
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-tx-autocapture.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anvil-s4-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_TX_AUTOCAPTURE

const { installTxAutoCapture, classifyEffectStep, _drainTxAutoCaptureForTesting } =
  await import('../../src/services/ide/txAutoCapture.ts')
const {
  openTransaction,
  getTransaction,
  finishTransaction,
  noteStep,
} = await import('../../src/services/ide/ideTransaction.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { _resetChangeReceiptsForTesting } = await import(
  '../../src/services/changeTransaction/receipts.ts'
)
const { runPythonTests } = await import('../../src/services/ide/pythonTests.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

installTxAutoCapture()
const owner = processMainOwner()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — autocapture proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

function pyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-s4-'))
  mkdirSync(join(dir, 'mylib'))
  mkdirSync(join(dir, 'tests'))
  writeFileSync(join(dir, 'mylib', '__init__.py'), '')
  writeFileSync(join(dir, 'mylib', 'core.py'), 'def ok():\n    return True\n')
  writeFileSync(join(dir, 'tests', '__init__.py'), '')
  writeFileSync(
    join(dir, 'tests', 'test_core.py'),
    'import unittest\nfrom mylib.core import ok\n\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(ok())\n',
  )
  return dir
}

let eventSeq = 0
function emitEdit(cwd: string, file: string, opts: { ok?: boolean; outcome?: 'succeeded' | 'failed' | 'no-change' | 'indeterminate'; toolUseId?: string } = {}): string {
  const toolUseId = opts.toolUseId ?? `anvil-s4-${++eventSeq}`
  const now = Date.now()
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId,
    input: { file_path: file },
    ok: opts.ok ?? true,
    durationMs: 3,
    effect: {
      outcome: opts.outcome ?? 'succeeded',
      operation: 'file.edit',
      changedPaths: opts.outcome === 'no-change' ? [] : [file],
      evidence: 'fixture edit',
      startedAt: now - 3,
      completedAt: now,
    },
    cwd,
  })
  return toolUseId
}

// ── C. classification registry ──────────────────────────────────────────────
section('C. the bounded operation registry')
{
  check('C1 file.edit → apply', classifyEffectStep('file.edit') === 'apply')
  check('C2 structure.apply → apply', classifyEffectStep('structure.apply') === 'apply')
  check('C3 test.run → test', classifyEffectStep('test.run') === 'test')
  check('C4 journey.run → verify', classifyEffectStep('journey.run') === 'verify')
  check('C5 lsp.rename.apply → apply', classifyEffectStep('lsp.rename.apply') === 'apply')
  check('C6 unmapped ops never capture', classifyEffectStep('lsp.references') === null && classifyEffectStep('bash.exec') === null)
}

// ── O. no open transaction ⇒ nothing ────────────────────────────────────────
section('O. no open transaction ⇒ no record write')
{
  const dir = pyFixture()
  emitEdit(dir, join(dir, 'mylib', 'core.py'))
  await _drainTxAutoCaptureForTesting()
  const latest = await runWithCwdOverride(dir, async () => {
    const { latestTransaction } = await import('../../src/services/ide/ideTransaction.ts')
    return latestTransaction(dir)
  })
  check('O1 no transaction record materialized', latest === null)
}

// ── A. exactly-once capture per outcome class ───────────────────────────────
section('A. auto rows for success/failure/no-change/indeterminate')
{
  const dir = pyFixture()
  const file = join(dir, 'mylib', 'core.py')
  _resetChangeReceiptsForTesting()
  const tx = await openTransaction({ owner, intent: 'autocapture fixture', from: dir })

  emitEdit(dir, file) // success → apply + receipt ref + vacuous stabilize
  emitEdit(dir, file, { ok: false, outcome: 'failed' })
  emitEdit(dir, file, { outcome: 'no-change' })
  emitEdit(dir, file, { outcome: 'indeterminate' })
  await _drainTxAutoCaptureForTesting()

  const rec = getTransaction(tx.id, dir)!
  const autoRows = rec.steps.filter(s => s.auto)
  const applies = autoRows.filter(s => s.kind === 'apply')
  check('A1 four apply rows + one vacuous stabilize', applies.length === 4 && autoRows.filter(s => s.kind === 'stabilize').length === 1, `steps: ${rec.steps.map(s => `${s.kind}/${s.outcome}`).join(',')}`)
  check('A2 ok apply carries the REAL receipt ref', applies[0]!.refs.some(r => r.startsWith('mercury://receipt/')))
  check('A3 outcomes map (ok/failed/info/indeterminate)',
    applies.map(s => s.outcome).join(',') === 'ok,failed,info,indeterminate')
  check('A4 summaries are [auto]-marked and bounded', autoRows.every(s => s.summary.startsWith('[auto]') && s.summary.length <= 300))
}

// ── D. exactly-once under replay ────────────────────────────────────────────
section('D. duplicate events never double-record')
{
  const dir = pyFixture()
  const file = join(dir, 'mylib', 'core.py')
  _resetChangeReceiptsForTesting()
  const tx = await openTransaction({ owner, intent: 'dedup fixture', from: dir })
  const tid = emitEdit(dir, file)
  await _drainTxAutoCaptureForTesting()
  emitEdit(dir, file, { toolUseId: tid }) // exact replay (resume/retry)
  await _drainTxAutoCaptureForTesting()
  const rec = getTransaction(tx.id, dir)!
  check('D1 one apply row for a replayed toolUseId', rec.steps.filter(s => s.kind === 'apply').length === 1)
  check('D2 one stabilize row too', rec.steps.filter(s => s.kind === 'stabilize').length === 1)
}

// ── M. manual coexistence + completion law ──────────────────────────────────
section('M. manual rows coexist; completion stays mechanical')
{
  const dir = pyFixture()
  const file = join(dir, 'mylib', 'core.py')
  _resetChangeReceiptsForTesting()
  const tx = await openTransaction({ owner, intent: 'completion fixture', from: dir })
  emitEdit(dir, file)
  await _drainTxAutoCaptureForTesting()

  const early = await finishTransaction({ id: tx.id, owner, verdict: 'completed', from: dir })
  check('M1 completion refused without a green check', early.state === 'refused' && early.state === 'refused' && early.missing.some(m => m.includes("'test' | 'build' | 'verify'")))

  // the REAL test run's terminal effect closes the loop automatically
  const run = await runPythonTests({ from: dir })
  check('M2 fixture test run green', run.state === 'ok' && run.record.counts.failed === 0)
  const now = Date.now()
  observeToolTerminal({
    owner,
    toolName: 'Test',
    toolUseId: `anvil-s4-test-${++eventSeq}`,
    input: { op: 'run' },
    ok: true,
    durationMs: 50,
    effect: {
      outcome: 'succeeded',
      operation: 'test.run',
      changedPaths: [],
      evidence: run.state === 'ok' ? `unittest green (${run.record.id})` : 'run',
      startedAt: now - 50,
      completedAt: now,
    },
    cwd: dir,
  })
  await _drainTxAutoCaptureForTesting()

  const manual = await noteStep({ id: tx.id, owner, kind: 'context', summary: 'manual commentary row', from: dir })
  check('M3 manual row coexists', manual.state === 'ok')

  const fin = await finishTransaction({ id: tx.id, owner, verdict: 'completed', from: dir })
  check('M4 completion passes on auto evidence', fin.state === 'ok', fin.state === 'refused' ? fin.reason : '')
  if (fin.state === 'ok') {
    const kinds = fin.record.steps.map(s => `${s.kind}${s.auto ? '*' : ''}`)
    check('M5 record shows auto (*) + manual rows', kinds.join(',').includes('apply*') && kinds.join(',').includes('context'))
  }
}

// ── G. gate OFF ⇒ zero captures ─────────────────────────────────────────────
section('G. MERCURY_TX_AUTOCAPTURE=0 ⇒ manual surface exactly')
{
  process.env.MERCURY_TX_AUTOCAPTURE = '0'
  const dir = pyFixture()
  const tx = await openTransaction({ owner, intent: 'gate fixture', from: dir })
  emitEdit(dir, join(dir, 'mylib', 'core.py'))
  await _drainTxAutoCaptureForTesting()
  const rec = getTransaction(tx.id, dir)!
  check('G1 zero auto rows when off', rec.steps.length === 0)
  process.env.MERCURY_TX_AUTOCAPTURE = '1'
}

console.log('')
if (failures > 0) {
  console.error(`prove-tx-autocapture: ${failures} RED`)
  process.exit(1)
}
console.log('prove-tx-autocapture: GREEN')
