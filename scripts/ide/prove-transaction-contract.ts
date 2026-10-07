import { z } from 'zod/v4'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, fixture, emit, evidence, status, finish, done, call, tx, TransactionTool, projectHomeStore } from './transactionProof.js'

const prompt = `Shows and closes the record Mercury keeps of your work in this project. Optional: use it when the task wants a checked finish, or to see what has changed and what was checked.

You never write to the record. Every change a tool lands in this project (Edit, Write, ChangeSet, AstEdit, NotebookEdit, LSP writes, Structure, …) and every check that runs (tests, builds, type checks and lints run through Bash; Test, Launch and Journey runs) is recorded as it happens. Where Mercury finds no test or build setup, reading each changed file back in full counts as the check. A record starts with the first change after the last finish.

{ op: "status" } — what changed, which checks ran after the last change, and whether "completed" can land now.
{ op: "finish", verdict, unresolved? } — closes and saves the record. "completed" lands only when a check ran after the last change, the newest such check passed, and no change attempted after it failed or ended indeterminate; otherwise it is refused, the refusal names what is missing, and the record stays open. "failed" and "abandoned" always land. Put real remaining doubt in unresolved; it is kept word for word.`
const { $schema, ...schema } = z.toJSONSchema(TransactionTool.inputSchema)
check('T1 strict two-operation schema with only op, verdict, unresolved', JSON.stringify(Object.keys(schema.properties ?? {})) === '["op","verdict","unresolved"]' &&
  JSON.stringify((schema.properties?.op as { enum?: string[] })?.enum) === '["status","finish"]' &&
  JSON.stringify(schema.required) === '["op"]' && schema.additionalProperties === false, JSON.stringify(schema))
const validation = await TransactionTool.validateInput!({ op: 'finish' } as never, {} as never)
check('T4 finish still requires its verdict', !validation.result && validation.message === 'finish requires verdict: "completed" | "failed" | "abandoned".')
check('T5 status only is read-only, including the empty-input guard', TransactionTool.isReadOnly({ op: 'status' } as never) &&
  !TransactionTool.isReadOnly({ op: 'finish', verdict: 'failed' } as never) && !TransactionTool.isReadOnly({} as never))
const description = await TransactionTool.prompt({} as never)
const bytes = Buffer.byteLength(JSON.stringify({ name: 'Transaction', description, input_schema: schema, eager_input_streaming: true, defer_loading: true }))
check('T6 exact description and definition at most 1917 bytes', description === prompt && bytes <= 1917, `${bytes} bytes`)
console.log(`MEASURE Transaction definition ${bytes} bytes; description ${Buffer.byteLength(description)}; schema ${Buffer.byteLength(JSON.stringify(schema))}`)
check('surface guards retain deferral, strictness, output size, concurrency and replay', TransactionTool.shouldDefer === true && TransactionTool.strict === true &&
  TransactionTool.maxResultSizeChars === 40_000 && !TransactionTool.isConcurrencySafe({} as never) && !('outputSchema' in TransactionTool))

const noCheck = fixture(['one.txt'], true)
emit(noCheck)
const refused = await finish(noCheck)
const live = tx.latestTransaction(noCheck.root)
check('T7 refusal saves an open record and names the missing check', refused.data.outcome === 'failed' &&
  refused.data.result.startsWith('"completed" refused on tx-') && refused.data.result.includes('no check has run since the last change (file.edit: one.txt) — run the project\'s tests or build through Bash or Test; the result is recorded here by itself') && live?.verdict === 'open', refused.data.result)
check('T7 refusal keeps the effect shape for the generic error mapper', refused.effect?.outcome === 'failed' && refused.effect.operation === 'transaction.finish' && refused.effect.changedPaths.length === 0)
const { runToolUse } = await import('../../src/services/tools/toolExecution.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const wire = await runWithCwdOverride(noCheck.root, async () => {
  const context = { owner: noCheck.owner, abortController: new AbortController(), messages: [], readFileState: new Map(), toolDecisions: new Map(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }),
    setAppState: () => {}, options: { tools: [TransactionTool], mcpClients: [], isNonInteractiveSession: true } }
  const blocks: Array<{ type: string; content?: unknown; is_error?: boolean }> = []
  for await (const update of runToolUse({ type: 'tool_use', id: 'transaction-refusal', name: 'Transaction', input: { op: 'finish', verdict: 'completed' } },
    { uuid: 'tx-proof', requestId: 'tx-proof', message: { id: 'tx-proof' } } as never,
    (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never, context as never)) {
    const message = update.message as { message?: { content?: typeof blocks } }
    blocks.push(...(message.message?.content ?? []))
  }
  return blocks.find(block => block.type === 'tool_result')
})
check('T7 the real tool-call path marks the completion refusal is_error', wire?.is_error === true && String(wire.content).includes('"completed" refused on tx-'), JSON.stringify(wire))

