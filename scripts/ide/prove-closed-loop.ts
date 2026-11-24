import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, fixture, emit, status, finish, call, done, tx, capture, receiptsFor } from './transactionProof.js'

const f = fixture(['calc.py'])
writeFileSync(f.files[0]!, 'def add(a, b):\n    return a + b\n')
mkdirSync(join(f.root, 'tests'))
writeFileSync(join(f.root, 'tests', '__init__.py'), '')
writeFileSync(join(f.root, 'tests', 'test_calc.py'), 'import unittest\nfrom calc import add\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')
const SYS_PY = '/usr/bin/python3'
process.env.MERCURY_PYTHON = SYS_PY
const { runPythonTests } = await import('../../src/integrations/ide/pythonTests.js')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.js')
const { resolveResource } = await import('../../src/integrations/resources/registry.js')

emit(f)
const early = await finish(f)
const opened = tx.latestTransaction(f.root)!
check('A1 observed edit is saved on the first finish attempt', opened?.steps.filter(s => s.kind === 'apply').length === 1, JSON.stringify(opened?.steps.map(s => s.kind)) + ' — expected one apply step; change the automatic capture in src/integrations/ide/txAutoCapture.ts so an observed edit is saved on the first finish call')
const fake = await tx.noteStep({ id: opened.id, owner: f.owner, from: f.root, kind: 'apply', summary: 'pretend apply', refs: ['mercury://receipt/rcpt-doesnotexist'] })
check('A2 an unresolvable ref refuses the internal note', fake.state === 'refused' && fake.reason.includes('does not resolve'), JSON.stringify(fake) + ' — change noteStep in src/integrations/ide/ideTransaction.ts so it refuses a ref that does not resolve')
const receipt = receiptsFor(f.owner).at(-1)
check('A3 automatic change carries the real observer receipt', opened.steps[0]?.refs[0] === `mercury://receipt/${receipt?.id}`, JSON.stringify(opened.steps[0]?.refs) + ' — change src/integrations/ide/txAutoCapture.ts so the automatic apply step carries the observer receipt ref')
check('B1 only the real post-change check is missing', early.data.outcome === 'failed' && early.data.result.includes('no check has run since the last change') && !early.data.result.includes('stabilize'), JSON.stringify(early.data) + ' — change the gap list in src/integrations/ide/ideTransaction.ts so only the missing post-change check is named')
const run = await runPythonTests({ from: f.root, framework: 'unittest', selectionLabel: 'all' })
check('B2 the real Python test run is green', run.state === 'ok' && run.record.counts.failed === 0, JSON.stringify(run) + ' — runPythonTests in src/integrations/ide/pythonTests.ts did not run the fixture unittest green; check that /usr/bin/python3 exists')
if (run.state === 'ok') {
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
  const resource = await runWithCwdOverride(f.root, () => resolveResource(`mercury://test/run/${run.record.id}`, { owner: f.owner, cwd: f.root }))
  check('B3 its durable test ref resolves', resource.state === 'ok', JSON.stringify(resource) + ' — mercury://test/run/<id> must resolve through resolveResource in src/integrations/resources/registry.ts')
}
emit(f, 'test.run', { paths: [], toolName: 'Test', input: { op: 'run' } })
const complete = await finish(f, 'completed', ['pytest arm untested on this fixture'])
check('B4 the observed edit and real check complete', complete.data.outcome === 'succeeded', JSON.stringify(complete.data) + ' — change the finish gap check in src/integrations/ide/ideTransaction.ts so an observed edit followed by a real check completes')
check('B5 uncertainty is preserved verbatim', tx.getTransaction(opened.id, f.root)?.unresolved.includes('pytest arm untested on this fixture') === true, 'change the finish path in src/integrations/ide/ideTransaction.ts so the unresolved list is saved verbatim')
const late = await tx.noteStep({ id: opened.id, owner: f.owner, from: f.root, kind: 'verify', summary: 'late note' })
check('B6 a finished record refuses further notes', late.state === 'refused', JSON.stringify(late) + ' — change noteStep in src/integrations/ide/ideTransaction.ts so a finished record refuses notes')

emit(f)
emit(f, 'test.run', { paths: [], outcome: 'failed', ok: false, toolName: 'Test', input: { op: 'run' } })
const red = await finish(f)
check('C1 the newest failed check blocks completion', red.data.outcome === 'failed' && red.data.result.includes('the newest check since the last change failed'), JSON.stringify(red.data) + ' — change the gap list in src/integrations/ide/ideTransaction.ts so a failed newest check blocks completion')
const failed = await finish(f, 'failed', ['test_add still red'])
check('C2 failed finish preserves uncertainty', failed.data.outcome === 'no-change' && tx.latestTransaction(f.root)?.verdict === 'failed' && tx.latestTransaction(f.root)?.unresolved.length === 1, JSON.stringify(failed.data) + ' — change the finish path in src/integrations/ide/ideTransaction.ts so a failed verdict keeps the unresolved list')

