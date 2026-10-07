import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import {
  completionGapsFor, finishTransaction, getTransaction, isCheckStep, lastLandedChangeIndex,
  latestTransaction, openTransactionIdFor, type TxRecord, type TxStep,
} from '../../services/ide/ideTransaction.js'
import { clearTxJournal, inTxCaptureLane, saveTxJournal, txJournalFor } from '../../services/ide/txAutoCapture.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'

export const TRANSACTION_TOOL_NAME = 'Transaction'
const OPS = ['status', 'finish'] as const
const FINISH_VERDICTS = ['completed', 'failed', 'abandoned'] as const
const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('status: what changed, which checks ran since the last change, whether "completed" can land · finish: close and save the record'),
    verdict: z.enum(FINISH_VERDICTS).optional().describe('finish (required there): "completed" is refused until a check after the last change passed; "failed" and "abandoned" always land'),
    unresolved: z.array(z.string()).optional().describe('finish: real remaining doubt, kept word for word on the record'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = { op: Input['op']; result: string; outcome: ToolEffectOutcome }

function refLine(id: string): string {
  return `mercury://ide/transaction/${id}`
}

function stepText(step: TxStep): string {
  return step.auto ? step.summary.replace(/^\[auto\] /, '') : `${step.kind} — ${step.summary}`
}

async function describeRecord(record: TxRecord, owner: OwnerKey, context: ToolUseContext): Promise<string> {
  const changes = record.steps.filter(step => step.kind === 'apply')
  const landed = changes.filter(step => step.outcome === 'ok').length
  const checks = record.steps.filter(isCheckStep)
  const manual = record.steps.filter(step => !step.auto).length
  const lines = [
    `${record.id || 'unsaved record'} [${record.verdict}] ${record.intent}`,
    `root ${record.projectRoot} · ${landed} change(s) · ${checks.length} check(s) · ${record.steps.length} step(s), ${manual ? `${manual} of them noted by hand on an older build` : 'recorded automatically'}${record.elided ? ` · ${record.elided} earlier step(s) dropped` : ''}`,
    'Changes (newest last):',
  ]
  const { resolveResource } = await import('../../services/resources/registry.js')
  for (const step of changes.slice(-8)) {
    const refs = step.refs.filter(ref => ref.startsWith('mercury://receipt/'))
    let stale = false
    for (const ref of refs) {
      const resolved = await resolveResource(ref, { owner, cwd: record.projectRoot, getAppState: context.getAppState })
      if (resolved.state !== 'ok') stale = true
    }
    lines.push(`  [${step.outcome}] ${stepText(step)}${refs.length ? ` (${refs.join(', ')})` : ''}${stale ? ' — receipt not visible here (earlier process or another agent): re-read before relying on it' : ''}`)
  }
  if (changes.length > 8) lines.push(`  … ${changes.length - 8} earlier change(s) not shown`)
  const last = lastLandedChangeIndex(record.steps)
  lines.push(last < 0 ? 'Checks:' : 'Checks since the last change:')
  const after = record.steps.slice(last + 1).filter(step => step.kind === 'test' || step.kind === 'build' || step.kind === 'verify')
  for (const step of after.slice(-8)) lines.push(`  [${step.outcome}] ${stepText(step)}`)
  if (!after.length) lines.push('  (none yet)')
  if (after.length > 8) lines.push(`  … ${after.length - 8} earlier check(s) not shown`)
  if (record.verdict === 'open') {
    const gaps = completionGapsFor(record)
    if (gaps.length) {
      lines.push('"completed" cannot land yet:', ...gaps.map(gap => `  - ${gap}`))
    } else {
      lines.push('"completed" can land now: { op: "finish", verdict: "completed" }.')
    }
  }
  if (record.unresolved.length) lines.push('Unresolved:', ...record.unresolved.map(item => `  - ${item}`))
  lines.push(record.id ? refLine(record.id) : 'Saved as mercury://ide/transaction/<id> when you finish.')
  return lines.join('\n')
}

async function runStatus(from: string, owner: OwnerKey, context: ToolUseContext): Promise<Output> {
  const id = openTransactionIdFor(from)
  const record = id ? getTransaction(id, from) : txJournalFor(from)
  if (record) return { op: 'status', result: await describeRecord(record, owner, context), outcome: 'no-change' }
  const latest = latestTransaction(from)
  return {
    op: 'status', outcome: 'no-change',
    result: 'Nothing recorded at this root since the last finish. Changes (Edit, Write, ChangeSet, AstEdit, NotebookEdit, LSP writes, Structure) and checks (Bash or Test runs) are recorded here as they happen.' +
      (latest ? `\nLatest record: ${latest.id} [${latest.verdict}] ${latest.intent} — ${refLine(latest.id)}` : ''),
  }
}

async function runFinish(input: Input, from: string, owner: OwnerKey, context: ToolUseContext): Promise<Output> {
  const id = openTransactionIdFor(from) ?? (await saveTxJournal(from, owner))?.id
  if (!id) return { op: 'finish', result: 'Nothing to finish — no transaction is open at this root.', outcome: 'no-change' }
  const finished = await finishTransaction({ id, owner, verdict: input.verdict!, from, unresolved: input.unresolved })
  if (finished.state !== 'ok') {
    const result = finished.missing.length
      ? [`"completed" refused on ${id}: ${finished.missing.length} thing(s) missing.`,
        ...finished.missing.map(gap => `  - ${gap}`),
        'The record stays open and keeps recording. To close it now, finish with verdict "failed" or "abandoned" and name what is left in unresolved.',
        refLine(id)].join('\n')
      : finished.reason
    return { op: 'finish', result, outcome: 'failed' }
  }
  clearTxJournal(from)
  return {
    op: 'finish', outcome: finished.record.verdict === 'completed' ? 'succeeded' : 'no-change',
    result: `Finished ${id} as ${finished.record.verdict}.\n${await describeRecord(finished.record, owner, context)}`,
  }
}

export const TransactionTool = buildTool({
  name: TRANSACTION_TOOL_NAME,
  searchHint: 'see what changed and was checked; finish the work only after a passing check',
  maxResultSizeChars: 40_000,
  strict: true,
  shouldDefer: true,
  async description() {
    return 'Show or close the automatic record of the changes and checks in this project'
  },
  async prompt() {
    return `Shows and closes the record Mercury keeps of your work in this project. Optional: use it when the task wants a checked finish, or to see what has changed and what was checked.

You never write to the record. Every change a tool lands in this project (Edit, Write, ChangeSet, AstEdit, NotebookEdit, LSP writes, Structure, …) and every check that runs (tests, builds, type checks and lints run through Bash; Test, Launch and Journey runs) is recorded as it happens. Where Mercury finds no test or build setup, reading each changed file back in full counts as the check. A record starts with the first change after the last finish.

{ op: "status" } — what changed, which checks ran after the last change, and whether "completed" can land now.
{ op: "finish", verdict, unresolved? } — closes and saves the record. "completed" lands only when a check ran after the last change, the newest such check passed, and no change attempted after it failed or ended indeterminate; otherwise it is refused, the refusal names what is missing, and the record stays open. "failed" and "abandoned" always land. Put real remaining doubt in unresolved; it is kept word for word.`
  },
  userFacingName,
  get inputSchema(): SchemaType { return inputSchema() },
  isConcurrencySafe() { return false },
  isReadOnly(input: Input) { return input.op === 'status' },
  async validateInput(input: Input) {
    if (input.op === 'finish' && input.verdict == null) {
      return { result: false as const, behavior: 'ask' as const,
        message: 'finish requires verdict: "completed" | "failed" | "abandoned".', errorCode: 1 }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input): Promise<PermissionDecision> {
    return { behavior: 'allow', updatedInput: input }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const from = getCwd()
    const owner = ownerFromToolUseContext(context)
    let output: Output
    try {
      output = await inTxCaptureLane(from, () => input.op === 'status'
        ? runStatus(from, owner, context) : runFinish(input, from, owner, context))
    } catch (err) {
      output = { op: input.op, outcome: 'failed',
        result: `${input.op} failed: ${err instanceof Error ? err.message : String(err)} — run { op: "status" } to see what the record holds now` }
    }
    return {
      data: output,
      effect: { outcome: output.outcome, operation: `transaction.${input.op}`, changedPaths: [],
        evidence: output.result.split('\n')[0]?.slice(0, 200) ?? '', startedAt, completedAt: Date.now() },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return { tool_use_id: toolUseId, type: 'tool_result' as const, content: output.result }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText(output: Output) { return output.result ?? '' },
})
