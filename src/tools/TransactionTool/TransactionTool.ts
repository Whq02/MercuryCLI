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
import { checkUncPathPermission } from '../../utils/permissions/filesystem.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'

export const TRANSACTION_TOOL_NAME = 'Transaction'
const OPS = ['status', 'finish'] as const
const FINISH_VERDICTS = ['completed', 'failed', 'abandoned'] as const
const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('status: show the record · finish: close and save it'),
    verdict: z.enum(FINISH_VERDICTS).optional().describe('finish, required: "completed", "failed" or "abandoned"'),
    unresolved: z.array(z.string()).optional().describe('finish: real remaining doubt, kept word for word on the record'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
type Input = z.infer<SchemaType>
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
    return `Shows or closes the record Mercury keeps of the work in this project: every change a tool lands and every check that runs — tests, builds, type checks and lints — is recorded as it happens, nothing is written to it by hand, and a record starts with the first change after the last finish; where the project has no test or build setup, reading each changed file back in full counts as the check. status returns what changed, which checks ran after the last change and whether "completed" can land now. finish closes and saves the record with its verdict: "completed" lands only when the newest check after the last change passed and no later change attempt failed or ended indeterminate, and the record stays open otherwise; "failed" and "abandoned" always land.`
  },
  userFacingName,
  get inputSchema(): SchemaType { return inputSchema() },
  isConcurrencySafe() { return false },
  isReadOnly(input: Input) { return input.op === 'status' },
  async validateInput(input: Input) {
    if (input.op === 'finish' && input.verdict == null) {
      return { result: false as const,
        message: 'finish requires verdict: "completed" | "failed" | "abandoned".', errorCode: 1 }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input, context: ToolUseContext): Promise<PermissionDecision> {
    const from = getCwd()
    const permissionContext = context.getAppState().toolPermissionContext
    const remote = checkUncPathPermission(from, permissionContext)
    if (remote && remote.behavior !== 'allow') return remote
    const id = openTransactionIdFor(from)
    const record = id ? getTransaction(id, from) : txJournalFor(from) ?? latestTransaction(from)
    if (record) {
      const remote = checkUncPathPermission(record.projectRoot, permissionContext)
      if (remote && remote.behavior !== 'allow') return remote
    }
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