check('D1 latest.json points at the newest record', tx.latestTransaction(f.root) !== null, 'change latestTransaction in src/integrations/ide/ideTransaction.ts so it reads the newest record')
check('D4 the trail lists both loops', tx.listTransactions(f.root).length === 2, 'listTransactions in src/integrations/ide/ideTransaction.ts returned ' + tx.listTransactions(f.root).length + ' records, expected 2')
const one = await resolveResource(`mercury://ide/transaction/${opened.id}`, { owner: f.owner, cwd: f.root })
check('E1 the resource reads the structured completed record', one.state === 'ok' && (one.resource.structured as { verdict?: string }).verdict === 'completed', JSON.stringify(one.state) + ' — mercury://ide/transaction/<id> must resolve through resolveResource in src/integrations/resources/registry.ts with the completed record')
check('E2 the latest resource resolves', (await resolveResource('mercury://ide/transaction/latest', { owner: f.owner, cwd: f.root })).state === 'ok')
const listing = await resolveResource('mercury://ide/transaction', { owner: f.owner, cwd: f.root })
check('E3 the resource listing keeps both records', listing.state === 'ok' && listing.resource.children?.length === 2, JSON.stringify(listing.state) + ' — mercury://ide/transaction must list both records through resolveResource in src/integrations/resources/registry.ts')

const internal = await tx.openTransaction({ owner: f.owner, intent: 'historical session refs', from: f.root })
const ref = 'mercury://agent/b1234'
const getAppState = () => ({ tasks: { b1234: { id: 'b1234', type: 'local_bash', status: 'running', description: 'fixture shell', startTime: Date.now() } } })
const noted = await tx.noteStep({ id: internal.id, owner: f.owner, from: f.root, kind: 'apply', summary: 'historical session evidence', refs: [ref], getAppState })
check('F1 historical session refs still resolve through the service reader', noted.state === 'ok', JSON.stringify(noted) + ' — change noteStep in src/integrations/ide/ideTransaction.ts so a getAppState reader resolves mercury://agent refs')
const readerless = await tx.noteStep({ id: internal.id, owner: f.owner, from: f.root, kind: 'diagnose', summary: 'no reader', refs: [ref] })
check('F2 the same ref without a reader still refuses', readerless.state === 'refused' && readerless.reason.includes('unavailable'), JSON.stringify(readerless) + ' — change noteStep in src/integrations/ide/ideTransaction.ts so a ref without a reader refuses as unavailable')
const mixed = await tx.noteStep({ id: internal.id, owner: f.owner, from: f.root, kind: 'diagnose', summary: 'mixed refs', refs: [ref, 'mercury://agent/nope'], getAppState })
check('F3 a mixed live and fabricated set refuses whole without a step', mixed.state === 'refused' && tx.getTransaction(internal.id, f.root)?.steps.length === 1, JSON.stringify(mixed) + ' — change noteStep in src/integrations/ide/ideTransaction.ts so one fabricated ref refuses the whole note and adds no step')
await finish(f, 'abandoned')

const idle = await finish(f, 'abandoned')
check('G1 nothing to finish preserves the exact result', idle.data.outcome === 'no-change' && idle.data.result === 'Nothing to finish — no transaction is open at this root.', JSON.stringify(idle.data) + ' — change the finish op in src/tools/transaction/TransactionTool.ts so it keeps the exact nothing-to-finish result')
for (let n = 0; n < 4; n++) emit(f)
const queued = await call(f, { op: 'status' })
check('G2 a batch of changes opens one unsaved journal and loses none', queued.data.result.startsWith('unsaved record [open]') && queued.data.result.includes('4 change(s)') && tx.openTransactionIdFor(f.root) === null, JSON.stringify(queued.data.result) + ' — change the status op in src/tools/transaction/TransactionTool.ts and txAutoCapture.ts so a batch of changes opens one unsaved journal')
await finish(f, 'abandoned')
check('G3 finish saves and closes the journal', tx.latestTransaction(f.root)?.steps.length === 4 && tx.openTransactionIdFor(f.root) === null, 'steps ' + tx.latestTransaction(f.root)?.steps.length + ', open id ' + tx.openTransactionIdFor(f.root) + ' — change the finish op in src/tools/transaction/TransactionTool.ts so it saves all four changes and closes the journal')
await capture._drainTxAutoCaptureForTesting()
check('G4 status names the latest record after finish', (await status(f)).includes('Latest record:'), 'change the status op in src/tools/transaction/TransactionTool.ts so it prints the Latest record line after finish')
delete process.env.MERCURY_PYTHON
done('prove-closed-loop')
