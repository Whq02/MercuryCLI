#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const self = 'scripts/gate/prove-module-state.ts'
const table = 'scripts/gate/module-state.tsv'
const asset = { assets: table, generator: `bun ${self} --write`, check: `bun ${self}`, sources: `src/** ${self}` }
type Row = { path: string; name: string; shape: string; writes: Set<string>; line: number; init: string }
const mutation = new Set('set add delete deleteMany clear push pop shift unshift splice reverse sort copyWithin fill put append prepend insert remove replace assign setAttribute deleteProperty defineProperty defineProperties setPrototypeOf'.split(' '))
const reset = /^(?:clear|reset)/

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)) yield path
  }
}

function unwrap(n: ts.Node): ts.Node {
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression
  return n
}

function names(n: ts.BindingName): string[] {
  if (ts.isIdentifier(n)) return [n.text]
  return n.elements.flatMap(e => ts.isBindingElement(e) ? names(e.name) : [])
}

function receiver(node: ts.Node | undefined): string | undefined {
  if (!node) return
  const n = unwrap(node)
  if (ts.isIdentifier(n)) return n.text
  if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) return receiver(n.expression)
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(get|at)$/.test(n.expression.name.text)) return receiver(n.expression.expression)
  return undefined
}

function shapeOf(init: ts.Expression | undefined, sf: ts.SourceFile): [string, string] {
  if (!init) return ['', '']
  const n = unwrap(init)
  if (ts.isObjectLiteralExpression(n)) return ['object', '{}']
  if (ts.isArrayLiteralExpression(n)) return ['array', '[]']
  if (ts.isConditionalExpression(n)) {
    const a = shapeOf(n.whenTrue, sf)
    return a[0] ? a : shapeOf(n.whenFalse, sf)
  }
  if (ts.isNewExpression(n) || ts.isCallExpression(n)) {
    const expr = n.expression.getText(sf).slice(0, 96).replace(/\s+/g, ' ')
    if (ts.isNewExpression(n)) return [expr === 'OwnerScopedStore' ? 'store' : expr === 'AsyncLocalStorage' ? 'scope' : 'instance', expr]
    if (/^(?:Object\.(?:freeze|create|fromEntries|assign|groupBy|keys|values|entries)|Array(?:\.from|\.of)?|Map\.groupBy)$/.test(expr) || /\.(?:map|filter|slice|split|flatMap|concat|toSorted)$/.test(expr)) return ['derived', expr]
    if (/^(?:memoize|memoizeWith|memoizeOne|once)$/.test(expr)) return ['memo', expr]
    return ['factory', expr]
  }
  if (ts.isIdentifier(n)) return ['alias', n.text]
  return ['', '']
}

function declarations(path: string, source: string): Row[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const rows = new Map<string, Row>()
  const hooks = new Map<string, Row>()
  const add = (map: Map<string, Row>, name: string, shape: string, pos: number, init = '') => map.set(name, { path, name, shape, writes: new Set(), line: sf.getLineAndCharacterOfPosition(pos).line + 1, init })
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (ts.isVariableStatement(stmt)) {
      const kind = stmt.declarationList.flags & ts.NodeFlags.Const ? 'const' : stmt.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var'
      for (const d of stmt.declarationList.declarations) {
        const [shape, init] = shapeOf(d.initializer, sf)
        for (const name of names(d.name)) {
          add(rows, name, kind === 'const' ? shape || 'other' : kind, d.getStart(sf), init)
          if (exported && reset.test(name)) add(hooks, name, 'export-reset', d.getStart(sf))
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && exported && stmt.name && reset.test(stmt.name.text)) add(hooks, stmt.name.text, 'export-reset', stmt.getStart(sf))
    else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const e of stmt.exportClause.elements) if (!e.isTypeOnly && reset.test(e.name.text)) add(hooks, e.name.text, 'export-reset', e.getStart(sf))
    }
  }
  if (!rows.size) return [...hooks.values()]
  type Scope = Map<string, string | null>
  const scopes: Scope[] = []
  const rootOf = (name: string | undefined) => {
    if (!name) return null
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]!.has(name)) return scopes[i]!.get(name) ?? null
    return rows.has(name) ? name : null
  }
  let depth = 0
  const mark = (n: ts.Node | undefined, what: string, rebind = false) => {
    if (rebind && n && ts.isIdentifier(unwrap(n)) && scopes.some(scope => scope.has(receiver(n)!))) return
    const key = rootOf(receiver(n))
    if (key) rows.get(key)!.writes.add(`${depth ? 'fn' : 'load'}:${what}`)
  }
  function visit(n: ts.Node): void {
    if (ts.isTypeNode(n)) return
    const fn = ts.isFunctionLike(n)
    const scope = fn || ts.isBlock(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)
    if (scope) scopes.push(new Map())
    if (fn) {
      depth++
      for (const p of n.parameters) for (const key of names(p.name)) scopes.at(-1)!.set(key, null)
    }
    if (scopes.length && ts.isVariableDeclaration(n)) {
      const alias = rootOf(receiver(n.initializer))
      for (const key of names(n.name)) scopes.at(-1)!.set(key, alias)
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(n.left, '=', true)
    else if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) mark(n.operand, '++/--', true)
    else if (ts.isDeleteExpression(n)) mark(n.expression, 'delete')
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const { expression, name } = n.expression
      if (mutation.has(name.text)) {
        if (ts.isIdentifier(expression) && /^(Object|Reflect)$/.test(expression.text)) mark(n.arguments[0], name.text)
        else mark(expression, name.text)
      }
    }
    ts.forEachChild(n, visit)
    if (fn) depth--
    if (scope) scopes.pop()
  }
  visit(sf)
  return [...rows.values()].filter(r => !['alias', 'other'].includes(r.shape) || r.writes.size).concat([...hooks.values()])
}

