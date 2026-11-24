import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { z } from 'zod/v4'
import { type LSPServerInstance } from '../../../integrations/lsp/LSPServerInstance.js'
import { normalizeWorkspaceEdit, type LspRangeLike, type LspTextEditLike, type NormalizedFileEdits, type WorkspaceEditLike } from '../../../integrations/lsp/workspaceEditApply.js'
import type { OpEnv } from './types.js'
import { PREPARE_ROUNDS, IGNORED_WALK_DIRS, displayPathFor, uriToFilePath, syncFileFromDisk } from './shared.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

function lspRangesIntersect(a: LspRangeLike, b: LspRangeLike): boolean {
  const cmp = (x: { line: number; character: number }, y: { line: number; character: number }): number =>
    x.line - y.line || x.character - y.character
  return cmp(a.start, b.end) < 0 && cmp(b.start, a.end) < 0
}

export async function pathRenameClaimants(
  env: OpEnv,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): Promise<LSPServerInstance[]> {
  const seen = new Set<string>()
  const out: LSPServerInstance[] = []
  const addAll = (servers: LSPServerInstance[]): void => {
    for (const s of servers) {
      if (!seen.has(s.name)) {
        seen.add(s.name)
        out.push(s)
      }
    }
  }
  if (!isDirectory) {
    addAll(env.manager.getServersForFile(oldPath))
    addAll(env.manager.getServersForFile(newPath))
    return out
  }
  const FILE_SCAN_CAP = 2_000
  let scanned = 0
  const extensions = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    if (scanned >= FILE_SCAN_CAP) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      passedOver(error)
      return
    }
    for (const entry of entries) {
      if (scanned >= FILE_SCAN_CAP) return
      if (entry.isDirectory()) {
        if (IGNORED_WALK_DIRS.has(entry.name)) continue
        await walk(resolve(dir, entry.name))
      } else {
        scanned++
        const ext = extname(entry.name).toLowerCase()
        if (ext) extensions.add(ext)
      }
    }
  }
  await walk(oldPath)
  for (const ext of extensions) {
    addAll(env.manager.getServersForFile(`${oldPath}/probe${ext}`))
  }
  return out
}

function coalesceWorkspaceEdits(
  perServer: Array<{ server: string; files: NormalizedFileEdits[] }>,
): { files: NormalizedFileEdits[]; overlapNotes: string[] } {
  const byUri = new Map<string, { edits: LspTextEditLike[]; owners: string[] }>()
  const overlapNotes: string[] = []
  for (const { server, files } of perServer) {
    for (const file of files) {
      const entry = byUri.get(file.uri) ?? { edits: [], owners: [] }
      let dropped = 0
      for (const edit of file.edits) {
        if (entry.edits.some(existing => lspRangesIntersect(existing.range, edit.range))) {
          dropped++
          continue
        }
        entry.edits.push(edit)
      }
      if (dropped > 0) {
        overlapNotes.push(
          `${server}: ${dropped} overlapping edit(s) in ${file.uri.slice(file.uri.lastIndexOf('/') + 1) || file.uri} yielded to ${entry.owners.join('+') || 'the prior claimant'}`,
        )
      }
      if (file.edits.length > dropped) entry.owners.push(server)
      byUri.set(file.uri, entry)
    }
  }
  return {
    files: [...byUri.entries()]
      .filter(([, v]) => v.edits.length > 0)
      .map(([uri, v]) => ({ uri, edits: v.edits })),
    overlapNotes,
  }
}

const renamePositionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() })

const renameTextEditSchema = z.object({
  range: z.object({ start: renamePositionSchema, end: renamePositionSchema }).refine(
    ({ start, end }) => end.line > start.line || (end.line === start.line && end.character >= start.character),
    'edit has end before start',
  ),
  newText: z.string(),
})

const renameUriSchema = z.string().refine(uri => {
  try {
    return isAbsolute(uriToFilePath(uri))
  } catch (error) {
    passedOver(error)
    return false
  }
}, 'invalid file URI')

const renameWorkspaceEditSchema = z.object({
  changes: z.record(renameUriSchema, z.array(renameTextEditSchema)).optional(),
  documentChanges: z.array(z.union([
    z.object({ textDocument: z.object({ uri: renameUriSchema }), edits: z.array(renameTextEditSchema) }),
    z.object({ kind: z.string() }),
  ])).optional(),
}).nullish()

export async function prepareApplyFanOut(
  env: OpEnv,
  requesters: Array<{ name: string; request: () => Promise<WorkspaceEditLike | null | undefined> }>,
): Promise<
  | { ok: true; files: NormalizedFileEdits[]; snapshots: Map<string, string>; notes: string[] }
  | { ok: false; reason: string }
> {
  const snapshots = new Map<string, string>()
  const notes: string[] = []
  for (let round = 0; round < PREPARE_ROUNDS; round++) {
    const perServer: Array<{ server: string; files: NormalizedFileEdits[] }> = []
    for (const r of requesters) {
      let edit: WorkspaceEditLike | null | undefined
      try {
        edit = await r.request()
      } catch (error) {
        return { ok: false, reason: `${r.name}: willRenameFiles failed (${error instanceof Error ? error.message : String(error)})` }
      }
      const validated = renameWorkspaceEditSchema.safeParse(edit)
      if (!validated.success) {
        const issue = validated.error.issues[0]!
        return { ok: false, reason: `${r.name}: willRenameFiles returned a malformed edit (${issue.path.join('.') || 'result'}: ${issue.message})` }
      }
      const normalized = normalizeWorkspaceEdit(edit)
      if (!normalized.ok) {
        if (!/edit set is empty|server returned no edit/.test(normalized.reason)) {
          return { ok: false, reason: `${r.name}: willRenameFiles returned an invalid edit (${normalized.reason})` }
        }
        continue
      }
      perServer.push({ server: r.name, files: normalized.files })
    }
    const merged = coalesceWorkspaceEdits(perServer)
    notes.push(...merged.overlapNotes)
    const unsynced = merged.files.filter(file => !snapshots.has(uriToFilePath(file.uri)))
    if (unsynced.length === 0) {
      return { ok: true, files: merged.files, snapshots, notes }
    }
    for (const file of unsynced) {
      const abs = uriToFilePath(file.uri)
      try {
        snapshots.set(abs, await syncFileFromDisk(env.manager, abs, env.context))
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
    reason: `the edit did not stabilize after ${PREPARE_ROUNDS} rounds — the servers kept widening the touched-file set; nothing was written`,
  }
}

export function advertisesFileOperation(
  server: LSPServerInstance,
  op: 'willRename' | 'didRename',
): boolean {
  const caps = server.capabilities as ServerCapabilities | undefined
  const fileOps = (caps?.workspace as { fileOperations?: Record<string, unknown> } | undefined)
    ?.fileOperations
  return Boolean(fileOps?.[op])
}
