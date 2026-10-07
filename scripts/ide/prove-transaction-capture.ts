import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { check, fixture, emit, evidence, status, finish, done, call, tx, capture, receiptsFor,
  projectHomeStore, observeToolTerminal, ledger } from './transactionProof.js'

const changed = fixture(['a_three/client.py', 'a_three/config.py', 'a_three/server.py'])
const id = emit(changed, 'file.changeSet', { toolName: 'ChangeSet' })
let text = await status(changed)
const receipt = receiptsFor(changed.owner).find(row => row.toolUseId === id)
check('C1 ChangeSet captures all three paths and its actual receipt',
  text.includes('[ok] file.changeSet: a_three/client.py, a_three/config.py, a_three/server.py') &&
  text.includes(`mercury://receipt/${receipt?.id}`), text)
for (const operation of ['codeActions', 'pathRename', 'fixDiagnostic', 'moveSymbol']) {
  const f = fixture()
  emit(f, `lsp.${operation}`, { toolName: 'LSP' })
  check(`C2 LSP ${operation} is a landed change`, (await status(f)).includes(`[ok] lsp.${operation}: one.txt`))
}
evidence(changed)
text = await status(changed)
check('C3 verification-ledger checks join the record', text.includes('[ok] test: bun test — green'), text)
const store = projectHomeStore(changed.root, 'ide-transactions')
check('C7 capture and status leave the transaction store absent', !existsSync(store), store)
const saved = await finish(changed)
const record = tx.latestTransaction(changed.root)
check('C7 finish writes both steps and latest.json', saved.data.outcome === 'succeeded' &&
  record?.steps.length === 2 && existsSync(join(store, `${record.id}.json`)) && existsSync(join(store, 'latest.json')), saved.data.result)

const readBack = fixture(['one.txt', 'two.txt'])
emit(readBack)
for (const file of readBack.files) {
  observeToolTerminal({ owner: readBack.owner, cwd: readBack.root, toolName: 'Read', toolUseId: file,
    input: { file_path: file }, ok: true, durationMs: 1, effect: undefined })
}
text = await status(readBack)
check('C4 full read-back joins the automatic record', text.includes('[ok] read-back: changed files read back (no verification machinery in this workspace) — green'), text)
check('C4 read-back satisfies completion', (await finish(readBack)).data.outcome === 'succeeded')

const commit = fixture()
emit(commit)
emit(commit, 'git.commit', { paths: [], input: {}, toolName: 'Git' })
text = await status(commit)
check('C5 a commit is information, never a passing check', text.includes('[info] git.commit:') && text.includes('no check has run since the last change'), text)

for (const excluded of ['outside', 'internal']) {
  const f = fixture()
  const paths = [excluded === 'outside' ? join(f.root, '..', 'outside.txt') : join(f.root, '.mercury', 'record')]
  emit(f, 'file.write', { paths, input: { file_path: paths[0] } })
  text = await status(f)
  check(`C6 ${excluded} writes open no journal`, text === 'Nothing recorded at this root since the last finish. Changes (Edit, Write, ChangeSet, AstEdit, NotebookEdit, LSP writes, Structure) and checks (Bash or Test runs) are recorded here as they happen.', text)
}

const capped = fixture()
const opened = await tx.openTransaction({ owner: capped.owner, intent: 'window fixture', from: capped.root })
for (let n = 0; n < 101; n++) emit(capped, 'file.edit', { toolUseId: `window-${n}` })
await capture._drainTxAutoCaptureForTesting()
const windowed = tx.getTransaction(opened.id, capped.root)
check('C8 101 captures keep newest 100 and count the dropped step', windowed?.steps.length === 100 &&
  (windowed as { elided?: number })?.elided === 1 && windowed.steps[0]?.auto?.toolUseId === 'window-1', JSON.stringify(windowed?.steps.map(s => s.auto)))

const queued = fixture()
emit(queued)
emit(queued, 'test.run', { paths: [], input: { op: 'run' }, toolName: 'Test' })
check('C9 finish drains the just-ended check without a test-side wait', (await finish(queued)).data.outcome === 'succeeded')

const duplicate = fixture()
emit(duplicate, 'file.edit', { toolUseId: 'same-event' })
emit(duplicate, 'file.edit', { toolUseId: 'same-event' })
await status(duplicate)
await finish(duplicate)
emit(duplicate, 'file.edit', { toolUseId: 'same-event' })
await capture._drainTxAutoCaptureForTesting()
check('C10 duplicate terminal events do not duplicate journal or saved steps', tx.latestTransaction(duplicate.root)?.steps.filter(s => s.kind === 'apply').length === 1)

for (const operation of ['git.restore', 'git.resolve', 'workshop.transform', 'future.write']) {
  const f = fixture()
  emit(f, operation)
  check(`receipt-shaped ${operation} is captured without a second mutation registry`, (await status(f)).includes(`[ok] ${operation}: one.txt`))
}
for (const kind of ['Bash', 'PowerShell', 'background']) {
  const f = fixture()
  emit(f)
  if (kind === 'background') ledger.recordShellCommandOutcome('bun test', 0, f.root, f.owner)
  else observeToolTerminal({ owner: f.owner, cwd: f.root, toolName: kind, toolUseId: `${kind}-check`,
    input: { command: 'bun test' }, ok: true, durationMs: 1, effect: undefined })
  check(`${kind} shell checks reach the record through the ledger`, (await finish(f)).data.outcome === 'succeeded')
}
const before = fixture()
evidence(before)
emit(before, 'git.stage', { paths: [], input: {}, toolName: 'Git' })
emit(before, 'file.edit', { outcome: 'failed', ok: false })
check('checks, staging and failed attempts before a landed change start no journal', (await status(before)).startsWith('Nothing recorded at this root'))

const outcomes = fixture()
emit(outcomes)
emit(outcomes, 'file.edit', { paths: [], outcome: 'no-change' })
emit(outcomes, 'file.edit', { outcome: 'indeterminate' })
emit(outcomes, 'file.edit', { outcome: 'failed', ok: false })
await finish(outcomes, 'failed')
check('capture preserves all outcome classes and adds no synthetic step', tx.latestTransaction(outcomes.root)?.steps.map(s => `${s.kind}/${s.outcome}`).join(',') === 'apply/ok,apply/info,apply/indeterminate,apply/failed')

const sameTime = fixture()
emit(sameTime)
const clock = Date.now
try {
  const now = clock()
  Date.now = () => now
  evidence(sameTime, false)
  evidence(sameTime, true)
} finally {
  Date.now = clock
}
const sameTimeResult = await finish(sameTime)
check('distinct ledger records at the same timestamp and mutation sequence both survive', sameTimeResult.data.outcome === 'succeeded' &&
  tx.latestTransaction(sameTime.root)?.steps.filter(s => s.kind === 'test').map(s => s.outcome).join(',') === 'failed,ok', sameTimeResult.data.result)

const disabled = fixture()
process.env.MERCURY_TX_AUTOCAPTURE = '0'
emit(disabled)
evidence(disabled)
await capture._drainTxAutoCaptureForTesting()
check('capture flag off creates no automatic record', tx.latestTransaction(disabled.root) === null && (await call(disabled, { op: 'status' })).data.result.startsWith('Nothing recorded'))
process.env.MERCURY_TX_AUTOCAPTURE = '1'

done('prove-transaction-capture')
