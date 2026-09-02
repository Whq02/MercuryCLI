// ============================================================================
//  Transaction tool — the closed-loop IDE transaction surface.
//
//  ONE op-dispatched call over the durable evidence binder
//  (services/ide/ideTransaction.ts). This tool RUNS NOTHING and touches no
//  project files: it binds records in the transaction store, resolves
//  evidence refs read-only, and prints record projections. Every law lives
//  in the service (ref honesty at note time · the mechanical completion
//  gate · report-never-replay resume); this module owns the model surface,
//  per-op pre-call validation, the shared record formatter, and the typed
//  effect envelope. `transaction.*` operations are deliberately absent from
//  the auto-capture operation registry — a Transaction call must never
//  auto-note itself.
//
//  Gate: MERCURY_IDE_LOOP (default-ON; the catalog consumes the service's
//  ideLoopEnabled — re-exported below as the catalog-gate alias).
//  Capability: the estate table row keyed 'Transaction' (declarations.ts).
//  Proof: scripts/ide/prove-closed-loop.ts.
// ============================================================================

import { z } from 'zod/v4'
// Side-effect mount: the auto-capture subscriber arms at module scope (its
// registry deliberately excludes transaction.* — see the header note).
// Dropping this import severs the loop silently; the dist pins red on it.
import '../../services/ide/txAutoCapture.js'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import {
  completionGapsFor,
  finishTransaction,
  getTransaction,
  ideLoopEnabled,
  latestTransaction,
  listTransactions,
  noteStep,
  openTransaction,
  openTransactionIdFor,
  resumeTransaction,
  TX_STEP_KINDS,
  type TxRecord,
} from '../../services/ide/ideTransaction.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

export const TRANSACTION_TOOL_NAME = 'Transaction'

const OPS = ['begin', 'step', 'status', 'finish', 'resume', 'list'] as const

// The step-outcome and finish-verdict vocabularies are service law; the
// literals here feed the wire schema and are typechecked against the
// service's own types at every delegation site below.
const STEP_OUTCOMES = ['ok', 'failed', 'indeterminate', 'info'] as const
const FINISH_VERDICTS = ['completed', 'failed', 'abandoned'] as const

/** Steps shown by the record formatter; earlier steps collapse to a count. */
const SHOWN_STEPS = 12

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('The transaction operation'),
    id: z
      .string()
      .optional()
      .describe(
        'Target transaction id (default: the open transaction at the current root, else the latest record)',
      ),
    intent: z
      .string()
      .optional()
      .describe('begin (REQUIRED there): one line naming what this loop sets out to do'),
    kind: z
      .enum(TX_STEP_KINDS)
      .optional()
      .describe('step (REQUIRED there): the loop step kind'),
    summary: z
      .string()
      .optional()
      .describe(
        'step (REQUIRED there): one honest line of what actually happened (bounded ~300 chars)',
      ),
    refs: z
      .array(z.string())
      .optional()
      .describe(
        'step: mercury:// evidence refs — each must resolve RIGHT NOW or the whole note refuses',
      ),
    outcome: z
      .enum(STEP_OUTCOMES)
      .optional()
      .describe('step: how the step landed (default "ok")'),
    verdict: z
      .enum(FINISH_VERDICTS)
      .optional()
      .describe(
        'finish (REQUIRED there): "completed" refuses while completion gaps remain; "failed"/"abandoned" always land',
      ),
    unresolved: z
      .array(z.string())
      .optional()
      .describe('finish: real remaining uncertainty, preserved verbatim on the record'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
}

// ── the shared record formatter ─────────────────────────────────────────────

function refLine(id: string): string {
  return `mercury://ide/transaction/${id}`
}

function stepLine(step: TxRecord['steps'][number]): string {
  const refs = step.refs.length > 0 ? ` (refs: ${step.refs.join(', ')})` : ''
  return `  [${step.outcome}] ${step.kind} — ${step.summary}${refs}`
}

function describeRecord(record: TxRecord): string {
  const lines: string[] = [
    `${record.id} [${record.verdict}] ${record.intent}`,
    `root ${record.projectRoot} · ${record.steps.length} step(s)`,
  ]
  for (const step of record.steps.slice(-SHOWN_STEPS)) lines.push(stepLine(step))
  if (record.steps.length > SHOWN_STEPS) {
    lines.push(`  … ${record.steps.length - SHOWN_STEPS} earlier step(s) elided`)
  }
  if (record.verdict === 'open') {
    const gaps = completionGapsFor(record)
    if (gaps.length > 0) {
      lines.push('Outstanding for completion:')
      for (const gap of gaps) lines.push(`  - ${gap}`)
    } else {
      lines.push(
        'Completion gate satisfied — finish with { op: "finish", verdict: "completed" }.',
      )
    }
  }
  if (record.unresolved.length > 0) {
    lines.push('Unresolved:')
    for (const item of record.unresolved) lines.push(`  - ${item}`)
  }
  lines.push(refLine(record.id))
  return lines.join('\n')
}

