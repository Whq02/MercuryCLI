import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatEditPreview, type NormalizedFileEdits, type WorkspaceEditLike } from '../../../integrations/lsp/workspaceEditApply.js'
import { renameWithWin32Retry } from '../../../platform/substrate/durablePublish.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { errorMessage, getErrnoCode } from '../../../platform/errors/errors.js'
import { checkWritePermissionForTool, pathInAllowedWorkingPath } from '../../../permissions/rules/filesystem.js'
import { modeBypassesPermissions } from '../../../permissions/rules/permissionMode.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { PATH_RENAME_FILE_CAP, displayPathFor, uriToFilePath, syncFileFromDisk } from './shared.js'
import { awaitDiagnosticStabilization } from './afterWrite.js'
import { changeViewOf, planFiles, planTokenOf, editRowsFor } from './preview.js'
import { applyPrepared } from './apply.js'
import { pathRenameClaimants, prepareApplyFanOut, advertisesFileOperation } from './pathRenameFanOut.js'

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
  const input = env.input
  const oldPath = env.absolutePath
  const display = displayPathFor(env.cwd, oldPath)
  if (!input.newPath || resolve(env.cwd, input.newPath) === resolve(oldPath)) {
    return {
      result: `LspMoveFile failed: newPath is required and must differ from filePath.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'invalid newPath',
      },
    }
  }
  const newPath = resolve(env.cwd, input.newPath)
  const newDisplay = displayPathFor(env.cwd, newPath)
  let isDirectory = false
  try {
    isDirectory = (await stat(oldPath)).isDirectory()
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return moveFailed(`LspMoveFile failed: ${display} does not exist.`, 'source missing')
    }
    return moveFailed(
      `LspMoveFile refused: ${display} could not be checked (${errorMessage(error)}) — nothing moved.`,
      'source unchecked — nothing moved',
    )
  }
  try {
    await stat(newPath)
    return moveFailed(`LspMoveFile refused: Target already exists at ${newDisplay} — nothing moved.`, 'target exists — nothing moved')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return moveFailed(
        `LspMoveFile refused: the target ${newDisplay} could not be checked (${errorMessage(error)}) — nothing moved.`,
        'target unchecked — nothing moved',
      )
    }
  }

  const claimants = await pathRenameClaimants(env, oldPath, newPath, isDirectory)
  const unprepared: string[] = []
  for (const c of claimants) {
    if (c.state !== 'running') {
      await c.start().catch((error: unknown) => {
        unprepared.push(`${c.name} could not start (${errorMessage(error)}), so the move goes on without its import updates`)
      })
    }
  }
  const askable = claimants.filter(c => advertisesFileOperation(c, 'willRename'))

  const oldUri = pathToFileURL(resolve(oldPath)).href
  const newUri = pathToFileURL(newPath).href

  let prepared: { ok: true; files: NormalizedFileEdits[]; snapshots: Map<string, string> }
  let supportNote: string
  const fanOutNotes: string[] = [...unprepared]
  if (askable.length > 0) {
    if (!isDirectory) {
      await syncFileFromDisk(env.manager, oldPath, env.context).catch((error: unknown) => {
        fanOutNotes.push(`${display} could not be re-read for the language server (${errorMessage(error)}), so its import updates come from the copy it already had`)
      })
    }
    const fan = await prepareApplyFanOut(
      env,
      askable.map(server => ({
        name: server.name,
        request: () =>
          server.sendRequest<WorkspaceEditLike | null>('workspace/willRenameFiles', {
            files: [{ oldUri, newUri }],
          }),
      })),
    )
    if (!fan.ok) {
      return {
        result: `LspMoveFile failed while preparing import edits: ${fan.reason}. Nothing was written or moved; all files are unchanged.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'import-edit preparation failed — all files unchanged',
        },
      }
    }
    fanOutNotes.push(...fan.notes)
    const editCount = fan.files.reduce((sum, file) => sum + file.edits.length, 0)
    if (fan.files.length > PATH_RENAME_FILE_CAP) {
      return {
        result: `LspMoveFile refused: the move would touch ${fan.files.length} files (cap ${PATH_RENAME_FILE_CAP}). Split the move into smaller steps, or move the file with Bash and fix imports incrementally.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `file cap exceeded (${fan.files.length})`,
        },
      }
    }
    prepared = { ok: true, files: fan.files, snapshots: fan.snapshots }
    supportNote =
      editCount === 0
        ? `${askable.map(s => s.name).join(' + ')} reported no import edits for this move.`
        : `${editCount} import-updating edit(s) computed by ${askable.map(s => s.name).join(' + ')}.`
  } else if (claimants.length > 0) {
    prepared = { ok: true, files: [], snapshots: new Map() }
    supportNote = `${claimants.map(c => c.name).join(' + ')} claim${claimants.length === 1 ? 's' : ''} the file type but none advertises path-rename intelligence (workspace.fileOperations.willRename) — the ${isDirectory ? 'directory' : 'file'} moves without import updates.`
  } else {
    prepared = { ok: true, files: [], snapshots: new Map() }
    supportNote = `No language server claims this ${isDirectory ? "directory's contents" : 'file'} — the ${isDirectory ? 'directory' : 'file'} moves without import updates.`
  }

  const preparedFiles = prepared.files
  const preparedSnapshots = prepared.snapshots
  const notesBlock = fanOutNotes.length > 0 ? `\n${fanOutNotes.map(n => `note: ${n}`).join('\n')}` : ''
  if (input.apply !== true) {
    return pathRenamePreviewOf(env, preparedFiles, preparedSnapshots, display, newDisplay, supportNote, notesBlock)
  }

  const permissionContext = env.context.getAppState().toolPermissionContext
  for (const endpoint of [oldPath, newPath]) {
    const decision = checkWritePermissionForTool(
      env.tool,
      { ...env.input, filePath: endpoint },
      permissionContext,
    ) as { behavior: string }
    const endpointDisplay = displayPathFor(env.cwd, endpoint)
    if (decision.behavior === 'deny') {
      return {
        result: `LspMoveFile refused: ${endpointDisplay} is denied by a rule. Nothing moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'endpoint denied — nothing moved',
        },
      }
    }
    if (decision.behavior !== 'allow' && !pathInAllowedWorkingPath(endpoint, permissionContext) && endpoint !== env.absolutePath && !modeBypassesPermissions(permissionContext.mode) && await env.requestWritePermission?.(endpoint) !== true) {
      return {
        result: `LspMoveFile refused: permission to write ${endpointDisplay} was not granted. Nothing moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'endpoint out of scope — nothing moved',
        },
      }
    }
  }

  let editedPaths: string[] = []
  if (prepared.files.length > 0) {
    const applied = await applyPrepared(env, 'pathRename', prepared.files, prepared.snapshots)
    if (applied.output.effect.outcome === 'failed') {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved.`,
      }
    }
    if (applied.output.effect.outcome === 'indeterminate' && applied.output.applied !== true) {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved — resolve the divergence first.`,
      }
    }
    editedPaths = applied.writtenPaths
    if (applied.output.effect.outcome === 'indeterminate') {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved — re-run LspMoveFile once the servers settle.`,
      }
    }
  }

  try {
    await mkdir(dirname(newPath), { recursive: true })
    try {
      await renameWithWin32Retry(oldPath, newPath)
    } catch (error) {
      if ((error as { code?: string }).code === 'EXDEV' && !isDirectory) {
        const oldBytes = await readFile(oldPath)
        await writeFile(newPath, oldBytes)
        await unlink(oldPath)
      } else if ((error as { code?: string }).code === 'EXDEV') {
        throw new Error(
          'cross-device directory move is not supported — move the tree with Bash (cp -R + rm) and re-run imports per file',
        )
      } else {
        throw error
      }
    }
  } catch (error) {
    return {
      result:
        `LspMoveFile INDETERMINATE: the import edits landed but the move itself failed (${error instanceof Error ? error.message : String(error)}). ` +
        `${display} still exists with updated imports pointing at the NEW path — move it manually or re-run.`,
      resultCount: editedPaths.length,
      fileCount: editedPaths.length,
      applied: true,
      effect: {
        outcome: 'indeterminate',
        changedPaths: editedPaths,
        evidence: 'edits landed; move failed',
      },
    }
  }

  if (!isDirectory) {
    try {
      await env.manager.closeFile(oldPath)
    } catch (error) {
      logForDebugging(`lsp ops: pathRename didClose failed: ${String(error)}`)
    }
  }
  for (const server of claimants) {
    if (!advertisesFileOperation(server, 'didRename')) continue
    try {
      await server.sendNotification('workspace/didRenameFiles', {
        files: [{ oldUri, newUri }],
      })
    } catch (error) {
      logForDebugging(`lsp ops: didRenameFiles to ${server.name} failed: ${String(error)}`)
    }
  }
  let movedText = ''
  if (!isDirectory) {
    try {
      movedText = await readFile(newPath, 'utf8')
      await env.manager.openFile(newPath, movedText)
    } catch (error) {
      logForDebugging(`lsp ops: post-move open failed: ${String(error)}`)
    }
  }
  try {
    const readFileState = env.context.readFileState
    if (isDirectory) {
      const root = resolve(oldPath)
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`
      for (const [key, value] of [...readFileState.entries()]) {
        if (key === root || key.startsWith(prefix)) {
          readFileState.delete(key)
          readFileState.set(newPath + key.slice(root.length), value)
        }
      }
    } else {
      readFileState.delete(oldPath)
      const stats = await stat(newPath)
      readFileState.set(newPath, {
        content: movedText.replaceAll('\r\n', '\n'),
        timestamp: Math.floor(stats.mtimeMs),
        offset: undefined,
        limit: undefined,
      })
    }
  } catch (error) {
    logForDebugging(`lsp ops: readFileState follow failed: ${String(error)}`)
  }

  const postMoveNote = isDirectory
    ? 'Directory moved — run diagnostics on the touched files to verify.'
    : await (async () => {
        const stabilization = await awaitDiagnosticStabilization(env.manager, newPath)
        return stabilization.state === 'fresh' || stabilization.state === 'unchanged'
          ? `Post-move diagnostics: ${stabilization.errors} error(s), ${stabilization.warnings} warning(s).`
          : `post-move diagnostics ${stabilization.state} — verify the move with a real check.`
      })()
  const editedList =
    editedPaths.length > 0
      ? `\nEdited: ${editedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')}`
      : ''
  const changedPaths = [...new Set([...editedPaths, oldPath, newPath])]
  return {
    result: `Moved ${display} → ${newDisplay}\n${supportNote}${notesBlock}${editedList}\n${postMoveNote}`,
    resultCount: changedPaths.length,
    fileCount: changedPaths.length,
    applied: true,
    effect: {
      outcome: 'succeeded',
      changedPaths,
      evidence: `moved + ${editedPaths.length} file(s) edited`,
      details: { postMove: postMoveNote },
    },
  }
}