type Kind = 'process' | 'owner' | 'call' | 'test'
type Entry = { kind: Kind; reason: string }
type Inventory = { entries: Map<string, Entry>; hooks: Set<string>; outside: number }
const keyOf = (row: Pick<Row, 'path' | 'name'>) => `${row.path}\t${row.name}`
const isKind = (word: string): word is Kind => ['process', 'owner', 'call', 'test'].includes(word)

function inventory(text: string): Inventory {
  const entries = new Map<string, Entry>()
  const hooks = new Set<string>()
  let outside = 0
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [file, name, kind, place, reason, extra] = line.split('\t')
    const key = `${file}\t${name}`
    if (kind === 'reset-export' && place === undefined) { hooks.add(key); continue }
    if (!file || !name || !kind || !isKind(kind) || !reason || extra !== undefined || !['module', 'store'].includes(place!)) throw new Error(`invalid row in ${table}: ${line}`)
    if (entries.has(key)) throw new Error(`duplicate binding in ${table}: ${key}`)
    entries.set(key, { kind, reason })
    if (kind === 'owner' && place === 'module') outside++
  }
  return { entries, hooks, outside }
}

function readDeclarations(file: string): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const [path, name, kind, reason, extra] = line.split('\t')
    if (!path || !name || !kind || !isKind(kind) || !reason || extra !== undefined) throw new Error(`expected path, binding, kind and reason in ${file}: ${line}`)
    entries.set(`${path}\t${name}`, { kind, reason })
  }
  return entries
}

function staticEntry(row: Row): Entry | undefined {
  if (row.writes.size || ['let', 'var', 'scope', 'store', 'memo'].includes(row.shape)) return undefined
  const reason = ['array', 'object', 'derived'].includes(row.shape) ? 'load-time data; no local writer'
    : row.shape === 'instance' && /^(?:Set|Map|RegExp|Intl\.NumberFormat|Intl\.Segmenter)$/.test(row.init) ? 'load-time lookup; no local writer'
    : row.shape === 'factory' && /^(?:z[\s.][\s\S]*|lazySchema|buildTool|makeLspTool|parseFrontmatter|createContext|React\.(?:memo|createContext)|path\.join|fileURLToPath|Symbol|String\.fromCharCode|Math\.round)$/.test(row.init) ? 'module definition evaluated once'
    : undefined
  return reason ? { kind: 'process', reason } : undefined
}

function hooksByFile(hooks: Set<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const key of hooks) {
    const file = key.slice(0, key.indexOf('\t'))
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return counts
}

function limits(now: Inventory, before: Inventory): string[] {
  const held = hooksByFile(before.hooks)
  const standing = hooksByFile(now.hooks)
  const grew = (key: string): boolean => {
    const file = key.slice(0, key.indexOf('\t'))
    return (standing.get(file) ?? 0) > (held.get(file) ?? 0)
  }
  const errors = [...now.hooks].filter(key => !before.hooks.has(key) && grew(key)).map(key => `${key}: remove the new reset/clear export; use an owner lifetime or a local fixture`)
  if (now.outside > before.outside) errors.push(`owner bindings outside a store grew from ${before.outside} to ${now.outside}; place the new owner state in a registered OwnerScopedStore`)
  return errors
}

function git(...args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }) } catch { return undefined }
}

