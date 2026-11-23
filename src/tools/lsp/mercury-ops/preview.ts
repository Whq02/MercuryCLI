import { sha256Hex } from '../../../platform/primitives/hash.js'
import { applyEditsToText, editRowsOf, formatEditPreview, type EditRow, type NormalizedFileEdits } from '../../../integrations/lsp/workspaceEditApply.js'
import { buildDiffHunks } from '../../engines/structure/transform.js'
import type { LspChangeViewFile, MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, uriToFilePath } from './shared.js'

export function changeViewOf(
  operation: string,
  state: 'proposed' | 'applied',
  cwd: string,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
): MercuryLspOpOutput['changeView'] {
  const viewFiles: LspChangeViewFile[] = []
  for (const file of files) {
    const abs = uriToFilePath(file.uri)
    const snapshot = snapshots.get(abs)
    if (snapshot === undefined) continue
    const applied = applyEditsToText(snapshot, file.edits)
    if (!applied.ok) continue
    const display = displayPathFor(cwd, abs)
    const { hunks, omittedHunks } = buildDiffHunks(display, snapshot, applied.text)
    let changedLines = 0
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') || line.startsWith('-')) changedLines++
      }
    }
    viewFiles.push({
      file: display,
      hunks,
      ...(omittedHunks > 0 ? { omittedHunks } : {}),
      changedLines,
    })
  }
  return { state, action: operation, files: viewFiles, refs: [] }
}

export type PlannedFile = {
  abs: string
  originalText: string
  newText: string
  editCount: number
  create: boolean
}

type PlannedSet = { ok: true; planned: PlannedFile[] } | { ok: false; reason: string }

export function planFiles(files: NormalizedFileEdits[], snapshots: Map<string, string>): PlannedSet {
  const planned: PlannedFile[] = []
  for (const file of files) {
    const abs = uriToFilePath(file.uri)
    const snapshot = snapshots.get(abs)
    if (snapshot === undefined) return { ok: false, reason: `no held snapshot for ${abs}` }
    const applied = applyEditsToText(snapshot, file.edits)
    if (!applied.ok) return { ok: false, reason: applied.reason }
    planned.push({
      abs,
      originalText: snapshot,
      newText: applied.text,
      editCount: applied.editCount,
      create: file.create === true,
    })
  }
  return { ok: true, planned }
}

export function planTokenOf(planned: PlannedFile[]): string {
  const material = JSON.stringify(
    [...planned]
      .map(file => [file.abs, sha256Hex(file.originalText), sha256Hex(file.newText)])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
  )
  return `lsp-${sha256Hex(material).slice(0, 12)}`
}

export function editRowsFor(
  env: OpEnv,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
): { edits: EditRow[]; omittedEdits?: number } {
  const { rows, omitted } = editRowsOf(
    files,
    uri => snapshots.get(uriToFilePath(uri)),
    uri => displayPathFor(env.cwd, uriToFilePath(uri)),
  )
  return { edits: rows, ...(omitted > 0 ? { omittedEdits: omitted } : {}) }
}

export function previewOf(
  env: OpEnv,
  operation: string,
  files: NormalizedFileEdits[],
  snapshots: Map<string, string>,
  purpose: string,
): MercuryLspOpOutput {
  const set = planFiles(files, snapshots)
  if (!set.ok) {
    return {
      result: `${operation} failed: ${set.reason}; nothing was written.`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: { outcome: 'failed', changedPaths: [], evidence: 'edit set ambiguous — nothing written' },
    }
  }
  const token = planTokenOf(set.planned)
  const preview = formatEditPreview(
    files,
    uri => snapshots.get(uriToFilePath(uri)),
    uri => displayPathFor(env.cwd, uriToFilePath(uri)),
  )
  const created = set.planned.filter(file => file.create)
  const createdNote =
    created.length > 0
      ? `\nCreates ${created.map(file => `${displayPathFor(env.cwd, file.abs)} (new file, ${file.newText.split('\n').length} line(s))`).join(', ')}.`
      : ''
  const result = `${preview}${createdNote}\n\nPreview only (nothing written). plan: ${token}; re-run with apply: true, plan: "${token}" ${purpose} (refused if any of these files changes first).`
  const totalEdits = files.reduce((sum, file) => sum + file.edits.length, 0)
  return {
    result,
    resultCount: totalEdits,
    fileCount: files.length,
    applied: false,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `previewed ${files.length} file(s), nothing written`,
      details: { preview: true, plan: token },
    },
    changeView: changeViewOf(operation, 'proposed', env.cwd, files, snapshots),
    ...editRowsFor(env, files, snapshots),
    plan: token,
  }
}
