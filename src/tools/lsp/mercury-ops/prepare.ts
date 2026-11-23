import { stat } from 'node:fs/promises'
import { isENOENT } from '../../../platform/errors/errors.js'
import { normalizeWorkspaceEdit, type NormalizedFileEdits, type WorkspaceEditLike } from '../../../integrations/lsp/workspaceEditApply.js'
import type { OpEnv } from './types.js'
import { PREPARE_ROUNDS, displayPathFor, uriToFilePath, foldFilesByPath, syncFileFromDisk } from './shared.js'

type PreparedApply =
  | {
      ok: true
      files: NormalizedFileEdits[]
      snapshots: Map<string, string>
    }
  | { ok: false; reason: string }

export async function prepareApply(
  env: OpEnv,
  requestEdit: () => Promise<WorkspaceEditLike | null | undefined>,
  options: { allowCreate?: boolean } = {},
): Promise<PreparedApply> {
  const snapshots = new Map<string, string>()
  for (let round = 0; round < PREPARE_ROUNDS; round++) {
    let edit: WorkspaceEditLike | null | undefined
    try {
      edit = await requestEdit()
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const normalized = normalizeWorkspaceEdit(edit, options)
    if (!normalized.ok) return { ok: false, reason: normalized.reason }
    const files = foldFilesByPath(normalized.files)
    const unsynced = files.filter(file => !snapshots.has(uriToFilePath(file.uri)))
    if (unsynced.length === 0) {
      return { ok: true, files, snapshots }
    }
    for (const file of unsynced) {
      const abs = uriToFilePath(file.uri)
      if (file.create === true) {
        let exists = false
        try {
          await stat(abs)
          exists = true
        } catch (error) {
          if (!isENOENT(error)) {
            return {
              ok: false,
              reason: `could not sync ${displayPathFor(env.cwd, abs)}: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
          exists = false
        }
        if (exists) {
          return {
            ok: false,
            reason: `${displayPathFor(env.cwd, abs)} already exists — the service planned to create it; name a file that does not exist or an existing module to move into`,
          }
        }
        snapshots.set(abs, '')
        continue
      }
      try {
        snapshots.set(abs, await syncFileFromDisk(env.manager, abs))
      } catch (error) {
        return {
          ok: false,
          reason: `could not sync ${displayPathFor(env.cwd, abs)}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  return {
    ok: false,
    reason: `the edit did not stabilize after ${PREPARE_ROUNDS} rounds — the server kept widening the touched-file set; nothing was written`,
  }
}
