import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatEditPreview, type NormalizedFileEdits, type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import { renameWithWin32Retry } from '../../../substrate/durablePublish.js'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage, getErrnoCode } from '../../../utils/errors.js'
import { checkWritePermissionForTool, pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js'
import { postureBypassesAsks } from '../../../utils/permissions/decision/engine.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { PATH_RENAME_FILE_CAP, displayPathFor, uriToFilePath, syncFileFromDisk } from './shared.js'
import { awaitDiagnosticStabilization } from './afterWrite.js'
import { changeViewOf, planFiles, planTokenOf, editRowsFor } from './preview.js'
import { applyPrepared } from './apply.js'
import { pathRenameClaimants, prepareApplyFanOut, advertisesFileOperation } from './pathRenameFanOut.js'
import { notBuilt } from '../../../pi/holes.js'

function moveFailed(result: string, evidence: string): MercuryLspOpOutput {
  return { result, resultCount: 0, fileCount: 0, effect: { outcome: 'failed', changedPaths: [], evidence } }
}

function pathRenamePreviewOf(
  env: OpEnv,
  preparedFiles: NormalizedFileEdits[],
  preparedSnapshots: Map<string, string>,
  display: string,
  newDisplay: string,
  supportNote: string,
  notesBlock: string,
): MercuryLspOpOutput {
  const set = planFiles(preparedFiles, preparedSnapshots)
  if (!set.ok) {
    return {
      result: `LspMoveFile failed while planning the import edits: ${set.reason}. Nothing was moved.`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: { outcome: 'failed', changedPaths: [], evidence: 'edit set ambiguous — nothing moved' },
    }
  }
  const token = set.planned.length > 0 ? planTokenOf(set.planned) : undefined
  const editPreview =
    preparedFiles.length > 0
      ? `\n${formatEditPreview(
          preparedFiles,
          uri => preparedSnapshots.get(uriToFilePath(uri)),
          uri => displayPathFor(env.cwd, uriToFilePath(uri)),
        )}`
      : ''
  const rerun =
    token !== undefined
      ? `plan: ${token} — re-run with apply: true, plan: "${token}" to move (refused if any of these files changes first).`
      : 'Re-run with apply: true to move.'
  return {
    result: `Move: ${display} → ${newDisplay}\n${supportNote}${notesBlock}${editPreview}\nPreview only — nothing moved, nothing written. ${rerun}`,
    resultCount: preparedFiles.reduce((sum, file) => sum + file.edits.length, 0),
    fileCount: preparedFiles.length,
    applied: false,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: 'move previewed, nothing written',
      details: { preview: true, ...(token !== undefined ? { plan: token } : {}) },
    },
    ...(preparedFiles.length > 0
      ? {
          changeView: changeViewOf(
            'pathRename',
            'proposed',
            env.cwd,
            preparedFiles,
            preparedSnapshots,
          ),
          ...editRowsFor(env, preparedFiles, preparedSnapshots),
        }
      : {}),
    ...(token !== undefined ? { plan: token } : {}),
  }
}

export async function opPathRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  return notBuilt('src/tools/LSPTool/mercuryOps/pathRename.ts:80')
}
