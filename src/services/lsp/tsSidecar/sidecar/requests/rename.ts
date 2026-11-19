import { RPC_INTERNAL_ERROR } from '../../../sidecarFraming.js'
import { type LspTextEdit, spanToRange, toUri, fromUri } from '../lsp.js'
import { isIdentifierName, reservedWordProblem, type RenamePlan, type PropertyKeySite, propertyKeySiteKind, renameSafetyProblem } from '../renameSafety.js'
import { fileTextChangesToWorkspaceEdit, FORMAT_OPTIONS } from '../convert.js'
import type { DocContext, RequireState } from '../needs.js'

export function willRenameFilesRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const p = params as { files?: { oldUri: string; newUri: string }[] }
  const merged: Record<string, LspTextEdit[]> = {}
  for (const f of p.files ?? []) {
    const oldFile = st.normalize(fromUri(f.oldUri))
    const newFile = st.normalize(fromUri(f.newUri))
    const project = st.projectFor(oldFile)
    const changes = project.service.getEditsForFileRename(
      oldFile,
      newFile,
      FORMAT_OPTIONS,
      {},
    )
    const edit = fileTextChangesToWorkspaceEdit(st, changes)
    for (const [uri, edits] of Object.entries(edit.changes)) {
      ;(merged[uri] ??= []).push(...edits)
    }
  }
  return { changes: merged }
}

export function prepareRenameRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, text, offset } = docContext(params)
  const info = project.service.getRenameInfo(file, offset, {})
  if (!info.canRename) return null
  void st
  return {
    range: spanToRange(
      text,
      info.triggerSpan.start,
      info.triggerSpan.length,
    ),
    placeholder: info.displayName,
  }
}

export function renameRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const p = params as { newName: string }
  const info = project.service.getRenameInfo(file, offset, {})
  if (!info.canRename) {
    throw Object.assign(
      new Error(info.localizedErrorMessage || 'cannot rename here'),
      { rpcCode: RPC_INTERNAL_ERROR },
    )
  }
  const target =
    project.service.getProgram()?.getCompilerOptions().target ?? st.ts.ScriptTarget.ES2022
  if (p.newName === info.displayName) {
    throw Object.assign(new Error(`'${p.newName}' is already the symbol's name`), {
      rpcCode: RPC_INTERNAL_ERROR,
    })
  }
  if (isIdentifierName(st.ts, info.displayName, target)) {
    const reserved = reservedWordProblem(st.ts, p.newName)
    if (reserved) throw Object.assign(new Error(reserved), { rpcCode: RPC_INTERNAL_ERROR })
    if (!isIdentifierName(st.ts, p.newName, target)) {
      throw Object.assign(new Error(`'${p.newName}' is not a valid identifier`), {
        rpcCode: RPC_INTERNAL_ERROR,
      })
    }
  }
  const locations = project.service.findRenameLocations(
    file,
    offset,
    false,
    false,
    { providePrefixAndSuffixTextForRename: false },
  ) ?? []
  const plans = new Map<string, RenamePlan>()
  const program = project.service.getProgram()
  const siteKey = (f: string, start: number): string => `${st.normalize(f)}:${start}`
  const siteKinds = new Map<string, PropertyKeySite>()
  for (const loc of locations) siteKinds.set(siteKey(loc.fileName, loc.textSpan.start), propertyKeySiteKind(st.ts, program?.getSourceFile(loc.fileName), loc.textSpan.start))
  const defsOf = (file: string, start: number): string[] => (project.service.getDefinitionAtPosition(st.normalize(file), start) ?? []).map(def => siteKey(def.fileName, def.textSpan.start))
  const renamedKeys = new Set<string>()
  const chainBindings = new Set<string>()
  for (const loc of locations) {
    const key = siteKey(loc.fileName, loc.textSpan.start)
    const kind = siteKinds.get(key)
    if (kind === 'shorthand') continue
    for (const defKey of defsOf(loc.fileName, loc.textSpan.start)) {
      if (siteKinds.get(defKey) === 'shorthand') renamedKeys.add(defKey)
      if (kind === 'binding' && siteKinds.has(defKey)) chainBindings.add(key)
    }
  }
  for (const loc of locations) {
    const locFile = st.normalize(loc.fileName)
    const locText = st.textOf(locFile)
    if (locText === undefined) continue
    const key = siteKey(loc.fileName, loc.textSpan.start)
    const kind = siteKinds.get(key)
    const oldText = locText.slice(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length)
    let newText = p.newName
    let probeAt: number | null = 0
    if (kind === 'shorthand') {
      const valueRenamed = defsOf(loc.fileName, loc.textSpan.start).some(defKey => defKey !== key && siteKinds.has(defKey))
      if (!renamedKeys.has(key)) {
        newText = `${oldText}: ${p.newName}`
        probeAt = oldText.length + 2
      } else if (!valueRenamed) {
        newText = `${p.newName}: ${oldText}`
        probeAt = null
      }
    } else if (kind === 'binding' && !chainBindings.has(key)) {
      newText = `${oldText}: ${p.newName}`
      probeAt = oldText.length + 2
    }
    const plan = plans.get(locFile) ?? { file: locFile, changes: [] }
    plan.changes.push({ start: loc.textSpan.start, length: loc.textSpan.length, newText, probeAt })
    plans.set(locFile, plan)
  }
  const problem = renameSafetyProblem(st, project, info.displayName, p.newName, [...plans.values()])
  if (problem) throw Object.assign(new Error(problem), { rpcCode: RPC_INTERNAL_ERROR })
  const changes: Record<string, LspTextEdit[]> = {}
  for (const plan of plans.values()) {
    const locText = st.textOf(plan.file)
    if (locText === undefined) continue
    changes[toUri(plan.file)] = plan.changes.map(change => ({
      range: spanToRange(locText, change.start, change.length),
      newText: change.newText,
    }))
  }
  return { changes }
}
