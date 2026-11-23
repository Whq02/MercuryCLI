import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { syncFileFromDisk } from './shared.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'

export async function opRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const newName = input.newName ?? ''
  if (newName === '' || /\s/.test(newName)) {
    return {
      result: `Rename failed: newName must be a non-empty identifier without whitespace (got ${JSON.stringify(newName)}).`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'invalid newName',
      },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const position = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const requestEdit = (): Promise<WorkspaceEditLike | null | undefined> =>
    env.manager.sendRequest<WorkspaceEditLike | null>(env.absolutePath, 'textDocument/rename', {
      textDocument: { uri },
      position,
      newName,
    })
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    return {
      result: `Rename failed: ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'rename preparation failed — nothing written',
      },
    }
  }
  if (input.apply !== true) {
    return previewOf(env, 'rename', prepared.files, prepared.snapshots, 'to write the rename')
  }
  const applied = await applyPrepared(env, 'rename', prepared.files, prepared.snapshots)
  return applied.output
}
