import * as path from 'node:path'
import type * as TS from 'typescript'
import { type TsModule, positionAt } from './lsp.js'
import type { OpenDoc, Project, SidecarState } from './state.js'

interface TextChangeLike {
  start: number
  length: number
  newText: string
  probeAt?: number | null
}

function applyTextChanges(text: string, changes: readonly TextChangeLike[]): string {
  const ordered = [...changes].sort((a, b) => b.start - a.start)
  let out = text
  for (const change of ordered) {
    out = out.slice(0, change.start) + change.newText + out.slice(change.start + change.length)
  }
  return out
}

function offsetMapper(changes: readonly TextChangeLike[]): (offset: number) => number {
  const ordered = [...changes].sort((a, b) => a.start - b.start)
  return offset => {
    let delta = 0
    for (const change of ordered) {
      if (change.start + change.length <= offset) {
        delta += change.newText.length - change.length
        continue
      }
      if (change.start < offset) return change.start + delta
      break
    }
    return offset + delta
  }
}

export function isIdentifierName(ts: TsModule, name: string, target: TS.ScriptTarget): boolean {
  if (name.length === 0) return false
  let first = true
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    const ok = first ? ts.isIdentifierStart(code, target) : ts.isIdentifierPart(code, target)
    if (!ok) return false
    first = false
  }
  return true
}

export function reservedWordProblem(
  ts: { SyntaxKind: TsModule['SyntaxKind']; stringToToken?: (s: string) => number | undefined },
  name: string,
): string | undefined {
  const stringToToken = ts.stringToToken
  if (typeof stringToToken !== 'function') return undefined
  const token = stringToToken(name)
  if (token === undefined) return undefined
  if (token >= ts.SyntaxKind.FirstReservedWord && token <= ts.SyntaxKind.LastReservedWord) {
    return `'${name}' is a reserved word and cannot name a symbol`
  }
  return undefined
}

function tokenOccurrences(ts: TsModule, text: string, word: string, target: TS.ScriptTarget): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(word, from)
    if (at === -1) return out
    from = at + 1
    const before = at > 0 ? text.codePointAt(at - 1) ?? 0 : 0
    const after = at + word.length < text.length ? text.codePointAt(at + word.length) ?? 0 : 0
    if (at > 0 && ts.isIdentifierPart(before, target)) continue
    if (after !== 0 && ts.isIdentifierPart(after, target)) continue
    out.push(at)
  }
}

export function positionLabel(root: string, file: string, text: string, offset: number): string {
  const pos = positionAt(text, offset)
  const rel = path.relative(root, file)
  const shown = rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel
  return `${shown}:${pos.line + 1}:${pos.character + 1}`
}

