import { extname } from 'node:path'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, formatDiagnosticLine, countBySeverity, syncFileFromDisk } from './shared.js'
import { remedyForUnclaimedExtension, pullFileDiagnostics, unavailableWords } from './pull.js'
import { inputRange, lineRangesOverlap, CODE_ACTION_RERUN_HINT, opCodeActions } from './codeActions.js'

export async function opFixDiagnostic(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const before = await pullFileDiagnostics(env.manager, env.absolutePath)
  if (before.kind === 'unsupported') {
    return {
      result: `fixDiagnostic needs pull diagnostics, which the language server for ${display} does not support — use codeActions directly.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'pull diagnostics unsupported',
      },
    }
  }
  if (before.kind === 'protocol-violation') {
    return {
      result: `fixDiagnostic is indeterminate for ${display}: ${before.detail} — cannot establish the before picture.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'indeterminate',
        changedPaths: [],
        evidence: 'before picture indeterminate',
      },
    }
  }
  if (before.kind === 'no-claimant') {
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result:
        `fixDiagnostic is unavailable for ${display}: no language server claims '${extension}'. ` +
        remedyForUnclaimedExtension(extension, env.cwd),
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: `no language server claims '${extension}'`,
      },
    }
  }
  if (before.kind === 'unavailable') {
    const words = unavailableWords(before.failed, env.absolutePath, env.cwd)
    return {
      result: `fixDiagnostic was not run for ${display}: ${words.what}.${words.remedy ? ` What helps: ${words.remedy}.` : ''}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: words.what,
        details: { serverFailures: words.servers },
      },
    }
  }
  const range = inputRange(input)
  const targets = before.items.filter(item => lineRangesOverlap(item.range, range))
  if (targets.length === 0) {
    return {
      result: `No diagnostics at ${display}:${input.line ?? 1} — nothing to fix.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'nothing to fix',
      },
    }
  }
  const beforeCounts = countBySeverity(before.items)
  const picture = `${targets.length} diagnostic(s) at the position (file has ${beforeCounts.errors} error(s)):\n${targets
    .map(item => `  ${formatDiagnosticLine(display, item)}`)
    .join('\n')}`

  const fixRerunHint =
    'Re-run fixDiagnostic with apply: true and actionId to apply a fix (or apply: true alone when exactly one edit-shaped fix is offered).'

  if (input.apply !== true) {
    const listing = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: false },
    })
    const rewritten = listing.result.replace(CODE_ACTION_RERUN_HINT, fixRerunHint)
    return {
      ...listing,
      result: `${picture}\n${rewritten}`,
    }
  }

  const delegate = await opCodeActions({
    ...env,
    input: { ...input, operation: 'codeActions', apply: true },
  })
  let applied = delegate
  if (
    input.actionId === undefined &&
    delegate.effect.outcome === 'failed' &&
    delegate.result.includes('apply: true requires actionId')
  ) {
    const listing = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: false },
    })
    const editRows = [...listing.result.matchAll(/id:(ca-[0-9a-f]{8}).*— edit$/gm)]
    if (editRows.length !== 1) {
      return {
        result: `${picture}\nfixDiagnostic needs a selection: ${editRows.length} edit-shaped fixes are offered. ${listing.result.replace(CODE_ACTION_RERUN_HINT, fixRerunHint)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `selection required (${editRows.length} candidates)`,
        },
      }
    }
    applied = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: true, actionId: editRows[0]![1]! },
    })
  }
  if (applied.applied !== true) {
    return applied
  }

  let movement: string
  let afterErrors: number | undefined
  try {
    const after = await pullFileDiagnostics(env.manager, env.absolutePath)
    if (after.kind === 'fresh' || after.kind === 'unchanged') {
      afterErrors = countBySeverity(after.items).errors
      const suffix =
        afterErrors < beforeCounts.errors
          ? ' ✓'
          : afterErrors > beforeCounts.errors
            ? ' — the fix INTRODUCED errors, inspect'
            : ' (unchanged count)'
      movement = `errors before: ${beforeCounts.errors} → after: ${afterErrors}${suffix}`
    } else {
      movement = `errors before: ${beforeCounts.errors} → after: indeterminate (re-pull ${after.kind})`
    }
  } catch (error) {
    movement = `errors before: ${beforeCounts.errors} → after: indeterminate (re-pull failed: ${error instanceof Error ? error.message : String(error)})`
  }
  return {
    ...applied,
    result: `${applied.result}\n${movement}`,
    effect: {
      ...applied.effect,
      evidence: `${applied.effect.evidence}; ${movement}`,
      details: {
        ...(applied.effect.details ?? {}),
        beforeErrors: beforeCounts.errors,
        ...(afterErrors !== undefined ? { afterErrors } : {}),
      },
    },
  }
}
