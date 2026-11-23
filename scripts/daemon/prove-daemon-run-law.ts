#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

const SELF = 'scripts/daemon/prove-daemon-run-law.ts'
const MAIN = 'src/daemon/control/main.ts'
const PARTS = 'src/daemon/run/'
const UNIT = 'daemonRun'
const STATE = 'DaemonRunState'
const LET_BUDGET = 4
const TWICE_BUDGET = 2
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
  const base = spec.startsWith('.') ? posix.join(posix.dirname(fromRel), spec) : spec.startsWith('src/') ? spec : null
  return base === null ? null : posix.normalize(base).replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/, '')
}

function heldByConst(declared: ts.VariableDeclaration, sf: ts.SourceFile): string | null {
  let value = declared.initializer
  if (value === undefined) return 'a value given elsewhere'
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) {
    if (ts.isAsExpression(value) && ts.isTypeReferenceNode(value.type) && value.type.typeName.getText(sf) === 'const' && ts.isArrayLiteralExpression(value.expression)) return null
    value = value.expression
  }
  if (ts.isLiteralExpression(value) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(value) && (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(value.operand)) return null
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return null
  const type = declared.type
  const readonlyList = type !== undefined && ((ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) || (ts.isTypeReferenceNode(type) && type.typeName.getText(sf) === 'ReadonlyArray'))
  if (ts.isArrayLiteralExpression(value)) return readonlyList ? null : 'a list that is not declared readonly'
  if (ts.isNewExpression(value)) return `a new ${value.expression.getText(sf)}`
  if (ts.isObjectLiteralExpression(value)) return 'an object'
  return ts.isCallExpression(value) ? 'what a call answered when the file was loaded' : 'a value worked out when the file was loaded'
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
  const partFiles: Array<{ sf: ts.SourceFile; rel: string }> = []
  const reassignable = (list: ts.VariableDeclarationList): boolean => (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Let || (list.flags & ts.NodeFlags.BlockScoped) === 0
  let unit: { sf: ts.SourceFile; body: ts.Block } | null = null
  for (const path of files) {
    const sf = program.getSourceFile(path)
    if (sf === undefined) continue
    const rel = slash(relative(root, path))
    const isPart = rel.startsWith(PARTS)
    if (isPart) {
      parts.push(rel)
      partFiles.push({ sf, rel })
      const interfaces = new Map(sf.statements.filter(ts.isInterfaceDeclaration).map(declared => [declared.name.text, declared]))
      const fieldsOf = (name: string, seen: Set<string>): void => {
        const declared = interfaces.get(name)
        if (declared === undefined || seen.has(name)) return
        seen.add(name)
        for (const member of declared.members) if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) stateFields.add(member.name.text)
        const extended = (node: ts.Node): void => {
          if (ts.isIdentifier(node)) fieldsOf(node.text, seen)
          ts.forEachChild(node, extended)
        }
        for (const clause of declared.heritageClauses ?? []) extended(clause)
      }
      fieldsOf(STATE, new Set())
      for (const statement of sf.statements) {
        if (!ts.isVariableStatement(statement)) continue
        const line = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
          findings.push({ law: 'module', file: rel, line, said: `${rel}:${line} keeps a variable at module level (${statement.declarationList.declarations.map(d => d.name.getText(sf)).join(', ')}): what a part remembers is a field of the state made in ${PARTS}state.ts, or a local of the function that arms it` })
          continue
        }
        for (const declared of statement.declarationList.declarations) {
          const holds = heldByConst(declared, sf)
          if (holds !== null) findings.push({ law: 'module', file: rel, line, said: `${rel}:${line} keeps ${declared.name.getText(sf)} at module level, a const that holds ${holds}: a const of a part is a literal, a function or a list declared readonly, and what a part remembers is a field of the state made in ${PARTS}state.ts, or a local of the function that arms it` })
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
          if (!ts.isVariableStatement(inner) || !reassignable(inner.declarationList)) continue
          lets += inner.declarationList.declarations.length
          letLines.push(sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1)
        }
      }
    }
  }
  const twice: string[] = []
  if (unit !== null) {
    const checker = program.getTypeChecker()
    const held = new Map<ts.Symbol, string>()
    const namesIn = (name: ts.BindingName): ts.Identifier[] => (ts.isIdentifier(name) ? [name] : name.elements.flatMap(element => (ts.isOmittedExpression(element) ? [] : namesIn(element.name))))
    const gather = (node: ts.Node): void => {
      if (ts.isVariableDeclarationList(node) && reassignable(node)) {
        for (const declared of node.declarations) {
          for (const named of namesIn(declared.name)) {
            const symbol = stateFields.has(named.text) ? checker.getSymbolAtLocation(named) : undefined
            if (symbol !== undefined) held.set(symbol, named.text)
          }
        }
      }
      ts.forEachChild(node, gather)
    }
    gather(unit.body)
    twice.push(...held.values())
    const heldNames = new Set(held.values())
    const localOf = (node: ts.Node): string | undefined => {
      const symbol = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node) : ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined
      return symbol === undefined ? undefined : held.get(symbol)
    }
    const fieldOf = (node: ts.Node): string | undefined =>
      ts.isPropertyAccessExpression(node) && heldNames.has(node.name.text) ? node.name.text : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && heldNames.has(node.argumentExpression.text) ? node.argumentExpression.text : undefined
    const targetsOf = (target: ts.Node): ts.Node[] => {
      if (ts.isParenthesizedExpression(target) || ts.isSpreadElement(target) || ts.isNonNullExpression(target)) return targetsOf(target.expression)
      if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap(targetsOf)
      if (ts.isObjectLiteralExpression(target)) return target.properties.flatMap(member => (ts.isShorthandPropertyAssignment(member) ? [member] : ts.isPropertyAssignment(member) ? targetsOf(member.initializer) : ts.isSpreadAssignment(member) ? targetsOf(member.expression) : []))
      if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) return targetsOf(target.left)
      return [target]
    }
    const statementOf = (node: ts.Node): ts.ExpressionStatement | undefined => {
      let outer = node.parent
      while (outer !== undefined && ts.isParenthesizedExpression(outer)) outer = outer.parent
      return outer !== undefined && ts.isExpressionStatement(outer) ? outer : undefined
    }
    const writeOf = (node: ts.Node): { at: ts.Node; targets: ts.Node[]; statement: ts.ExpressionStatement | undefined } | undefined => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return { at: node, targets: targetsOf(node.left), statement: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? statementOf(node) : undefined }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return { at: node, targets: [node.operand], statement: undefined }
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) return { at: node.initializer, targets: targetsOf(node.initializer), statement: undefined }
      return undefined
    }
    const wholeOf = (statement: ts.Node | undefined): ts.Expression | undefined => {
      let whole = statement !== undefined && ts.isExpressionStatement(statement) ? statement.expression : undefined
      while (whole !== undefined && ts.isParenthesizedExpression(whole)) whole = whole.expression
      return whole
    }
    const beside = (statement: ts.Node, step: 1 | -1): ts.Node | undefined => {
      const parent = statement.parent
      const all = parent !== undefined && (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isModuleBlock(parent)) ? parent.statements : undefined
      const place = all === undefined ? -1 : all.findIndex(sibling => sibling === statement)
      return place < 0 ? undefined : all![place + step]
    }
    const fieldWrittenBy = (statement: ts.Node | undefined): { name: string; right: ts.Expression } | undefined => {
      const whole = wholeOf(statement)
      if (whole === undefined || !ts.isBinaryExpression(whole) || whole.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined
      const name = fieldOf(whole.left)
      return name === undefined ? undefined : { name, right: whole.right }
    }
    const localsWrittenBy = (statement: ts.Node | undefined): string[] => {
      const whole = wholeOf(statement)
      const write = whole === undefined ? undefined : writeOf(whole)
      return write === undefined || write.statement === undefined ? [] : write.targets.flatMap(target => localOf(target) ?? [])
    }
    const scan = (sf: ts.SourceFile, rel: string): void => {
      const visit = (node: ts.Node): void => {
        const write = writeOf(node)
        if (write !== undefined) {
          const statement = write.statement
          const line = sf.getLineAndCharacterOfPosition(write.at.getStart(sf)).line + 1
          for (const target of write.targets) {
            const local = rel === MAIN ? localOf(target) : undefined
            const field = fieldOf(target)
            if (local !== undefined) {
              const next = statement === undefined ? undefined : fieldWrittenBy(beside(statement, 1))
              const handed = next !== undefined && next.name === local
              if (handed && localOf(next!.right) === local) continue
              findings.push({
                law: 'twice',
                file: rel,
                line,
                said: handed
                  ? `${MAIN}:${line} writes ${local}, which ${UNIT} holds beside the field state.${local}, and the next line hands \`${next!.right.getText(sf)}\` to the state where only the local's name stands (the same words read a second time can be a second value) — write \`state.${local} = ${local}\` on the line after it`
                  : `${MAIN}:${line} writes ${local}, which ${UNIT} holds beside the field state.${local}, and the next line does not hand the value to the state: the parts read state.${local} and would go on reading the old one — write \`state.${local} = ${local}\` on the line after it, or move the bodies that still read the local into their part and drop the local`,
              })
            } else if (field !== undefined) {
              if (rel === MAIN && statement !== undefined && write.targets.length === 1 && localsWrittenBy(beside(statement, -1)).includes(field)) continue
              findings.push({
                law: 'twice',
                file: rel,
                line,
                said:
                  rel === MAIN
                    ? `${MAIN}:${line} writes state.${field} with no write of the local ${field} on the line before it: ${UNIT} holds ${field} beside the field, and its bodies that read the local would go on reading the old one — write the local first and hand it over (\`${field} = …\`, then \`state.${field} = ${field}\`), or drop the local and read the field`
                    : `${rel}:${line} writes state.${field}, which ${UNIT} holds as a local too: ${UNIT} would go on reading its own old value — a part does not write a field that is held twice; write it in ${MAIN} beside the local, or move the bodies of ${UNIT} that read the local into their part and drop the local first`,
              })
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    scan(unit.sf, MAIN)
    for (const part of partFiles) scan(part.sf, part.rel)
  }
  return { findings, files: files.length, parts: parts.sort(), lets, letLines, twice }
}

function judge(reading: Reading, budget: number): string[] {
  const said = reading.findings.map(f => f.said)
  if (reading.lets === null) said.push(`${MAIN} holds no function ${UNIT}: the law counts the variables it declares with let or var — if the boot moved, name its new home in ${SELF}`)
  else if (reading.lets > budget) said.push(`${MAIN}: ${UNIT} declares ${reading.lets} variables with let or var at its top level (lines ${reading.letLines.join(', ')}) and holds ${budget}: a new one is a field of the state in ${PARTS}state.ts — add it there, with the part that owns it, and not to ${UNIT}`)
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
  plant(`${PARTS}part.ts`, `const LIMIT = 60_000\nconst BELOW = -1\nconst WORDS = 'said'\nconst STEPS: readonly string[] = ['first', WORDS]\nconst PAIR = ['a', 'b'] as const\nconst twice = (n: number): number => n * 2\nexport function part(): number {\n  return twice(LIMIT + BELOW + STEPS.length + PAIR.length)\n}\n`)
  plant(`${PARTS}state.ts`, `import { part } from './part.js'\nexport const made = (): number => part()\n`)
  plant('src/daemon/neighbour.ts', `export const near = 1\n`)
  const clean = readProgram(estate)
  check('a clean estate reads clean: the boot imports a part, a part imports a part and keeps constants (a literal, a function, a list declared readonly), the unit holds its three', judge(clean, 3).length === 0 && clean.lets === 3 && clean.parts.length === 2, JSON.stringify(judge(clean, 3)) + '; readProgram or judge in ' + SELF + ' flags or miscounts a clean estate')
  check('a let inside a block of the unit is not counted: the count is the unit\'s top level', clean.letLines.join() === '6,8', 'letLines read ' + clean.letLines.join() + ' where 6,8 was expected; readProgram in ' + SELF + ' must count only the lets at the top level of ' + UNIT)
  check('one let above what the unit holds is red, and the line says where the variable goes', judge(clean, 2).length === 1 && judge(clean, 2)[0]!.includes(`declares 3 variables with let or var`) && judge(clean, 2)[0]!.includes(`${PARTS}state.ts`), judge(clean, 2).join(' | ') + '; the let-budget line of judge in ' + SELF + ' must say how many were declared and name ' + PARTS + 'state.ts')
  plant('src/daemon/neighbour.ts', `import { part } from './run/part.js'\nexport const near = part()\n`)
  plant('src/screens/far.tsx', `export async function far(): Promise<unknown> {\n  return import('../daemon/run/state.js')\n}\n`)
  plant('src/cli/typed.ts', `export type Made = typeof import('../daemon/run/state.js').made\nexport const again = require('../daemon/run/part.js')\n`)
  plant('src/cli/rooted.ts', `import { part } from 'src/daemon/run/part.js'\nexport const rooted = part\n`)
  const outside = judge(readProgram(estate), 3)
  check('an import of a part planted outside is red by its own line: static, dynamic, in a type, by require, and spelled from the root as tsconfig.json lets it be', outside.length === 5 && ['src/daemon/neighbour.ts:1 imports src/daemon/run/part', 'src/screens/far.tsx:2 imports src/daemon/run/state', 'src/cli/typed.ts:1 imports src/daemon/run/state', 'src/cli/typed.ts:2 imports src/daemon/run/part', 'src/cli/rooted.ts:1 imports src/daemon/run/part'].every(head => outside.some(line => line.startsWith(head))), outside.join(' | ') + '; importsOf and the outside law of readProgram in ' + SELF + ' must find every way of importing a part')
  for (const rel of ['src/daemon/neighbour.ts', 'src/screens/far.tsx', 'src/cli/typed.ts', 'src/cli/rooted.ts']) rmSync(join(estate, rel))
  plant(`${PARTS}part.ts`, `import { daemonMain } from '../main.js'\nlet remembered = 0\nexport function part(): number {\n  remembered++\n  return daemonMain.length\n}\n`)
  const back = judge(readProgram(estate), 3)
  check('a part that imports the file that starts it is red, and so is a variable a part keeps at module level', back.length === 2 && back.some(line => line.startsWith(`${PARTS}part.ts:1 imports ${MAIN}`)) && back.some(line => line.startsWith(`${PARTS}part.ts:2 keeps a variable at module level (remembered)`)), back.join(' | ') + '; the back and module laws of readProgram in ' + SELF + ' must flag both')
  plant(`${PARTS}part.ts`, `import { daemonMain } from 'src/daemon/control/main.js'\nconst remembered = new Map<string, number>()\nconst table = { seen: 0 }\nconst open = ['a']\nconst read = String(daemonMain.length)\nexport function part(): number {\n  return remembered.size + table.seen + open.length + read.length\n}\n`)
  const rooted = judge(readProgram(estate), 3)
  check('the same import spelled from the root is red, and so is a const of a part that holds state: a map, an object, a list not declared readonly, what a call answered', rooted.length === 5 && rooted.some(line => line.startsWith(`${PARTS}part.ts:1 imports ${MAIN}`)) && ['2 keeps remembered at module level, a const that holds a new Map', '3 keeps table at module level, a const that holds an object', '4 keeps open at module level, a const that holds a list that is not declared readonly', '5 keeps read at module level, a const that holds what a call answered when the file was loaded'].every(head => rooted.some(line => line.startsWith(`${PARTS}part.ts:${head}`))), rooted.join(' | ') + '; heldByConst and the module law of readProgram in ' + SELF + ' must flag each of these consts')
  plant(`${PARTS}part.ts`, `export function part(): number {\n  return 1\n}\n`)
  plant(`${PARTS}state.ts`, `export interface ${STATE} {\n  held: number\n  other: number\n}\nexport function make(): ${STATE} {\n  return { held: 0, other: 0 }\n}\n`)
  const holding = (writes: string): string => `import { make } from '../run/state.js'\nasync function ${UNIT}(): Promise<void> {\n  let held = 0\n  let free = 1\n  const state = make()\n${writes}  const inner = (held: number): number => {\n    held = 9\n    return held + free\n  }\n  inner(state.held)\n}\n`
  plant(MAIN, holding(`  held = 2\n  state.held = held\n  free = 3\n`))
  const handed = readProgram(estate)
  check('a variable the unit holds beside a field of the state reads clean when each write hands the value over on the next line; a parameter of its name and a variable the state does not hold are not read', judge(handed, 3).length === 0 && handed.twice.join() === 'held', JSON.stringify([judge(handed, 3), handed.twice]) + '; the twice law of readProgram in ' + SELF + ' must accept a write handed over on the next line')
  plant(MAIN, holding(`  held = 2\n  free = 3\n  state.held = held\n  held++\n`))
  const kept = judge(readProgram(estate), 3)
  check('a write the next line does not hand to the state is red by its own line, and so are the hand-over that comes a line late and a step of the variable', kept.length === 3 && kept[0]!.startsWith(`${MAIN}:6 writes held`) && kept[0]!.includes('`state.held = held`') && kept[1]!.startsWith(`${MAIN}:8 writes state.held with no write of the local held on the line before it`) && kept[2]!.startsWith(`${MAIN}:9 writes held`), kept.join(' | ') + '; the twice law of readProgram in ' + SELF + ' (scan, fieldWrittenBy) must flag all three')
  plant(MAIN, holding(`  ;[held] = [2]\n  state.held = held\n  ;({ held } = { held: 3 })\n  for (held of [4]) free = held\n`))
  const shaped = judge(readProgram(estate), 3)
  check('a write by destructuring is a write, clean with its hand-over on the next line and red without, and the variable of a loop is a write no line hands over', shaped.length === 2 && shaped[0]!.startsWith(`${MAIN}:8 writes held`) && shaped[1]!.startsWith(`${MAIN}:9 writes held`), shaped.join(' | ') + '; writeOf and targetsOf in ' + SELF + ' must read destructuring and for-of as writes')
  plant(MAIN, holding(`  if (free > 0) {\n    let other = 1\n    other = 2\n  }\n  var roomy = 0\n`))
  const deep = readProgram(estate)
  check('a let in a block of the unit that the state holds too is held twice like one at the top, and a var at the top level is counted with the lets', deep.twice.join() === 'held,other' && judge(deep, 3).length === 1 && judge(deep, 3)[0]!.startsWith(`${MAIN}:8 writes other`) && deep.lets === 3 && judge(deep, 2).some(line => line.includes('declares 3 variables with let or var')), JSON.stringify([deep.twice, deep.lets, judge(deep, 3)]) + '; gather and the let count of readProgram in ' + SELF + ' must reach lets in nested blocks and count vars')
  plant(MAIN, holding(`  state.held = 5\n  held = free + 1\n  state.held = free + 1\n`))
  const alone = judge(readProgram(estate), 3)
  check('a write of the field with no write of the local before it is red, and so is a hand-over that repeats the words in place of the name of the local', alone.length === 2 && alone[0]!.startsWith(`${MAIN}:6 writes state.held with no write of the local held`) && alone[1]!.startsWith(`${MAIN}:7 writes held`) && alone[1]!.includes('hands `free + 1` to the state'), alone.join(' | ') + '; the twice law of readProgram in ' + SELF + ' must flag both writes')
  plant(MAIN, holding(`  held = 2\n  state.held = held\n`))
  plant(`${PARTS}part.ts`, `import type { ${STATE} } from './state.js'\nexport function part(state: ${STATE}): number {\n  state.held = 1\n  state.other = 2\n  return 1\n}\n`)
  const apart = judge(readProgram(estate), 3)
  check('a part that writes a field the unit still holds as a local is red, and a field held once is the part\'s to write', apart.length === 1 && apart[0]!.startsWith(`${PARTS}part.ts:3 writes state.held, which ${UNIT} holds as a local too`), apart.join(' | ') + '; the twice law of readProgram in ' + SELF + ' must flag a part writing a field that ' + UNIT + ' holds twice')
  plant(MAIN, `export const moved = 1\n`)
  check('a file with no such unit is red, not read as zero', judge(readProgram(estate), 3).some(line => line.includes(`holds no function ${UNIT}`)), 'judge in ' + SELF + ' must say that ' + MAIN + ' holds no function ' + UNIT + ' when the unit is missing')
  rmSync(estate, { recursive: true, force: true })
}

section(`§1 the program under ${slash(relative(process.cwd(), ROOT)) || '.'}: who imports the parts, what the parts import, and the variables ${UNIT} declares`)
{
  const reading = readProgram(ROOT)
  const said = judge(reading, LET_BUDGET)
  console.log(`  ${reading.files} files under src · ${reading.parts.length} under ${PARTS} (${reading.parts.map(p => p.slice(PARTS.length)).join(', ')}) · ${UNIT} declares ${reading.lets ?? 'no'} variables with let or var at its top level, holds ${LET_BUDGET}`)
  check(`no file outside ${MAIN} and ${PARTS} imports a file under ${PARTS}`, !reading.findings.some(f => f.law === 'outside'), reading.findings.filter(f => f.law === 'outside').map(f => f.said).join('\n      '))
  check(`no file under ${PARTS} imports ${MAIN}`, !reading.findings.some(f => f.law === 'back'), reading.findings.filter(f => f.law === 'back').map(f => f.said).join('\n      '))
  check(`no file under ${PARTS} keeps a variable at module level, nor a const that is not a literal, a function or a list declared readonly`, !reading.findings.some(f => f.law === 'module'), reading.findings.filter(f => f.law === 'module').map(f => f.said).join('\n      '))
  check(`${UNIT} declares no more variables with let or var than it holds (${LET_BUDGET}; the number may only fall)`, reading.lets !== null && reading.lets <= LET_BUDGET, said.filter(line => line.startsWith(`${MAIN}: `)).join('\n      '))
  if (reading.lets !== null && reading.lets < LET_BUDGET) console.log(`  ${UNIT} is ${LET_BUDGET - reading.lets} under what it holds: lower LET_BUDGET in ${SELF} to ${reading.lets}`)
  check(`every write of a variable ${UNIT} holds beside a field of the state hands the local to the state on the next line, and the field is written nowhere else (held twice, at any depth of ${UNIT}: ${reading.twice.join(', ') || 'none'})`, !reading.findings.some(f => f.law === 'twice'), reading.findings.filter(f => f.law === 'twice').map(f => f.said).join('\n      '))
  check(`${UNIT} declares no more variables with let or var, at any depth, by the name of a field of the state than ${TWICE_BUDGET} (the number may only fall)`, reading.twice.length <= TWICE_BUDGET, `${reading.twice.length} (${reading.twice.join(', ')}): a variable of ${UNIT} that the state holds too is the field alone — read and write state.<name> in ${MAIN} and declare no local for it`)
  if (reading.twice.length < TWICE_BUDGET) console.log(`  ${UNIT} holds ${TWICE_BUDGET - reading.twice.length} fewer than that: lower TWICE_BUDGET in ${SELF} to ${reading.twice.length}`)
  check('the parts stand where the law reads them', reading.parts.includes(`${PARTS}state.ts`), `${PARTS}state.ts is not among the files read`)
}

console.log(`\nprove-daemon-run-law: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