// ── op implementations ──────────────────────────────────────────────────────

interface OpResult {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
}

const BEGIN_HINT = 'No transaction here yet — begin one with { op: "begin", intent: "…" }.'

/** Default-target law: explicit id, else the open transaction at this
 *  root, else the latest record. Null when the root has no records. */
function resolveTargetId(explicitId: string | undefined, from: string): string | null {
  if (explicitId != null) return explicitId
  return openTransactionIdFor(from) ?? latestTransaction(from)?.id ?? null
}

async function runBegin(input: Input, owner: OwnerKey, from: string): Promise<OpResult> {
  const record = await openTransaction({ owner, intent: input.intent!, from })
  return {
    op: 'begin',
    result:
      `${describeRecord(record)}\n` +
      'Do the work through the normal tools and note evidence with { op: "step" } — completion is mechanically gated, so { op: "finish", verdict: "completed" } lands only once the gaps close.',
    outcome: 'succeeded',
  }
}

async function runStep(input: Input, owner: OwnerKey, from: string): Promise<OpResult> {
  const id = resolveTargetId(input.id, from)
  if (id === null) {
    return {
      op: 'step',
      result:
        'No transaction to note against — begin first with { op: "begin", intent: "…" }.',
      outcome: 'failed',
    }
  }
  const noted = await noteStep({
    id,
    owner,
    kind: input.kind!,
    summary: input.summary!,
    ...(input.refs != null && { refs: input.refs }),
    ...(input.outcome != null && { outcome: input.outcome }),
    from,
  })
  if (noted.state !== 'ok') {
    // The service's refusal reason is the result verbatim (missing record ·
    // not-open verdict · step cap · a ref that does not resolve).
    return { op: 'step', result: noted.reason, outcome: 'failed' }
  }
  return {
    op: 'step',
    result:
      `Noted [${input.outcome ?? 'ok'}] ${input.kind} on ${id} (${noted.record.steps.length} step(s)).\n` +
      refLine(id),
    outcome: 'succeeded',
  }
}

function runStatus(input: Input, from: string): OpResult {
  const id = resolveTargetId(input.id, from)
  const record = id === null ? null : getTransaction(id, from)
  if (record === null) {
    return {
      op: 'status',
      result:
        input.id != null ? `No transaction '${input.id}' at this root. ${BEGIN_HINT}` : BEGIN_HINT,
      outcome: 'no-change',
    }
  }
  return { op: 'status', result: describeRecord(record), outcome: 'no-change' }
}

async function runFinish(input: Input, owner: OwnerKey, from: string): Promise<OpResult> {
  const id = resolveTargetId(input.id, from)
  if (id === null) {
    return {
      op: 'finish',
      result: 'No transaction to finish — begin first with { op: "begin", intent: "…" }.',
      outcome: 'failed',
    }
  }
  const finished = await finishTransaction({
    id,
    owner,
    verdict: input.verdict!,
    ...(input.unresolved != null && { unresolved: input.unresolved }),
    from,
  })
  if (finished.state !== 'ok') {
    // A refused completion names every missing gate leg in its reason.
    return { op: 'finish', result: finished.reason, outcome: 'failed' }
  }
  return {
    op: 'finish',
    result: describeRecord(finished.record),
    outcome: finished.record.verdict === 'completed' ? 'succeeded' : 'no-change',
  }
}

async function runResume(input: Input, owner: OwnerKey, from: string): Promise<OpResult> {
  const id = resolveTargetId(input.id, from)
  const resumed = id === null ? null : await resumeTransaction({ id, owner, from })
  if (resumed === null) {
    return {
      op: 'resume',
      result:
        input.id != null
          ? `No transaction '${input.id}' to resume at this root. ${BEGIN_HINT}`
          : BEGIN_HINT,
      outcome: 'no-change',
    }
  }
  const lines = [describeRecord(resumed.record)]
  if (resumed.applyRefChecks.length > 0) {
    lines.push('Apply-ref liveness (nothing was replayed — records are evidence, not actions):')
    for (const check of resumed.applyRefChecks) {
      lines.push(`  [${check.resolves ? 'live' : 'stale'}] ${check.ref} — ${check.note}`)
    }
  } else {
    lines.push('No apply refs to re-verify. Nothing was replayed.')
  }
  return { op: 'resume', result: lines.join('\n'), outcome: 'no-change' }
}

function runList(from: string): OpResult {
  const rows = listTransactions(from)
  if (rows.length === 0) {
    return { op: 'list', result: 'No transactions recorded at this root yet.', outcome: 'no-change' }
  }
  const lines = [`${rows.length} transaction(s), newest first:`]
  for (const row of rows) lines.push(`  ${row.id} [${row.verdict}] ${row.intent}`)
  return { op: 'list', result: lines.join('\n'), outcome: 'no-change' }
}