const retry = fixture()
emit(retry)
evidence(retry, false)
await status(retry)
evidence(retry, true)
const retried = await finish(retry)
check('T8 newest passing check clears the earlier failed check without another edit', retried.data.outcome === 'succeeded' && retried.data.result.startsWith('Finished tx-') && retried.data.result.includes('as completed.'), retried.data.result)

for (const outcome of ['failed', 'indeterminate'] as const) {
  const f = fixture()
  emit(f)
  evidence(f)
  emit(f, 'file.edit', { outcome, ok: outcome !== 'failed' })
  const result = await finish(f)
  check(`T9 ${outcome} change after the landed one still blocks completion`, result.data.outcome === 'failed' && result.data.result.includes(`a change after the last landed one ended ${outcome} (file.edit: one.txt)`), result.data.result)
  const closed = await finish(f, 'failed', ['u1'])
  check('T10 failed finish keeps unresolved verbatim and is no-change', closed.data.outcome === 'no-change' && tx.latestTransaction(f.root)?.unresolved.at(-1) === 'u1')
}
const empty = fixture()
check('T11 nothing to finish keeps the exact result', (await finish(empty)).data.result === 'Nothing to finish — no transaction is open at this root.')

const old = fixture()
const oldRecord = { _v: 1, id: 'tx-1791200000000-19be44', intent: 'fix the cart total rounding', owner: old.owner,
  projectRoot: old.root, verdict: 'open', steps: [
    { kind: 'diagnose', at: 1, summary: 'rounding issue', refs: [], outcome: 'info' },
    { kind: 'apply', at: 2, summary: 'patched roundTotal', refs: [], outcome: 'ok' },
    { kind: 'test', at: 3, summary: 'tests pass', refs: [], outcome: 'ok' },
  ], unresolved: [], openedAt: 1 }
const store = projectHomeStore(old.root, 'ide-transactions')
mkdirSync(store, { recursive: true })
for (const file of [oldRecord.id, 'latest']) writeFileSync(join(store, `${file}.json`), JSON.stringify(oldRecord))
const oldStatus = await status(old)
const expected = `${oldRecord.id} [open] fix the cart total rounding
root ${old.root} · 1 change(s) · 1 check(s) · 3 step(s), 3 of them noted by hand on an older build
Changes (newest last):
  [ok] apply — patched roundTotal
Checks since the last change:
  [ok] test — tests pass
"completed" cannot land yet:
  - the last change carries no mercury://receipt ref (a record from an older build) — finish it with verdict "abandoned"; the next change starts a new record
mercury://ide/transaction/${oldRecord.id}`
check('T12 historical record decodes and prints the exact compatibility shape', oldStatus === expected, oldStatus)
check('T12 historical apply without receipt cannot complete', (await finish(old)).data.outcome === 'failed')
check('T12 historical record can be abandoned', (await finish(old, 'abandoned')).data.outcome === 'no-change')
const allKinds = { ...oldRecord, id: 'tx-all-kinds', steps: tx.TX_STEP_KINDS.map(kind => ({ kind, at: 1, summary: kind, refs: [], outcome: 'info' })) }
writeFileSync(join(store, `${allKinds.id}.json`), JSON.stringify(allKinds))
check('all thirteen historical kinds remain decodable', tx.TX_STEP_KINDS.length === 13 && tx.getTransaction(allKinds.id, old.root)?.steps.length === 13)

const root = fixture()
emit(root)
await finish(root)
const another = { ...root, owner: `${root.owner}-other` as typeof root.owner }
check('status reports saved receipts invisible to another owner without replay', (await status(another)).includes('receipt not visible here (earlier process or another agent): re-read before relying on it'))
evidence(root)
await finish(root)
check('status after finish names the latest saved record, not a new journal', (await status(root)).startsWith('Nothing recorded at this root since the last finish.') && (await status(root)).includes('Latest record:'))
emit(root)
check('next change after finish opens an unsaved record', (await status(root)).startsWith('unsaved record [open]'))

const dropped = fixture()
const windowed = await tx.openTransaction({ owner: dropped.owner, intent: 'window loses anchor', from: dropped.root })
for (let n = 0; n < 101; n++) await tx.noteStep({ id: windowed.id, owner: dropped.owner, from: dropped.root, kind: n === 0 ? 'apply' : 'test', summary: 'window', outcome: 'ok' })
check('a dropped landed change cannot manufacture completion', tx.completionGapsFor(tx.getTransaction(windowed.id, dropped.root)!).some(gap => gap.startsWith('no change has landed')))

done('prove-transaction-contract')
