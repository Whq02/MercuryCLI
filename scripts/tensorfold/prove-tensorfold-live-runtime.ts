import { readFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import ts from 'typescript'

const file = join(import.meta.dir, 'measure-tensorfold-adapter-live.ts')
const text = readFileSync(file, 'utf8')
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
let expression: string | undefined
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === 'node') expression = declaration.initializer?.getText(source)
  }
}
if (expression === undefined) throw new Error('The live adapter measure has no node runtime selection.')
const select = new Function('ROOT', 'process', 'join', 'existsSync', 'nodeBinPath', `return ${expression}`) as (root: string, proc: unknown, joinPath: typeof join, exists: (path: string) => boolean, resolve: () => string) => string | undefined
let failures = 0
for (const platform of ['win32', 'darwin', 'linux'] as const) {
  const paths = platform === 'win32' ? win32 : posix
  const root = platform === 'win32' ? 'C:\\source' : '/source'
  const binary = platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/runtime/bin/node'
  const env = { PATH: platform === 'win32' ? 'C:\\Windows\\System32;C:\\Program Files\\nodejs' : '/usr/bin:/runtime/bin' }
  const selected = select(root, { platform, arch: 'x64', env }, paths.join, path => path === binary, () => binary)
  const ok = selected === binary
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${platform}: the live measure reaches the Node executable on PATH${ok ? '' : ` — selected ${selected}`}`)
}
const shared = source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '../lib/nodeBin.ts' && statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(element => element.name.text === 'nodeBinPath'))
if (!shared) failures++
console.log(`[${shared ? 'PASS' : 'FAIL'}] the shared Node identity resolver owns the platform and MERCURY_NODE lookup`)
console.log(`${4 - failures}/4 checks passed`)
process.exit(failures === 0 ? 0 : 1)
