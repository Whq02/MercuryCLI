import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import { expandPath } from '../../../utils/path.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, isMethodNotFoundError, syncFileFromDisk } from './shared.js'
import { remedyForUnclaimedExtension } from './pull.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'

export async function opMoveSymbol(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  const failed = (result: string, evidence: string): MercuryLspOpOutput => ({
    result,
    resultCount: 0,
    fileCount: 0,
    applied: false,
    effect: { outcome: 'failed', changedPaths: [], evidence },
  })
  const rawTarget = input.targetPath?.trim() ?? ''
  if (rawTarget === '') {
    return failed(
      'moveSymbol needs targetPath — the file the declaration moves to (created when it does not exist, appended to when it does).',
      'missing targetPath',
    )
  }
  const target = resolve(env.cwd, expandPath(rawTarget))
  if (target === resolve(env.absolutePath)) {
    return failed(`LspMoveSymbol failed: targetPath must differ from filePath (${display} cannot move into itself).`, 'target is the source')
  }
  const claimant = env.manager.getServerForFile(env.absolutePath)
  if (!claimant) {
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result: `No language server claims ${display} (extension '${extension}') — nothing can move it. ${remedyForUnclaimedExtension(extension)}`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: `no language server claims '${extension}'` },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const position = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const requestEdit = (): Promise<WorkspaceEditLike | null | undefined> =>
    env.manager.sendRequest<WorkspaceEditLike | null>(env.absolutePath, 'mercury/moveToFile', {
      textDocument: { uri },
      position,
      targetUri: pathToFileURL(target).href,
    })
  const prepared = await prepareApply(env, requestEdit, { allowCreate: true })
  if (!prepared.ok) {
    if (isMethodNotFoundError(prepared.reason)) {
      return {
        result: `The ${claimant.name} server does not offer a symbol move — the TypeScript and JavaScript lane (mercury-ts) does; for other languages move the declaration with Edit and fix the imports with LspRename or LspMoveFile.`,
        resultCount: 0,
        fileCount: 0,
        effect: { outcome: 'no-change', changedPaths: [], evidence: 'symbol move unsupported by the claimant' },
      }
    }
    return failed(`Move failed: ${prepared.reason}`, 'move preparation failed — nothing written')
  }
  if (input.apply !== true) {
    return previewOf(env, 'moveSymbol', prepared.files, prepared.snapshots, `to move the declaration to ${displayPathFor(env.cwd, target)}`)
  }
  const applied = await applyPrepared(env, 'moveSymbol', prepared.files, prepared.snapshots)
  return applied.output
}
