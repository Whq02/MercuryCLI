import { runVerbatimTextCommit, type CommitOutcome } from '../../engines/change-transaction/changeSetCommit.js'
import { dropSeenLines } from '../../engines/change-transaction/seenLines.js'
import { mintFileAnchor } from '../../engines/change-transaction/snapshotAnchor.js'
import { rememberAnchoredSnapshot } from '../../engines/change-transaction/snapshotRing.js'
import { type NormalizedFileEdits } from '../../../integrations/lsp/workspaceEditApply.js'
import { noteRunEvent } from '../../../engine/run/runCoordinator.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getFileModificationTime } from '../../../platform/files/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../engines/change-transaction/fileHistory.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { checkWritePermissionForTool, pathInAllowedWorkingPath } from '../../../permissions/rules/filesystem.js'
import { modeBypassesPermissions } from '../../../permissions/rules/permissionMode.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, uriToFilePath } from './shared.js'
import { syncServersAfterWrites, awaitDiagnosticStabilization } from './afterWrite.js'
import { changeViewOf, planFiles, planTokenOf, editRowsFor, type PlannedFile } from './preview.js'
import { readKnowledgeHolds, touchedLinesOf } from './readKnowledge.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

type AppliedOutcome = {
  output: MercuryLspOpOutput
  writtenPaths: string[]
}

function planRefusalOf(
  env: OpEnv,
  token: string,
  planned: PlannedFile[],
  plannedFiles: NormalizedFileEdits[],
  snapshots: Map<string, string>,
): AppliedOutcome | null {
  const givenPlan = env.input.plan?.trim()
  if (givenPlan !== undefined && givenPlan !== '') {
    if (givenPlan !== token) {
      return {
        output: {
          result: `Apply refused: plan ${givenPlan} no longer matches the edit set — a file changed since that dry run (the set is now ${planned.length} file(s)); re-run the dry run, read it, and apply the plan it prints. Nothing was written.`,
          resultCount: 0,
          fileCount: 0,
          applied: false,
          effect: { outcome: 'failed', changedPaths: [], evidence: 'stale plan — nothing written', details: { applyRefusal: true } },
        },
        writtenPaths: [],
      }
    }
  } else {
    const unread: string[] = []
    for (const file of plannedFiles) {
      const abs = uriToFilePath(file.uri)
      if (file.create === true) continue
      if (readKnowledgeHolds(env, abs, snapshots.get(abs) ?? '', touchedLinesOf(file))) continue
      const lines = touchedLinesOf(file)
      const first = Math.min(...lines.map(range => range.start))
      const last = Math.max(...lines.map(range => range.end))
      unread.push(`  ${displayPathFor(env.cwd, abs)} (lines ${first === last ? first : `${first}-${last}`})`)
    }
    if (unread.length > 0) {
      return {
        output: {
          result:
            `Apply refused — the read-before-edit law: ${unread.length} touched file(s) were not read in this session as they stand now:\n${unread.join('\n')}\n` +
            `Read them (a Read covering the lines each edit touches), or attest the exact edit set: run the dry run (apply omitted), read it, and re-run with apply: true and the plan it prints. Nothing was written.`,
          resultCount: 0,
          fileCount: 0,
          applied: false,
          effect: { outcome: 'failed', changedPaths: [], evidence: 'read-before-edit refusal — nothing written', details: { applyRefusal: true } },
        },
        writtenPaths: [],
      }
    }
  }
  return null
}

