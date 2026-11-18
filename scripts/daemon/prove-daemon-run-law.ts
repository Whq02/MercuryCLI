#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

const SELF = 'scripts/daemon/prove-daemon-run-law.ts'
const MAIN = 'src/daemon/main.ts'
const PARTS = 'src/daemon/run/'
const UNIT = 'daemonRun'
const STATE = 'DaemonRunState'
const LET_BUDGET = 5
const TWICE_BUDGET = 3
const rootAt = process.argv.indexOf('--root')
const ROOT = resolve(rootAt < 0 ? join(import.meta.dir, '..', '..') : process.argv[rootAt + 1]!)

type Finding = { law: 'outside' | 'back' | 'let' | 'module' | 'twice'; file: string; line: number; said: string }
type Reading = { findings: Finding[]; files: number; parts: string[]; lets: number | null; letLines: number[]; twice: string[] }

const slash = (p: string): string => p.split('\\').join('/')

function sourcesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
    }
  }
  walk(join(root, 'src'))
  return out
}

function importsOf(sf: ts.SourceFile): Array<{ spec: string; line: number }> {
  const found: Array<{ spec: string; line: number }> = []
  const note = (node: ts.Node, spec: ts.Expression | undefined): void => {
    if (spec !== undefined && ts.isStringLiteralLike(spec)) found.push({ spec: spec.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) note(node, node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) note(node, node.moduleReference.expression)
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) note(node, node.arguments[0])
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) note(node, node.argument.literal as ts.Expression)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function targetOf(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(fromRel), spec)).replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/, '')
}