function earlierTables(): string[] {
  const head = git('show', `HEAD:${table}`)
  if (head === undefined) return []
  const last = git('log', '-1', '--format=%H', '--', table)?.trim()
  const prior = last ? git('show', `${last}^:${table}`) : undefined
  return prior !== undefined && prior !== head ? [head, prior] : [head]
}

function selfCheck(): void {
  const rows = declarations('fixture.ts', `let serial = 0; const items = new Set(); const tags = []; const settings = {n: 1}; function change(){ const held = items; held.add(1); tags.push(2); settings.n++; serial++; } function separate(items = new Set()){ items.clear() } export function resetTags(){}; export { clearThing } from './other'`)
  const sets = new Map(rows.map(r => [r.name, `${r.shape}:${[...r.writes].sort().join(',')}`]))
  for (const [name, expected] of Object.entries({ serial: 'let:fn:++/--', items: 'instance:fn:add', tags: 'array:fn:push', settings: 'object:fn:++/--', resetTags: 'export-reset:', clearThing: 'export-reset:' })) {
    if (sets.get(name) !== expected) throw new Error(`${self}: ${name} should read ${expected}, got ${sets.get(name)}`)
  }
  const larger = inventory('src/a.ts\tsettings\towner\tmodule\tagent state\nsrc/a.ts\tresetTags\treset-export\n')
  if (limits(larger, inventory('')).length !== 2 || limits(inventory(''), larger).length) throw new Error(`${self}: both ratchets must accept removals and refuse additions`)
  const renamed = inventory('src/a.ts\tsettings\towner\tmodule\tagent state\nsrc/a.ts\tclearTags\treset-export\n')
  const second = inventory('src/a.ts\tsettings\towner\tmodule\tagent state\nsrc/a.ts\tresetTags\treset-export\nsrc/a.ts\tclearTags\treset-export\n')
  if (limits(renamed, larger).length || limits(second, larger).length !== 1) throw new Error(`${self}: a reset export renamed in its file is not a new one, and a second one in that file is`)
}

function main(): void {
  if (registerOnlyRequested(asset)) return
  selfCheck()
  const output = join(root, table)
  const prior = existsSync(output) ? readFileSync(output, 'utf8').replaceAll('\r\n', '\n') : undefined
  const held = inventory(prior ?? '')
  const input = process.argv.slice(2)
  const declare = input.indexOf('--declare')
  const writing = input.includes('--write')
  if (declare >= 0 && (!writing || !input[declare + 1])) throw new Error(`usage: bun ${self} --write [--declare <path/binding/kind/reason TSV>]`)
  const facts = declare >= 0 ? readDeclarations(input[declare + 1]!) : new Map<string, Entry>()
  const body: string[] = []
  const errors: string[] = []
  for (const path of sources('src')) {
    for (const row of declarations(path, readFileSync(join(root, path), 'utf8'))) {
      const key = keyOf(row)
      if (row.shape === 'export-reset') { body.push(`${key}\treset-export`); continue }
      const entry = facts.get(key) ?? held.entries.get(key) ?? staticEntry(row)
      if (!entry) { errors.push(`${path}:${row.line} ${row.name}: declare the binding's kind and lifetime with bun ${self} --write --declare <TSV>`); continue }
      const store = row.init === 'OwnerScopedStore'
      if (store && entry.kind !== 'owner') errors.push(`${key}: OwnerScopedStore must declare its owner's lifetime`)
      body.push(`${key}\t${entry.kind}\t${store ? 'store' : 'module'}\t${entry.reason}`)
    }
  }
  const text = `# Generated by bun ${self} --write\n# file\tbinding\tkind\tstorage\treason\n${body.sort().join('\n')}\n`
  const result = inventory(text)
  for (const previous of new Set([...(prior === undefined ? [] : [prior]), ...earlierTables()])) errors.push(...limits(result, inventory(previous)))
  if (!writing && prior !== text) {
    const seen = new Set((prior ?? '').split('\n'))
    const missing = body.filter(line => !seen.has(line))
    errors.push(`${table} does not match the tree (${missing.length} new or changed rows${missing.length ? `; first: ${missing[0]}` : ''}); run bun ${self} --write`)
  }
  if (errors.length) {
    for (const error of [...new Set(errors)].slice(0, 30)) console.error(error)
    throw new Error(`${self}: ${errors.length} inventory failures`)
  }
  if (writing) {
    if (text !== prior) writeFileSync(output, text)
    registerGeneratedAsset(asset)
  }
  console.log(`${table}: ${result.entries.size} declared bindings, ${result.outside} owner bindings outside a store, ${result.hooks.size} reset/clear exports`)
}

main()