function commitFailureOf(env: OpEnv, commit: CommitOutcome, planned: PlannedFile[]): AppliedOutcome | null {
  if (commit.kind === 'stale') {
    const first = commit.stalePaths[0] ?? planned[0]!.abs
    return {
      output: {
        result: `Apply aborted: disk drift detected at ${displayPathFor(env.cwd, first)} — the file changed after the edit was computed; nothing was written. Re-run the operation against the current contents.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'drift abort — nothing written',
          details: { applyRefusal: true },
        },
      },
      writtenPaths: [],
    }
  }
  if (commit.kind === 'cancelled' || commit.kind === 'in-flight') {
    return {
      output: {
        result: `Apply aborted before commit (${commit.kind}); nothing was written.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `aborted before commit (${commit.kind})`,
        },
      },
      writtenPaths: [],
    }
  }
  if (commit.kind === 'failed-restored') {
    logError(new Error(`lsp apply failed-restored: ${commit.reason}`))
    return {
      output: {
        result: `Apply FAILED: ${commit.reason}. The original contents were restored and verified by reread; nothing remains changed.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'commit failed; originals restored + verified by reread',
        },
      },
      writtenPaths: [],
    }
  }
  if (commit.kind === 'indeterminate') {
    const diverged = commit.divergedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')
    const landed = commit.landedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')
    return {
      output: {
        result:
          `Apply INDETERMINATE: ${commit.reason}. Diverged: ${diverged || '(none listed)'}; landed: ${landed || '(none)'}. ` +
          `Re-read these files before relying on their contents.`,
        resultCount: commit.landedPaths.length,
        fileCount: commit.landedPaths.length,
        applied: commit.landedPaths.length > 0,
        effect: {
          outcome: 'indeterminate',
          changedPaths: commit.landedPaths,
          evidence: 'commit indeterminate — re-read before relying',
        },
      },
      writtenPaths: commit.landedPaths,
    }
  }
  return null
}

export async function applyPrepared(
  env: OpEnv,
  operation: string,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
  resultPrefix = '',
): Promise<AppliedOutcome> {
  const permissionContext = env.context.getAppState().toolPermissionContext

  const refusals: string[] = []
  for (const file of files) {
    const abs = uriToFilePath(file.uri)
    const decision = checkWritePermissionForTool(
      env.tool,
      { ...env.input, filePath: abs },
      permissionContext,
    ) as { behavior: string; message?: string }
    const display = displayPathFor(env.cwd, abs)
    if (decision.behavior === 'deny') {
      refusals.push(`${display}: denied by a rule`)
      continue
    }
    if (decision.behavior !== 'allow' && !pathInAllowedWorkingPath(abs, permissionContext) && abs !== env.absolutePath && !modeBypassesPermissions(permissionContext.mode)) {
      if (await env.requestWritePermission?.(abs) !== true) {
        refusals.push(`${display}: permission to edit this additional file was not granted`)
      }
    }
  }
  if (refusals.length > 0) {
    const result =
      `Apply refused — nothing written:\n${refusals.map(line => `  ${line}`).join('\n')}\n` +
      `Approve the requested file edits or adjust permission rules, then apply again.`
    return {
      output: {
        result,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `refused ${refusals.length} file(s), nothing written`,
          details: { applyRefusal: true },
        },
      },
      writtenPaths: [],
    }
  }

  const set = planFiles(files, snapshots)
  if (!set.ok) {
    return {
      output: {
        result: `Apply aborted: ${set.reason}; nothing was written.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'edit application failed — nothing written',
        },
      },
      writtenPaths: [],
    }
  }
  const planned = set.planned.filter(file => file.create || file.newText !== file.originalText)
  const plannedFiles = files.filter(file => planned.some(p => p.abs === uriToFilePath(file.uri)))
  if (planned.length === 0) {
    return {
      output: {
        result: `Nothing to write: the ${operation} leaves every file exactly as it is.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: { outcome: 'no-change', changedPaths: [], evidence: 'edits change no bytes' },
      },
      writtenPaths: [],
    }
  }
  const token = planTokenOf(planned)
  const planRefusal = planRefusalOf(env, token, planned, plannedFiles, snapshots)
  if (planRefusal !== null) return planRefusal

  for (const file of planned) {
    if (env.messageId !== undefined && fileHistoryEnabled()) {
      try {
        await fileHistoryTrackEdit(env.context.updateFileHistoryState, file.abs, env.messageId)
      } catch (error) {
        logForDebugging(`lsp ops: file history track failed for ${file.abs}: ${String(error)}`)
      }
    }
  }

  const owner = ownerFromToolUseContext(env.context)
  const signal = env.context.abortController?.signal
  const commit = await runVerbatimTextCommit({
    ownerKey: owner,
    source: 'lsp',
    files: planned.map(p => ({
      canonicalPath: p.abs,
      originalText: p.originalText,
      plannedText: p.newText,
      ...(p.create ? { kind: 'create' as const } : {}),
    })),
    ...(signal !== undefined ? { signal } : {}),
  })
  const commitFailure = commitFailureOf(env, commit, planned)
  if (commitFailure !== null) return commitFailure

  const written = planned
  const writtenPaths = written.map(w => w.abs)

  const manager = env.manager
  const syncFailures: string[] = []
  for (const w of written) {
    try {
      env.context.readFileState.set(w.abs, {
        content: w.newText,
        timestamp: getFileModificationTime(w.abs),
        offset: undefined,
        limit: undefined,
      })
    } catch (error) {
      logForDebugging(`lsp ops: read-state refresh failed for ${w.abs}: ${String(error)}`)
    }
    try {
      rememberAnchoredSnapshot(owner, mintFileAnchor(w.newText), w.newText, w.abs)
      dropSeenLines(owner, w.abs)
    } catch (error) {
      logForDebugging(`lsp ops: anchor bookkeeping failed for ${w.abs}: ${String(error)}`)
    }
  }
  const syncs = await syncServersAfterWrites(manager, written.map(w => ({ absolutePath: w.abs, newText: w.newText, before: w.create ? null : w.originalText })), owner)
  syncs.forEach((sync, i) => {
    if (!sync.ok) syncFailures.push(`${displayPathFor(env.cwd, written[i]!.abs)}: ${sync.reason}`)
  })
  const primary = written[0]!.abs
  const stabilization = await awaitDiagnosticStabilization(manager, primary)
  try {
    const feedbackState =
      stabilization.state === 'fresh' || stabilization.state === 'unchanged'
        ? stabilization.errors > 0
          ? 'dirty'
          : 'clean'
        : 'unknown'
    const detail =
      stabilization.state === 'fresh' || stabilization.state === 'unchanged'
        ? `${stabilization.errors} error(s), ${stabilization.warnings} warning(s) after ${operation}`
        : `post-apply diagnostics ${stabilization.state}`
    noteRunEvent(owner, { type: 'ide-feedback', at: Date.now(), state: feedbackState, detail })
  } catch (error) {
    passedOver(error)
  }
  const stabilizationNote =
    stabilization.state === 'fresh' || stabilization.state === 'unchanged'
      ? `Post-apply diagnostics: ${stabilization.errors} error(s), ${stabilization.warnings} warning(s).`
      : `post-apply diagnostics ${stabilization.state} — verify the change with a real check.`
  const totalEdits = written.reduce((sum, w) => sum + w.editCount, 0)

  if (syncFailures.length > 0) {
    return {
      output: {
        result:
          `${resultPrefix}Applied, but the language-server sync did not confirm: ${syncFailures.join('; ')}. ` +
          `The files ARE written; the language servers' view is unconfirmed — diagnostics may lag until the next edit.\n${stabilizationNote}`,
        resultCount: totalEdits,
        fileCount: written.length,
        applied: true,
        effect: {
          outcome: 'indeterminate',
          changedPaths: written.map(w => w.abs),
          evidence: 'writes landed; server sync unconfirmed',
          details: { stabilization: stabilization.state, plan: token },
        },
        changeView: changeViewOf(operation, 'applied', env.cwd, plannedFiles, snapshots),
        ...editRowsFor(env, plannedFiles, snapshots),
        plan: token,
      },
      writtenPaths,
    }
  }

  const fileLines = written
    .map(w => `  ${displayPathFor(env.cwd, w.abs)} (${w.editCount}${w.create ? ', created' : ''})`)
    .join('\n')
  return {
    output: {
      result: `${resultPrefix}Applied ${totalEdits} edit(s) across ${written.length} file(s):\n${fileLines}\n${stabilizationNote}`,
      resultCount: totalEdits,
      fileCount: written.length,
      applied: true,
      effect: {
        outcome: 'succeeded',
        changedPaths: written.map(w => w.abs),
        evidence: `${totalEdits} edit(s) written + servers synced`,
        details: { stabilization: stabilization.state, plan: token },
      },
      changeView: changeViewOf(operation, 'applied', env.cwd, plannedFiles, snapshots),
      ...editRowsFor(env, plannedFiles, snapshots),
      plan: token,
    },
    writtenPaths,
  }
}