// ── the tool ────────────────────────────────────────────────────────────────

export const TransactionTool = buildTool({
  name: TRANSACTION_TOOL_NAME,
  searchHint: 'bind a coding loop into one gated evidence transaction record',
  maxResultSizeChars: 40_000,
  strict: true,
  shouldDefer: true,
  async description() {
    return 'Bind one coding loop into a durable evidence record with a mechanically gated completion verdict'
  },
  async prompt() {
    return `The closed-loop coding transaction: ONE durable evidence record binding a coding loop. You still do the real work through the normal tools (Edit, Test, Bash, LSP, …) — this tool runs nothing and only binds what already happened.

Operations:
1. { op: "begin", intent } — open a durable record at the resolved project root.
2. { op: "step", kind, summary, refs?, outcome? } — note one loop step. kind is one of: profile · diagnose · select · context · propose · preview · apply · stabilize · format · test · build · debug · verify. outcome is one of: ok (default) · failed · indeterminate · info. Every mercury:// ref is resolved AT NOTE TIME — an unresolvable or stale ref refuses the whole note, so fabricated evidence can never enter the record. While a transaction is open, ordinary apply/test/build/debug/verify tool effects auto-note themselves (default-on auto-capture, exactly-once); note manually what the observers cannot see.
3. { op: "status", id? } — describe the record; an open record lists its outstanding completion gaps.
4. { op: "finish", verdict, unresolved? } — verdict "completed" is MECHANICALLY gated: an ok apply step carrying a mercury://receipt ref · a stabilize step after it · an ok test/build/verify step after it · no failed step after it. A refusal names every missing leg. "failed"/"abandoned" always land. Name real remaining uncertainty in unresolved — it is preserved verbatim, never dropped.
5. { op: "resume", id? } — after a restart: re-reads the durable record and reports per-apply-ref liveness (live/stale). NOTHING is replayed; a stale receipt ref means re-verify against current files.
6. { op: "list" } — bounded id/verdict/intent rows for this root, newest first.

id defaults to the open transaction at the current root, else the latest record. Steps cap at 100 per record — finish and begin a new loop rather than growing one forever. Not concurrency-safe: one record mutation at a time.`
  },
  userFacingName,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  toAutoClassifierInput(input: Input) {
    const detail = input.intent ?? input.kind ?? input.verdict ?? input.id ?? ''
    return `transaction ${input.op}: ${detail}`
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return input.op === 'status' || input.op === 'resume' || input.op === 'list'
  },
  async validateInput(input: Input) {
    // `== null` deliberately: a provider that serializes an omitted optional
    // as `null` must read as ABSENT (the ChangeSet belt for the same class).
    if (input.op === 'begin' && input.intent == null) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'begin requires intent — one line naming what this transaction sets out to do.',
        errorCode: 1,
      }
    }
    if (input.op === 'step') {
      const missing = [
        ...(input.kind == null ? ['kind'] : []),
        ...(input.summary == null ? ['summary'] : []),
      ]
      if (missing.length > 0) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: `step requires ${missing.join(' and ')}.`,
          errorCode: 1,
        }
      }
    }
    if (input.op === 'finish' && input.verdict == null) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'finish requires verdict: "completed" | "failed" | "abandoned".',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input): Promise<PermissionDecision> {
    // Always-allow: binds records in its own project store, executes
    // nothing, resolves evidence refs read-only.
    return { behavior: 'allow', updatedInput: input }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const from = getCwd()
    const owner = ownerFromToolUseContext(context)
    let op: OpResult
    try {
      switch (input.op) {
        case 'begin':
          op = await runBegin(input, owner, from)
          break
        case 'step':
          op = await runStep(input, owner, from)
          break
        case 'status':
          op = runStatus(input, from)
          break
        case 'finish':
          op = await runFinish(input, owner, from)
          break
        case 'resume':
          op = await runResume(input, owner, from)
          break
        case 'list':
          op = runList(from)
          break
      }
    } catch (err) {
      // Contract violations come back as typed refusals; only a genuine
      // fault lands here — surfaced as a failed result, never thrown.
      op = {
        op: input.op,
        result: `${input.op} failed: ${err instanceof Error ? err.message : String(err)}`,
        outcome: 'failed',
      }
    }
    const output: Output = { op: op.op, result: op.result, outcome: op.outcome }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: `transaction.${input.op}`,
        changedPaths: [],
        evidence: op.result.split('\n')[0]?.slice(0, 200) ?? '',
        startedAt,
        completedAt: Date.now(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // The renderer paints `result`; search indexes the same text.
  extractSearchText(output: Output) {
    return output.result ?? ''
  },
})

// The catalog-gate alias (the ChangeSet convention: the tool module
// re-exports its service gate under the catalog-facing name).