function readProgram(root: string): Reading {
  const files = sourcesUnder(root)
  const program = ts.createProgram(files, { noResolve: true, noLib: true, allowJs: false, skipLibCheck: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve })
  const findings: Finding[] = []
  const parts: string[] = []
  const mainTarget = MAIN.replace(/\.ts$/, '')
  let lets: number | null = null
  const letLines: number[] = []
  const stateFields = new Set<string>()
  let unit: { sf: ts.SourceFile; body: ts.Block } | null = null
  for (const path of files) {
    const sf = program.getSourceFile(path)
    if (sf === undefined) continue
    const rel = slash(relative(root, path))
    const isPart = rel.startsWith(PARTS)
    if (isPart) {
      parts.push(rel)
      for (const statement of sf.statements) {
        if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== STATE) continue
        for (const member of statement.members) if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) stateFields.add(member.name.text)
      }
      for (const statement of sf.statements) {
        if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
          const line = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1
          findings.push({ law: 'module', file: rel, line, said: `${rel}:${line} keeps a variable at module level (${statement.declarationList.declarations.map(d => d.name.getText(sf)).join(', ')}): what a part remembers is a field of the state made in ${PARTS}state.ts, or a local of the function that arms it` })
        }
      }
    }
    for (const { spec, line } of importsOf(sf)) {
      const target = targetOf(rel, spec)
      if (target === null) continue
      if (target.startsWith(PARTS) && !isPart && rel !== MAIN) findings.push({ law: 'outside', file: rel, line, said: `${rel}:${line} imports ${target}: a part of the daemon's run is reached through ${MAIN} alone — take the import out of ${rel}, and if it needs what the part does, hand it over from ${UNIT} or move that piece out of ${PARTS} into a file of src/daemon/` })
      if (isPart && target === mainTarget) findings.push({ law: 'back', file: rel, line, said: `${rel}:${line} imports ${MAIN}: a part takes the state and a named interface, never the file that starts it — pass what it needs from ${UNIT} as a member of the part's interface` })
    }
    if (rel === MAIN) {
      for (const statement of sf.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== UNIT || statement.body === undefined) continue
        unit = { sf, body: statement.body }
        lets = 0
        for (const inner of statement.body.statements) {
          if (!ts.isVariableStatement(inner) || (inner.declarationList.flags & ts.NodeFlags.Let) === 0) continue
          lets += inner.declarationList.declarations.length
          letLines.push(sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1)
        }
      }
    }
  }
  const twice: string[] = []
  if (unit !== null) {
    const { sf, body } = unit
    const checker = program.getTypeChecker()
    const held = new Map<ts.Symbol, string>()
    for (const inner of body.statements) {
      if (!ts.isVariableStatement(inner) || (inner.declarationList.flags & ts.NodeFlags.Let) === 0) continue
      for (const declared of inner.declarationList.declarations) {
        const symbol = ts.isIdentifier(declared.name) && stateFields.has(declared.name.text) ? checker.getSymbolAtLocation(declared.name) : undefined
        if (symbol !== undefined) held.set(symbol, declared.name.getText(sf))
      }
    }
    twice.push(...held.values())
    const heldName = (node: ts.Node): string | undefined => {
      const symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined
      return symbol === undefined ? undefined : held.get(symbol)
    }
    const handsOver = (next: ts.Node | undefined, name: string, value: string): boolean => next !== undefined && ts.isExpressionStatement(next) && ts.isBinaryExpression(next.expression) && next.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && next.expression.left.getText(sf) === `state.${name}` && [name, value].includes(next.expression.right.getText(sf))
    const visit = (node: ts.Node): void => {
      const assigned = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      const stepped = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      const name = assigned ? heldName(node.left) : stepped ? heldName(node.operand) : undefined
      if (name !== undefined) {
        const statement = node.parent
        const siblings = ts.isExpressionStatement(statement) && (ts.isBlock(statement.parent) || ts.isCaseClause(statement.parent) || ts.isDefaultClause(statement.parent)) ? statement.parent.statements : undefined
        const next = siblings === undefined ? undefined : siblings[siblings.findIndex(sibling => sibling === statement) + 1]
        const plain = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        if (!plain || !handsOver(next, name, (node as ts.BinaryExpression).right.getText(sf))) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          findings.push({ law: 'twice', file: MAIN, line, said: `${MAIN}:${line} writes ${name}, which ${UNIT} holds beside the field state.${name}, and the next line does not hand the value to the state: the parts read state.${name} and would go on reading the old one — write \`state.${name} = ${name}\` on the line after it, or move the bodies that still read the local into their part and drop the local` })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
  }
  return { findings, files: files.length, parts: parts.sort(), lets, letLines, twice }
}

function judge(reading: Reading, budget: number): string[] {
  const said = reading.findings.map(f => f.said)
  if (reading.lets === null) said.push(`${MAIN} holds no function ${UNIT}: the law counts the variables it declares with let — if the boot moved, name its new home in ${SELF}`)
  else if (reading.lets > budget) said.push(`${MAIN}: ${UNIT} declares ${reading.lets} variables with let at its top level (lines ${reading.letLines.join(', ')}) and holds ${budget}: a new one is a field of the state in ${PARTS}state.ts — add it there, with the part that owns it, and not to ${UNIT}`)
  return said
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('§0 the reader on a planted estate: each of the laws is red by its own line')
{
  const estate = mkdtempSync(join(tmpdir(), 'daemon-run-law-'))
  const plant = (rel: string, text: string): void => {
    mkdirSync(dirname(join(estate, rel)), { recursive: true })
    writeFileSync(join(estate, rel), text)
  }
  plant(MAIN, `import { part } from './run/part.js'\nexport async function daemonMain(): Promise<void> {\n  await ${UNIT}()\n}\nasync function ${UNIT}(): Promise<void> {\n  let first = 1\n  const fixed = 2\n  let second = 3, third = 4\n  if (fixed > first) {\n    let inner = 5\n    first = inner + second + third\n  }\n  part()\n}\n`)
  plant(`${PARTS}part.ts`, `export function part(): number {\n  return 1\n}\n`)
  plant(`${PARTS}state.ts`, `import { part } from './part.js'\nexport const made = part()\n`)
  plant('src/daemon/neighbour.ts', `export const near = 1\n`)
  const clean = readProgram(estate)
  check('a clean estate reads clean: the boot imports a part, a part imports a part, the unit holds its three', judge(clean, 3).length === 0 && clean.lets === 3 && clean.parts.length === 2, JSON.stringify(judge(clean, 3)))
  check('a let inside a block of the unit is not counted: the count is the unit\'s top level', clean.letLines.join() === '6,8')
  check('one let above what the unit holds is red, and the line says where the variable goes', judge(clean, 2).length === 1 && judge(clean, 2)[0]!.includes(`declares 3 variables with let`) && judge(clean, 2)[0]!.includes(`${PARTS}state.ts`), judge(clean, 2).join(' | '))
  plant('src/daemon/neighbour.ts', `import { part } from './run/part.js'\nexport const near = part()\n`)
  plant('src/screens/far.tsx', `export async function far(): Promise<unknown> {\n  return import('../daemon/run/state.js')\n}\n`)
  plant('src/cli/typed.ts', `export type Made = typeof import('../daemon/run/state.js').made\nexport const again = require('../daemon/run/part.js')\n`)
  const outside = judge(readProgram(estate), 3)
  check('an import of a part planted outside is red by its own line: static, dynamic, in a type and by require', outside.length === 4 && ['src/daemon/neighbour.ts:1 imports src/daemon/run/part', 'src/screens/far.tsx:2 imports src/daemon/run/state', 'src/cli/typed.ts:1 imports src/daemon/run/state', 'src/cli/typed.ts:2 imports src/daemon/run/part'].every(head => outside.some(line => line.startsWith(head))), outside.join(' | '))
  for (const rel of ['src/daemon/neighbour.ts', 'src/screens/far.tsx', 'src/cli/typed.ts']) rmSync(join(estate, rel))
  plant(`${PARTS}part.ts`, `import { daemonMain } from '../main.js'\nlet remembered = 0\nexport function part(): number {\n  remembered++\n  return daemonMain.length\n}\n`)
  const back = judge(readProgram(estate), 3)
  check('a part that imports the file that starts it is red, and so is a variable a part keeps at module level', back.length === 2 && back.some(line => line.startsWith(`${PARTS}part.ts:1 imports ${MAIN}`)) && back.some(line => line.startsWith(`${PARTS}part.ts:2 keeps a variable at module level (remembered)`)), back.join(' | '))
  plant(`${PARTS}part.ts`, `export function part(): number {\n  return 1\n}\n`)
  plant(`${PARTS}state.ts`, `export interface ${STATE} {\n  held: number\n  other: number\n}\nexport function make(): ${STATE} {\n  return { held: 0, other: 0 }\n}\n`)
  const holding = (writes: string): string => `import { make } from './run/state.js'\nasync function ${UNIT}(): Promise<void> {\n  let held = 0\n  let free = 1\n  const state = make()\n${writes}  const inner = (held: number): number => {\n    held = 9\n    return held + free\n  }\n  inner(state.held)\n}\n`
  plant(MAIN, holding(`  held = 2\n  state.held = held\n  free = 3\n`))
  const handed = readProgram(estate)
  check('a variable the unit holds beside a field of the state reads clean when each write hands the value over on the next line; a parameter of its name and a variable the state does not hold are not read', judge(handed, 3).length === 0 && handed.twice.join() === 'held', JSON.stringify([judge(handed, 3), handed.twice]))
  plant(MAIN, holding(`  held = 2\n  free = 3\n  state.held = held\n  held++\n`))
  const kept = judge(readProgram(estate), 3)
  check('a write the next line does not hand to the state is red by its own line, and so is a step of it', kept.length === 2 && kept[0]!.startsWith(`${MAIN}:6 writes held`) && kept[0]!.includes('`state.held = held`') && kept[1]!.startsWith(`${MAIN}:9 writes held`), kept.join(' | '))
  plant(MAIN, `export const moved = 1\n`)
  check('a file with no such unit is red, not read as zero', judge(readProgram(estate), 3).some(line => line.includes(`holds no function ${UNIT}`)))
  rmSync(estate, { recursive: true, force: true })
}

section(`§1 the program under ${slash(relative(process.cwd(), ROOT)) || '.'}: who imports the parts, what the parts import, and the variables ${UNIT} declares`)
{
  const reading = readProgram(ROOT)
  const said = judge(reading, LET_BUDGET)
  console.log(`  ${reading.files} files under src · ${reading.parts.length} under ${PARTS} (${reading.parts.map(p => p.slice(PARTS.length)).join(', ')}) · ${UNIT} declares ${reading.lets ?? 'no'} variables with let at its top level, holds ${LET_BUDGET}`)
  check(`no file outside ${MAIN} and ${PARTS} imports a file under ${PARTS}`, !reading.findings.some(f => f.law === 'outside'), reading.findings.filter(f => f.law === 'outside').map(f => f.said).join('\n      '))
  check(`no file under ${PARTS} imports ${MAIN}`, !reading.findings.some(f => f.law === 'back'), reading.findings.filter(f => f.law === 'back').map(f => f.said).join('\n      '))
  check(`no file under ${PARTS} keeps a variable at module level`, !reading.findings.some(f => f.law === 'module'), reading.findings.filter(f => f.law === 'module').map(f => f.said).join('\n      '))
  check(`${UNIT} declares no more variables with let than it holds (${LET_BUDGET}; the number may only fall)`, reading.lets !== null && reading.lets <= LET_BUDGET, said.filter(line => line.startsWith(`${MAIN}: `)).join('\n      '))
  if (reading.lets !== null && reading.lets < LET_BUDGET) console.log(`  ${UNIT} is ${LET_BUDGET - reading.lets} under what it holds: lower LET_BUDGET in ${SELF} to ${reading.lets}`)
  check(`every write of a variable ${UNIT} holds beside a field of the state hands the value to the state on the next line (held twice: ${reading.twice.join(', ') || 'none'})`, !reading.findings.some(f => f.law === 'twice'), reading.findings.filter(f => f.law === 'twice').map(f => f.said).join('\n      '))
  check(`${UNIT} holds no more variables beside a field of the state than ${TWICE_BUDGET} (the number may only fall)`, reading.twice.length <= TWICE_BUDGET, `${reading.twice.length} (${reading.twice.join(', ')}): a variable of ${UNIT} that the state holds too is the field alone — read and write state.<name> in ${MAIN} and declare no local for it`)
  if (reading.twice.length < TWICE_BUDGET) console.log(`  ${UNIT} holds ${TWICE_BUDGET - reading.twice.length} fewer than that: lower TWICE_BUDGET in ${SELF} to ${reading.twice.length}`)
  check('the parts stand where the law reads them', reading.parts.includes(`${PARTS}state.ts`), `${PARTS}state.ts is not among the files read`)
}

console.log(`\nprove-daemon-run-law: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