function errorKeysOf(ts: TsModule, diagnostics: readonly TS.Diagnostic[]): Map<string, TS.Diagnostic[]> {
  const out = new Map<string, TS.Diagnostic[]>()
  for (const d of diagnostics) {
    if (d.category !== ts.DiagnosticCategory.Error) continue
    const key = `${d.code}|${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
    const list = out.get(key) ?? []
    list.push(d)
    out.set(key, list)
  }
  return out
}

function newErrorsAgainst(
  ts: TsModule,
  before: Map<string, TS.Diagnostic[]>,
  after: readonly TS.Diagnostic[],
): TS.Diagnostic[] {
  const budget = new Map<string, number>()
  for (const [key, list] of before) budget.set(key, list.length)
  const fresh: TS.Diagnostic[] = []
  for (const [key, list] of errorKeysOf(ts, after)) {
    const allowed = budget.get(key) ?? 0
    for (const d of list.slice(allowed)) fresh.push(d)
  }
  return fresh
}

export interface RenamePlan {
  file: string
  changes: TextChangeLike[]
}

export type PropertyKeySite = 'shorthand' | 'binding' | 'plain'

export function propertyKeySiteKind(ts: TsModule, sf: TS.SourceFile | undefined, pos: number): PropertyKeySite {
  if (!sf) return 'plain'
  let found: TS.Node | undefined
  const visit = (node: TS.Node): void => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return
    found = node
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  const parent = found?.parent
  if (!parent) return 'plain'
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === found) return 'shorthand'
  if (ts.isBindingElement(parent) && parent.propertyName === undefined && parent.name === found && ts.isObjectBindingPattern(parent.parent)) return 'binding'
  return 'plain'
}

export function renameSafetyProblem(
  st: SidecarState,
  project: Project,
  displayName: string,
  newName: string,
  plans: RenamePlan[],
): string | undefined {
  const ts = st.ts
  const target = project.service.getProgram()?.getCompilerOptions().target ?? ts.ScriptTarget.ES2022
  const beforeTexts = new Map<string, string>()
  const mappers = new Map<string, (offset: number) => number>()
  const sensitive = new Set<string>()
  const existingUses = new Map<string, number[]>()
  for (const plan of plans) {
    const text = st.textOf(plan.file) ?? ''
    beforeTexts.set(plan.file, text)
    mappers.set(plan.file, offsetMapper(plan.changes))
    const renamedStarts = new Set(plan.changes.map(c => c.start))
    const occurrences = tokenOccurrences(ts, text, newName, target)
    const uses = occurrences.filter(at => !renamedStarts.has(at))
    if (occurrences.length > 0) sensitive.add(plan.file)
    if (uses.length > 0) existingUses.set(plan.file, uses)
  }
  const defKey = (file: string, offset: number): string => `${st.normalize(file)}:${offset}`
  const mappedDefKeys = (defs: readonly TS.DefinitionInfo[] | undefined): string[] => {
    const out: string[] = []
    for (const def of defs ?? []) {
      const file = st.normalize(def.fileName)
      const map = mappers.get(file)
      out.push(defKey(file, map ? map(def.textSpan.start) : def.textSpan.start))
    }
    return out
  }
  const renamedExpected = new Set<string>()
  const renamedProbe: Array<{ file: string; offset: number; valueShift: number }> = []
  for (const plan of plans) {
    if (!sensitive.has(plan.file)) continue
    for (const change of plan.changes) {
      if (change.probeAt === null) continue
      renamedProbe.push({ file: plan.file, offset: change.start, valueShift: change.probeAt ?? 0 })
      for (const key of mappedDefKeys(project.service.getDefinitionAtPosition(plan.file, change.start))) renamedExpected.add(key)
    }
  }
  const usesBefore = new Map<string, string[][]>()
  for (const [file, offsets] of existingUses) {
    usesBefore.set(file, offsets.map(offset => mappedDefKeys(project.service.getDefinitionAtPosition(file, offset))))
  }
  const syntacticBefore = new Map<string, Map<string, TS.Diagnostic[]>>()
  const semanticBefore = new Map<string, Map<string, TS.Diagnostic[]>>()
  for (const plan of plans) {
    syntacticBefore.set(plan.file, errorKeysOf(ts, project.service.getSyntacticDiagnostics(plan.file)))
    if (sensitive.has(plan.file)) semanticBefore.set(plan.file, errorKeysOf(ts, project.service.getSemanticDiagnostics(plan.file)))
  }
  const saved = new Map<string, OpenDoc | undefined>()
  for (const plan of plans) {
    saved.set(plan.file, st.openDocs.get(plan.file))
    st.changeDoc(plan.file, applyTextChanges(beforeTexts.get(plan.file) ?? '', plan.changes))
  }
  try {
    const describe = (file: string, d: TS.Diagnostic): string => {
      const text = st.textOf(file) ?? ''
      return `${positionLabel(st.workspaceRoot, file, text, d.start ?? 0)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
    }
    for (const plan of plans) {
      const fresh = newErrorsAgainst(ts, syntacticBefore.get(plan.file) ?? new Map(), project.service.getSyntacticDiagnostics(plan.file))
      if (fresh[0]) return `renaming '${displayName}' to '${newName}' would collide — ${describe(plan.file, fresh[0])}`
    }
    for (const plan of plans) {
      if (!sensitive.has(plan.file)) continue
      const fresh = newErrorsAgainst(ts, semanticBefore.get(plan.file) ?? new Map(), project.service.getSemanticDiagnostics(plan.file))
      if (fresh[0]) return `renaming '${displayName}' to '${newName}' would collide — ${describe(plan.file, fresh[0])}`
    }
    for (const probe of renamedProbe) {
      const map = mappers.get(probe.file)!
      const at = map(probe.offset) + probe.valueShift
      const after = mappedDefKeys(project.service.getDefinitionAtPosition(probe.file, at))
      if (after.length > 0 && !after.some(key => renamedExpected.has(key))) {
        const text = st.textOf(probe.file) ?? ''
        return `renaming '${displayName}' to '${newName}' would leave the occurrence at ${positionLabel(st.workspaceRoot, probe.file, text, at)} bound to another '${newName}'`
      }
    }
    for (const [file, offsets] of existingUses) {
      const map = mappers.get(file)!
      const before = usesBefore.get(file) ?? []
      for (let i = 0; i < offsets.length; i++) {
        const after = mappedDefKeys(project.service.getDefinitionAtPosition(file, map(offsets[i]!)))
        const expected = before[i] ?? []
        const same = after.length === expected.length && after.every(key => expected.includes(key))
        if (!same) {
          const text = st.textOf(file) ?? ''
          return `renaming '${displayName}' to '${newName}' would change what '${newName}' at ${positionLabel(st.workspaceRoot, file, text, map(offsets[i]!))} refers to`
        }
      }
    }
    return undefined
  } finally {
    for (const plan of plans) {
      const prior = saved.get(plan.file)
      if (prior) st.changeDoc(plan.file, prior.text)
      else st.closeDoc(plan.file)
    }
  }
}
