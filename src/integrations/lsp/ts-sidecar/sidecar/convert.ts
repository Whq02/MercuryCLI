import type * as TS from 'typescript'
import { type TsModule, type LspLocation, type LspTextEdit, type LspDocumentSymbol, type LspCallHierarchyItem, spanToRange, toUri, symbolKindOf } from './lsp.js'
import type { SidecarState } from './state.js'

export function spansToLocations(
  st: SidecarState,
  entries: readonly { fileName: string; textSpan: TS.TextSpan }[],
): LspLocation[] {
  const out: LspLocation[] = []
  for (const entry of entries) {
    const file = st.normalize(entry.fileName)
    const text = st.textOf(file)
    if (text === undefined) continue
    out.push({
      uri: toUri(file),
      range: spanToRange(text, entry.textSpan.start, entry.textSpan.length),
    })
  }
  return out
}

export function navTreeToSymbols(
  text: string,
  items: TS.NavigationTree[] | undefined,
): LspDocumentSymbol[] {
  if (!items) return []
  const out: LspDocumentSymbol[] = []
  for (const item of items) {
    const spans = item.spans
    if (!spans || spans.length === 0) {
      out.push(...navTreeToSymbols(text, item.childItems))
      continue
    }
    const first = spans[0]!
    let minStart = first.start
    let maxEnd = first.start + first.length
    for (const s of spans) {
      minStart = Math.min(minStart, s.start)
      maxEnd = Math.max(maxEnd, s.start + s.length)
    }
    const selection = item.nameSpan ?? first
    const children = navTreeToSymbols(text, item.childItems)
    const symbol: LspDocumentSymbol = {
      name: item.text,
      kind: symbolKindOf(item.kind),
      range: spanToRange(text, minStart, maxEnd - minStart),
      selectionRange: spanToRange(text, selection.start, selection.length),
    }
    if (children.length > 0) symbol.children = children
    out.push(symbol)
  }
  return out
}

export function callItemOf(
  st: SidecarState,
  item: TS.CallHierarchyItem,
): LspCallHierarchyItem | undefined {
  const file = st.normalize(item.file)
  const text = st.textOf(file)
  if (text === undefined) return undefined
  const mapped: LspCallHierarchyItem = {
    name: item.name,
    kind: symbolKindOf(item.kind),
    uri: toUri(file),
    range: spanToRange(text, item.span.start, item.span.length),
    selectionRange: spanToRange(
      text,
      item.selectionSpan.start,
      item.selectionSpan.length,
    ),
  }
  if (item.containerName) mapped.detail = item.containerName
  return mapped
}

export function fileTextChangesToWorkspaceEdit(
  st: SidecarState,
  changesList: readonly TS.FileTextChanges[],
): { changes: Record<string, LspTextEdit[]> } {
  const changes: Record<string, LspTextEdit[]> = {}
  for (const fileChanges of changesList) {
    const file = st.normalize(fileChanges.fileName)
    const text = st.textOf(file)
    if (text === undefined) continue
    const uri = toUri(file)
    const edits = (changes[uri] ??= [])
    for (const tc of fileChanges.textChanges) {
      edits.push({
        range: spanToRange(text, tc.span.start, tc.span.length),
        newText: tc.newText,
      })
    }
  }
  return { changes }
}

export function fileTextChangesToDocumentChanges(
  st: SidecarState,
  changesList: readonly TS.FileTextChanges[],
): { documentChanges: unknown[] } {
  const documentChanges: unknown[] = []
  for (const fileChanges of changesList) {
    const file = st.normalize(fileChanges.fileName)
    const text = fileChanges.isNewFile ? '' : st.textOf(file)
    if (text === undefined) continue
    const uri = toUri(file)
    if (fileChanges.isNewFile) {
      documentChanges.push({ kind: 'create', uri, options: { overwrite: false, ignoreIfExists: false } })
    }
    documentChanges.push({
      textDocument: { uri, version: null },
      edits: fileChanges.textChanges.map(tc => ({
        range: spanToRange(text, tc.span.start, tc.span.length),
        newText: tc.newText,
      })),
    })
  }
  return { documentChanges }
}

export function declarationNamesOf(
  ts: TsModule,
  statement: TS.Statement,
  sourceFile: TS.SourceFile,
): Array<{ name: string; start: number; end: number }> {
  const spanOf = (node: TS.Node): { name: string; start: number; end: number } => ({
    name: node.getText(sourceFile),
    start: node.getStart(sourceFile),
    end: node.end,
  })
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map(d => spanOf(d.name))
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name
  ) {
    return [spanOf(statement.name)]
  }
  return []
}

export const FORMAT_OPTIONS: TS.FormatCodeSettings = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: '\n',
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  semicolons: 'ignore' as TS.SemicolonPreference,
}
