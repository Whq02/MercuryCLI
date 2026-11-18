import { relative, resolve } from 'node:path'
import ts from 'typescript'

const REPO = resolve(import.meta.dir, '..', '..')
const ENTRY = resolve(REPO, 'src', 'utils', 'healthReport.ts')
const LIST_EXPORT = 'HEALTH_SECTIONS'

export interface RowLiteral {
  file: string
  line: number
  row: string | null
  unit: string | null
  text: string
}

export interface RowLiteralRead {
  files: string[]
  rows: string[]
  literals: RowLiteral[]
  ms: number
}

export const LITERAL_BAN_LINE =
  'a ban over literals: about half of the rows\' code runs in no state a proof can seed, so a run of the report cannot hold a word out of an arm it never reaches; every string of the row modules is read through the compiler program, which follows the report\'s own import of the list and opens no file as text'

function programFor(entry: string): ts.Program {
  const configPath = ts.findConfigFile(REPO, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('tsconfig.json not found')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO)
  return ts.createProgram([entry], { ...parsed.options, noEmit: true, skipLibCheck: true })
}

function moduleFiles(program: ts.Program, entry: ts.SourceFile): ts.SourceFile[] {
  const checker = program.getTypeChecker()
  const imported = (file: ts.SourceFile): ts.SourceFile[] => {
    const out: ts.SourceFile[] = []
    const visit = (node: ts.Node): void => {
      const spec = ts.isImportDeclaration(node) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
      const target = spec && ts.isStringLiteralLike(spec) ? checker.getSymbolAtLocation(spec)?.valueDeclaration : undefined
      if (target && ts.isSourceFile(target) && !out.includes(target)) out.push(target)
      ts.forEachChild(node, visit)
    }
    visit(file)
    return out
  }
  const list = imported(entry).find(file => {
    const module = checker.getSymbolAtLocation(file)
    return module !== undefined && checker.getExportsOfModule(module).some(symbol => symbol.name === LIST_EXPORT)
  })
  return list ? [entry, list, ...imported(list).filter(file => file !== entry)] : [entry]
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    if (parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true
    if (ts.isIdentifier(parent.expression) && parent.expression.text === 'require') return true
  }
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true
  return false
}

function rowIdOf(node: ts.ObjectLiteralExpression): string | null {
  let id: string | null = null
  let runs = false
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property) && !ts.isShorthandPropertyAssignment(property)) continue
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : null
    if (name === 'run') runs = true
    if (name === 'id' && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) id = property.initializer.text
    if (name === 'id' && ts.isPropertyAssignment(property) && ts.isTemplateExpression(property.initializer)) id = `${property.initializer.head.text}*`
  }
  return runs ? id : null
}

function unitNameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isSourceFile(node.parent.parent.parent)) return node.name.text
  return null
}

function literalsOf(file: ts.SourceFile): RowLiteral[] {
  const out: RowLiteral[] = []
  const name = relative(REPO, file.fileName).split('\\').join('/')
  const visit = (node: ts.Node, row: string | null, unit: string | null): void => {
    const rowHere = ts.isObjectLiteralExpression(node) ? (rowIdOf(node) ?? row) : row
    const unitHere = unitNameOf(node) ?? unit
    const push = (text: string): void => {
      out.push({ file: name, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, row: rowHere, unit: unitHere, text })
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModuleSpecifier(node)) push(node.text)
    else if (ts.isTemplateExpression(node)) push([node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' '))
    else if (ts.isJsxText(node) && node.text.trim().length > 0) push(node.text)
    ts.forEachChild(node, child => visit(child, rowHere, unitHere))
  }
  visit(file, null, null)
  return out
}

export function literalsOfSource(fileName: string, source: string): RowLiteral[] {
  return literalsOf(ts.createSourceFile(resolve(REPO, fileName), source, ts.ScriptTarget.Latest, true))
}

let read: RowLiteralRead | null = null

export function healthRowLiterals(): RowLiteralRead {
  if (read !== null) return read
  const started = Date.now()
  const program = programFor(ENTRY)
  const entry = program.getSourceFile(ENTRY)
  if (!entry) throw new Error('the health report did not load into the compiler program')
  const files = moduleFiles(program, entry)
  const literals = files.flatMap(file => literalsOf(file))
  read = {
    files: files.map(file => relative(REPO, file.fileName).split('\\').join('/')),
    rows: [...new Set(literals.flatMap(literal => (literal.row === null ? [] : [literal.row])))],
    literals,
    ms: Date.now() - started,
  }
  return read
}
