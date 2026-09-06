#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SYS_PY = '/usr/bin/python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

console.log('============================================================')
console.log(' closed-loop IDE transaction — binder mechanics vs real evidence')
console.log('============================================================')

const proj = mkdtempSync(path.join(tmpdir(), 'mercury-loop-'))
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "loop-fixture"\nversion = "0.0.1"\n')
writeFileSync(path.join(proj, 'calc.py'), 'def add(a, b):\n    return a + b\n')
mkdirSync(path.join(proj, 'tests'))
writeFileSync(path.join(proj, 'tests', '__init__.py'), '')
writeFileSync(
  path.join(proj, 'tests', 'test_calc.py'),
  'import sys, os\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\n' +
    'import unittest\nfrom calc import add\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n',
)

process.env.MERCURY_PYTHON = SYS_PY
process.chdir(proj)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const tx = await import('../../src/services/ide/ideTransaction.js')
const tests = await import('../../src/services/ide/pythonTests.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.js')
_resetPythonProjectForTesting()
await import('../../src/services/resources/adapters/ide.js')
await import('../../src/services/resources/adapters/test.js')

const owner = makeOwnerKey({ workspace: proj, sessionId: 'loop-proof', lane: 'main' })

try {
  section('(A) ref honesty — fabricated evidence cannot enter the record')
  const opened = await tx.openTransaction({ owner, intent: 'fix add() and prove it' })
  {
    const fake = await tx.noteStep({
      id: opened.id,
      owner,
      kind: 'apply',
      summary: 'pretend apply',
      refs: ['mercury://receipt/rcpt-doesnotexist'],
    })
    check('A1 an unresolvable ref REFUSES the note', fake.state === 'refused' && fake.reason.includes('does not resolve'), JSON.stringify(fake).slice(0, 160))

    const { observeToolTerminal } = await import('../../src/services/run/effectObserver.js')
    writeFileSync(path.join(proj, 'calc.py'), 'def add(a, b):\n    return a + b  # verified\n')
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'loop-proof-edit',
      input: { file_path: path.join(proj, 'calc.py') },
      effect: {
        outcome: 'succeeded',
        operation: 'edit',
        changedPaths: [path.join(proj, 'calc.py')],
        evidence: 'proof edit',
        startedAt: Date.now() - 5,
        completedAt: Date.now(),
      },
    } as never)
    const { receiptsFor } = await import('../../src/services/changeTransaction/receipts.js')
    const receipt = receiptsFor(owner).at(-1)
    check('A2 a REAL receipt minted through the production observer', receipt !== undefined, 'no receipt minted')
    const noted = await tx.noteStep({
      id: opened.id,
      owner,
      kind: 'apply',
      summary: 'anchored edit to calc.py',
      refs: [`mercury://receipt/${receipt?.id}`],
    })
    check('A3 the real receipt ref notes cleanly', noted.state === 'ok', JSON.stringify(noted).slice(0, 160))
  }

  section('(B) the mechanical completion gate — refusals NAME the gaps')
  {
    const early = await tx.finishTransaction({ id: opened.id, owner, verdict: 'completed' })
    check('B1 completion refused: no stabilize + no check yet', early.state === 'refused' && early.missing.some(m => m.includes('stabilize')) && early.missing.some(m => m.includes('test')), JSON.stringify(early).slice(0, 240))

    await tx.noteStep({ id: opened.id, owner, kind: 'stabilize', summary: 'post-apply diagnostics clean (0 errors)' })
    const stillNoCheck = await tx.finishTransaction({ id: opened.id, owner, verdict: 'completed' })
    check('B2 still refused: the real check is missing', stillNoCheck.state === 'refused' && stillNoCheck.missing.length === 1, JSON.stringify(stillNoCheck.state === 'refused' ? stillNoCheck.missing : ''))

    const run = await tests.runPythonTests({ from: proj, framework: 'unittest', selectionLabel: 'all' })
    check('B3 the REAL test run is green', run.state === 'ok' && run.record.counts.failed === 0, JSON.stringify(run).slice(0, 120))
    if (run.state === 'ok') {
      const noted = await tx.noteStep({
        id: opened.id,
        owner,
        kind: 'test',
        summary: `unittest all green (${run.record.counts.passed} passed)`,
        refs: [`mercury://test/run/${run.record.id}`],
      })
      check('B4 the test ref (durable record) notes cleanly', noted.state === 'ok')
    }
    const done = await tx.finishTransaction({ id: opened.id, owner, verdict: 'completed', unresolved: ['pytest arm untested on this fixture'] })
    check('B5 the complete chain finishes as completed', done.state === 'ok' && done.record.verdict === 'completed')
    check('B6 unresolved uncertainty preserved verbatim', done.state === 'ok' && done.record.unresolved.includes('pytest arm untested on this fixture'))
    const reopen = await tx.noteStep({ id: opened.id, owner, kind: 'verify', summary: 'late note' })
    check('B7 a finished transaction refuses further notes', reopen.state === 'refused')
  }

  section('(C) failed is never painted as completion')
  {
    const second = await tx.openTransaction({ owner, intent: 'a loop that fails' })
    const { receiptsFor } = await import('../../src/services/changeTransaction/receipts.js')
    const receipt = receiptsFor(owner).at(-1)!
    await tx.noteStep({ id: second.id, owner, kind: 'apply', summary: 'edit', refs: [`mercury://receipt/${receipt.id}`] })
    await tx.noteStep({ id: second.id, owner, kind: 'stabilize', summary: 'diagnostics stable' })
    await tx.noteStep({ id: second.id, owner, kind: 'test', summary: 'suite failed (1 failing)', outcome: 'failed' })
    const refused = await tx.finishTransaction({ id: second.id, owner, verdict: 'completed' })
    check('C1 a failed post-apply step blocks completion', refused.state === 'refused' && refused.missing.some(m => m.includes('failed step')), JSON.stringify(refused.state === 'refused' ? refused.missing : ''))
    const failed = await tx.finishTransaction({ id: second.id, owner, verdict: 'failed', unresolved: ['test_add still red'] })
    check('C2 finishing as failed lands with the uncertainty', failed.state === 'ok' && failed.record.verdict === 'failed' && failed.record.unresolved.length === 1)
  }

  section('(D) durability + resume — report, never replay')
  {
    const latest = tx.latestTransaction(proj)
    check('D1 latest.json points at the newest record', latest !== null)
    const strangeOwner = makeOwnerKey({ workspace: proj, sessionId: 'another-process', lane: 'main' })
    const resumed = await tx.resumeTransaction({ id: opened.id, owner: strangeOwner, from: proj })
    check('D2 resume re-reads the durable record', resumed !== null && resumed.record.verdict === 'completed')
    check(
      'D3 the apply receipt reads STALE for a different owner (reported, not replayed)',
      resumed !== null && resumed.applyRefChecks.length === 1 && resumed.applyRefChecks[0]?.resolves === false && resumed.applyRefChecks[0]!.note.includes('nothing was replayed'),
      JSON.stringify(resumed?.applyRefChecks),
    )
    const rows = tx.listTransactions(proj)
    check('D4 the trail lists both loops', rows.length === 2, JSON.stringify(rows.map(r => r.verdict)))
  }

  section('(E) the resource plane')
  {
    const { resolveResource } = await import('../../src/services/resources/registry.js')
    const one = await resolveResource(`mercury://ide/transaction/${opened.id}`, { owner, cwd: proj })
    check('E1 mercury://ide/transaction/<id> resolves with the structured record', one.state === 'ok' && (one.state === 'ok' ? (one.resource.structured as { verdict?: string }).verdict === 'completed' : false), one.state)
    const latest = await resolveResource('mercury://ide/transaction/latest', { owner, cwd: proj })
    check('E2 /latest resolves', latest.state === 'ok')
    const listing = await resolveResource('mercury://ide/transaction', { owner, cwd: proj })
    check('E3 the kind listing shows the trail', listing.state === 'ok' && (listing.state === 'ok' ? (listing.resource.children?.length ?? 0) === 2 : false))
  }

  section('(F) the tool hands the binder its session reader — live-session refs note and resume')
  {
    const { TransactionTool } = await import('../../src/tools/TransactionTool/TransactionTool.js')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
    const { getCwd } = await import('../../src/utils/cwd.js')
    const { realpathSync } = await import('node:fs')
    const AGENT_REF = 'mercury://agent/b1234'
    const root = getCwd()
    const toolCtx = {
      owner,
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => ({
        toolPermissionContext: getEmptyToolPermissionContext(),
        tasks: {
          b1234: { id: 'b1234', type: 'local_bash', status: 'running', description: 'fixture shell', startTime: Date.now() - 3000 },
        },
      }),
      setAppState: () => {},
      options: { tools: [], isNonInteractiveSession: true },
    }
    type Reply = { data: { op: string; result: string; outcome: string } }
    const call = (input: Record<string, unknown>): Promise<Reply> =>
      (TransactionTool as unknown as { call: Function }).call(input, toolCtx) as Promise<Reply>
    check('F0 the tool roots its records at the fixture project', realpathSync(root) === realpathSync(proj), root)
    if (realpathSync(root) === realpathSync(proj)) {
      const begun = await call({ op: 'begin', intent: 'note a running shell as evidence' })
      const toolId = tx.latestTransaction(root)?.id ?? ''
      check('F1 the tool opens a transaction of its own', begun.data.outcome === 'succeeded' && toolId !== '' && begun.data.result.includes(toolId), begun.data.result.slice(0, 120))
      const noted = await call({ op: 'step', kind: 'diagnose', summary: 'the shell is still running', refs: [AGENT_REF] })
      check('F2 an agent ref notes cleanly through the tool (the session reader rides the call)', noted.data.outcome === 'succeeded', noted.data.result.slice(0, 200))
      const direct = await tx.noteStep({ id: toolId, owner, kind: 'diagnose', summary: 'no reader here', refs: [AGENT_REF], from: root })
      check('F3 the same ref without a reader still refuses (the adapter answers unavailable, never optimistic)', direct.state === 'refused' && direct.reason.includes('unavailable'), JSON.stringify(direct).slice(0, 200))
      const mixed = await call({ op: 'step', kind: 'diagnose', summary: 'one live, one fabricated', refs: [AGENT_REF, 'mercury://agent/nope'] })
      const record = tx.getTransaction(toolId, root)
      check('F4 a set with one fabricated ref refuses whole, names it, and writes no step', mixed.data.outcome === 'failed' && mixed.data.result.includes('mercury://agent/nope') && record?.steps.length === 1, `${mixed.data.result.slice(0, 160)} · steps ${record?.steps.length}`)
      const applied = await call({ op: 'step', kind: 'apply', summary: 'applied while the shell ran', refs: [AGENT_REF] })
      check('F5 an apply step with an agent ref notes through the tool', applied.data.outcome === 'succeeded', applied.data.result.slice(0, 160))
      const resumed = await call({ op: 'resume', id: toolId })
      check('F6 resume through the tool reads the agent ref live', resumed.data.outcome === 'no-change' && new RegExp(`\\[live\\] ${AGENT_REF}`).test(resumed.data.result), resumed.data.result.split('\n').filter(l => l.includes(AGENT_REF)).join(' | ').slice(0, 200))
      const readerless = await tx.resumeTransaction({ id: toolId, owner, from: root })
      check('F7 a reader-less resume reports the same ref stale (reported, never repaired)', readerless !== null && readerless.applyRefChecks.some(c => c.ref === AGENT_REF && c.resolves === false), JSON.stringify(readerless?.applyRefChecks).slice(0, 200))
      const closed = await call({ op: 'finish', verdict: 'abandoned' })
      check('F8 the tool closes its transaction', closed.data.outcome === 'no-change' || closed.data.outcome === 'succeeded', closed.data.result.slice(0, 120))
    }
  }
} finally {
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
  delete process.env.MERCURY_PYTHON
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL CLOSED-LOOP CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
