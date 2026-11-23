#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { flagRegistryFiles } from '../lib/flagRegistrySource.ts'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { ModuleCache, calleeName, declarationOf, importOf, lineOf, returnedExpressions, slash, unwrap, visit } from './sourceCensus.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TABLE = 'scripts/gate/feature-map.tsv'
const HEADER = 'kind\tfeature\tproof\thow'
const NONE_FLOOR = 74
const DOOR = 'src/substrate/featureReached.ts'
const kinds = ['command', 'screen', 'tool', 'verb'] as const
const cache = new ModuleCache(ROOT)
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const syntax = (file: string) => {
  const parsed = cache.get(resolve(ROOT, file))
  if (!parsed) throw Error(`${file}: cannot read its feature declarations`)
  return parsed.sf
}
const location = (n: ts.Node) => `${slash(relative(ROOT, n.getSourceFile().fileName))}:${lineOf(n)}`
function fail(n: ts.Node, message: string): never { throw Error(`${location(n)}: ${message}`) }
function nodes<T extends ts.Node>(root: ts.Node, pick: (node: ts.Node) => node is T): T[] {
  const out: T[] = []
  visit(root, n => { if (pick(n)) out.push(n) })
  return out
}
function variable(sf: ts.SourceFile, name: string): ts.VariableDeclaration {
  const decl = nodes(sf, ts.isVariableDeclaration).find(d => ts.isIdentifier(d.name) && d.name.text === name)
  if (!decl?.initializer) throw Error(`${sf.fileName}: find ${name}'s catalogue and update the feature census`)
  return decl
}
function moduleSource(from: ts.Node, spec: string): ts.SourceFile {
  const target = ts.resolveModuleName(spec, from.getSourceFile().fileName, { moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve }, ts.sys).resolvedModule
  if (!target) fail(from, `cannot resolve the feature import ${spec}`)
  return syntax(target.resolvedFileName)
}
function exported(sf: ts.SourceFile, name: string): ts.Node {
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && name === 'default') return stmt.expression
    if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) for (const el of stmt.exportClause.elements) if (el.name.text === name) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) return exported(moduleSource(stmt, stmt.moduleSpecifier.text), (el.propertyName ?? el.name).text)
      const d = declarationOf(el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name as ts.Identifier)
      if (d) return d
    }
  }
  throw Error(`${sf.fileName}: no feature declaration for ${name}`)
}
function nodeEnvIs(test: ts.Expression): string | undefined {
  return ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isPropertyAccessExpression(test.left) && test.left.name.text === 'NODE_ENV' && ts.isPropertyAccessExpression(test.left.expression) && test.left.expression.name.text === 'env' && ts.isIdentifier(test.left.expression.expression) && test.left.expression.expression.text === 'process' && ts.isStringLiteral(test.right) ? test.right.text : undefined
}
function featureNames(raw: ts.Node, seen = new Set<ts.Node>()): string[] {
  const n = ts.isExpression(raw) ? unwrap(raw) : raw
  if (seen.has(n)) fail(n, 'cycle resolving feature name')
  const next = (v: ts.Node) => featureNames(v, new Set([...seen, n]))
  if (ts.isStringLiteralLike(n)) return [n.text]
  if (ts.isIdentifier(n)) {
    const d = declarationOf(n)
    if (d) {
      const ref = importOf(d)
      return next(ref ? exported(moduleSource(d, ref.module), ref.name) : d)
    }
  }
  const imported = importOf(n)
  if (imported) return next(exported(moduleSource(n, imported.module), imported.name))
  if (ts.isVariableDeclaration(n) && n.initializer) return next(n.initializer)
  if (ts.isSpreadElement(n)) return next(n.expression)
  if (ts.isArrayLiteralExpression(n)) return n.elements.flatMap(next)
  if (ts.isConditionalExpression(n)) {
    const env = nodeEnvIs(n.condition)
    if (env !== undefined) return next(env === 'production' ? n.whenTrue : n.whenFalse)
    return [...next(n.whenTrue), ...next(n.whenFalse)]
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const env = nodeEnvIs(n.left)
    return env !== undefined && env !== 'production' ? [] : next(n.right)
  }
  if (ts.isArrowFunction(n) || ts.isFunctionDeclaration(n)) return returnedExpressions(n).flatMap(next)
  if (ts.isObjectLiteralExpression(n)) {
    const prop = n.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'name')
    if (prop && ts.isPropertyAssignment(prop)) return next(prop.initializer)
    for (const prop of n.properties) if (ts.isSpreadAssignment(prop)) return next(prop.expression)
  }
  if (ts.isCallExpression(n)) {
    if (calleeName(n) === 'swarmTools') return next(exported(syntax('src/services/crewBoard/implementation.ts'), 'tool'))
    if (n.arguments.length > 0) return next(n.arguments[0]!)
    return next(n.expression)
  }
  return fail(n, `cannot resolve feature name from ${n.getText().slice(0, 70)}; follow the new catalogue shape`)
}
function commandWords(call: ts.CallExpression): string[] {
  const arg = call.arguments[0]!
  if (ts.isStringLiteralLike(arg)) return [arg.text.split(' ')[0]!]
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) if (ts.isForOfStatement(n)) {
    const rows = unwrap(n.expression)
    if (ts.isArrayLiteralExpression(rows)) return rows.elements.map(e => {
      if (!ts.isArrayLiteralExpression(e) || !ts.isStringLiteralLike(e.elements[0]!)) fail(e, 'unreadable CLI command list')
      return (e.elements[0] as ts.StringLiteralLike).text.split(' ')[0]!
    })
  }
  return fail(call, 'cannot resolve the CLI registration')
}
function commanderVerbs(): string[] {
  const verbs: string[] = []
  const inputs = ['src/main/subcommands.ts', 'src/main/sessionDoors.ts', 'src/commands/mcp/addCommand.ts', 'src/cli/tuneDoor.ts']
  for (const file of inputs) for (const action of nodes(syntax(file), ts.isCallExpression)) {
    if (calleeName(action) !== 'action') continue
    let e: ts.Expression = action.expression
    let words: string[] = []
    while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) {
      if (ts.isCallExpression(e) && calleeName(e) === 'command') words = commandWords(e)
      e = e.expression
    }
    if (!ts.isIdentifier(e)) fail(e, 'unknown CLI group')
    if (!words.length && e.text !== 'program') {
      const d = declarationOf(e)
      if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !ts.isCallExpression(d.initializer) || calleeName(d.initializer) !== 'command') fail(e, 'unresolved CLI action')
      verbs.push(...commandWords(d.initializer))
    } else if (words.length) verbs.push(...words.map(word => e.text === 'program' ? word : `${e.text} ${word}`))
    else verbs.push('interactive')
  }
  return verbs
}
function catalogue(): Set<string> {
  const keys = new Set<string>()
  const add = (kind: string, names: string[]) => { for (const name of names) keys.add(`${kind}\t${name}`) }
  add('command', featureNames(variable(syntax('src/commands.ts'), 'COMMANDS')))
  add('tool', featureNames(variable(syntax('src/tools.ts'), 'candidates')))
  add('tool', featureNames(variable(syntax('src/tools/SyntheticOutputTool/SyntheticOutputTool.ts'), 'SyntheticOutputTool')))
  const auth = nodes(syntax('src/tools/McpAuthTool/McpAuthTool.ts'), ts.isCallExpression).find(c => calleeName(c) === 'buildMcpToolName')
  if (!auth || !auth.arguments[1] || !ts.isStringLiteral(auth.arguments[1])) throw Error('resolve the server-specific MCP authentication tool in the feature census')
  add('tool', [`mcp__<server>__${auth.arguments[1].text}`])
  add('verb', commanderVerbs())
  const entry = syntax('src/entrypoints/cli.tsx')
  const version = nodes(entry, ts.isIfStatement).find(n => nodes(n.expression, ts.isStringLiteral).some(l => l.text === '--version'))
  if (version) add('verb', ['--version'])
  const acp = nodes(entry, ts.isIfStatement).find(n => nodes(n.thenStatement, ts.isReturnStatement).some(r => r.expression && ts.isCallExpression(r.expression) && calleeName(r.expression) === 'runAcpLoginScreen'))
  if (acp) add('verb', ['acp --login'])
  const surface = nodes(syntax('src/context/surfaceRoute.ts'), ts.isTypeAliasDeclaration).find(t => t.name.text === 'SurfaceKind')
  if (!surface) throw Error('find the surface kinds for the feature census')
  add('screen', nodes(surface.type, ts.isStringLiteral).map(l => l.text))
  const directScreens = [
    ['src/dialogLaunchers.tsx', 'ResumeConversation'],
    ['src/components/Settings/config/ConfigViews.tsx', 'MediaConfigPicker'],
    ['src/components/PromptInput/composerView.tsx', 'HistorySearchInput'],
    ['src/components/permissions/PermissionRequest.tsx', 'ChangeSetPermissionRequest', 'MediaPermissionRequest'],
  ]
  for (const [file, ...names] of directScreens) {
    const mounted = nodes(syntax(file!), ts.isJsxSelfClosingElement).map(n => n.tagName.getText())
    add('screen', mounted.filter(n => names.includes(n)))
  }
  for (const c of nodes(syntax('src/components/bootSplash/rowActions.ts'), ts.isCaseClause)) if (ts.isStringLiteral(c.expression) && c.statements.some(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && /^set\w+Open$/.test(calleeName(s.expression) ?? ''))) add('screen', [c.expression.text])
  return keys
}

const sites: [string, string, string, number][] = [
  ['command', 'src/services/processUserInput/processSlashCommand.tsx', 'executePromptCommand', 1],
  ['command', 'src/services/processUserInput/processSlashCommand.tsx', 'processSlashCommand', 1],
  ['command', 'src/services/processUserInput/processSlashCommand.tsx', 'runLocalCommand', 1],
  ['command', 'src/services/processUserInput/processSlashCommand.tsx', 'runLocalJsxCommand', 1],
  ['command', 'src/screens/chat/submit/screenCommand.ts', 'runLocalCommand', 1],
  ['command', 'src/screens/chat/useChatSubmit.ts', 'useChatSubmit', 1],
  ['screen', 'src/components/bootSplash/rowActions.ts', 'runRowOf', 2],
  ['screen', 'src/context/surfaceRoute.ts', 'commitTransition', 1],
  ['screen', 'src/dialogLaunchers.tsx', 'launchResumeChooser', 1],
  ['screen', 'src/components/Settings/config/useConfigExits.ts', 'useConfigExits', 1],
  ['screen', 'src/hooks/useHistorySearch.ts', 'useHistorySearch', 1],
  ['screen', 'src/components/permissions/hooks.ts', 'usePermissionRequestLogging', 1],
  ['tool', 'src/tools/McpAuthTool/McpAuthTool.ts', 'createMcpAuthTool', 1],
  ['tool', 'src/services/tools/toolExecution.ts', 'runAdmittedCall', 1],
  ['verb', 'src/main.tsx', 'run', 1],
  ['verb', 'src/entrypoints/cli.tsx', 'main', 5],
]
function checkSites(): void {
  const want = new Map(sites.map(([k, file, f, count]) => [`${k} ${file} ${f}`, count]))
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(f => /\.[cm]?[jt]sx?$/.test(f))
  for (const file of new Set(files)) {
    const path = join(ROOT, file)
    const text = readFileSync(path, 'utf8')
    const pre = ts.preProcessFile(text, true, true)
    if (file === DOOR) {
      const imports = pre.importedFiles.map(i => i.fileName).filter(spec => !spec.startsWith('node:'))
      const registry = flagRegistryFiles(ROOT).find(p => dirname(p) === dirname(DOOR))
      if (imports.length !== 1 || !registry || slash(relative(ROOT, moduleSource(syntax(file), imports[0]!).fileName)) !== registry) throw Error(`${DOOR}: the trace door may import only the flag door and Node builtins`)
    }
    if (file !== DOOR && !pre.importedFiles.some(i => i.fileName.includes('featureReached'))) continue
    const sf = syntax(file)
    const imports = sf.statements.filter(ts.isImportDeclaration).filter(d => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text.includes('featureReached'))
    const names = new Set(imports.flatMap(i => i.importClause?.namedBindings && ts.isNamedImports(i.importClause.namedBindings) ? i.importClause.namedBindings.elements.map(b => b.name.text) : []))
    if (file !== DOOR && (imports.length !== 1 || names.size !== 1)) throw Error(`${file}: import the handoff directly from ${DOOR}; do not re-export or wrap it`)
    for (const ref of nodes(sf, ts.isIdentifier)) if (names.has(ref.text) && !ts.isImportSpecifier(ref.parent) && !(ts.isCallExpression(ref.parent) && ref.parent.expression === ref)) fail(ref, 'call the handoff directly at the dispatch')
    for (const call of nodes(sf, ts.isCallExpression)) {
      if (!names.has(calleeName(call) ?? '') && calleeName(call) !== 'featureReached') continue
      let fn: ts.Node | undefined = call.parent
      while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent
      const key = `${call.arguments[0] && ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : '?'} ${file} ${fn?.name?.text ?? '<module>'}`
      const left = want.get(key) ?? 0
      if (!left) fail(call, `unexpected feature handoff (${key}); use the existing dispatch or declare the new site`)
      want.set(key, left - 1)
    }
  }
  for (const [key, n] of want) if (n) throw Error(`missing ${n} feature handoff(s) at ${key}; trace the accepted action`)
}
function members(): Set<string> {
  const out = new Set<string>()
  for (const suite of readdirSync(join(ROOT, 'scripts'))) {
    const dir = join(ROOT, 'scripts', suite)
    if (!existsSync(join(dir, 'members.txt'))) continue
    const template = /'scripts\/([\w-]+)\/\$name'/.exec(readFileSync(join(dir, 'run-all.sh'), 'utf8'))?.[1] ?? suite
    for (const line of readFileSync(join(dir, 'members.txt'), 'utf8').split(/\r?\n/)) {
      const name = line.trim().split(/\s+/)[0]
      if (name && !name.startsWith('#')) out.add(name.startsWith('scripts/') ? name : `scripts/${template}/${name}`)
    }
  }
  return out
}
type Row = { proof: string; how: string }
const none = { proof: 'none', how: 'none' }
function parse(text: string, ref: string): Map<string, Row> {
  const rows = new Map<string, Row>()
  const [header, ...lines] = text.trimEnd().split(/\r?\n/)
  if (header !== HEADER) throw Error(`${ref}: expected ${HEADER}`)
  for (const [i, line] of lines.entries()) {
    const [kind, name, proof, how, ...rest] = line.split('\t')
    const key = `${kind}\t${name}`
    if (rest.length || !name || !proof || !how || rows.has(key) || !kinds.some(k => k === kind) || !['source', 'bundle', 'terminal', 'none'].includes(how) || (proof === 'none') !== (how === 'none')) throw Error(`${ref}:${i + 2}: invalid or duplicate feature row ${line}`)
    rows.set(key, { proof, how })
  }
  return rows
}
function compare(a: Row, b: Row): number {
  return Number(a.how === 'source') - Number(b.how === 'source') || order(a.proof, b.proof) || order(a.how, b.how)
}
function inputs(args: string[], full: boolean, enrolled: Set<string>, keys: Set<string>) {
  const seen = new Map<string, Row[]>()
  const completed = new Set<string>()
  const read = (path: string, isDir: boolean): void => {
    const raw = readFileSync(path, 'utf8')
    for (const [i, line] of raw.split(/\r?\n/).entries()) {
      if (!line) continue
      const [kind, name, how, proof, ...rest] = line.split('\t')
      if (kind === 'complete' && name && how === undefined) { if (isDir && enrolled.has(name)) completed.add(name); continue }
      if (!kinds.some(k => k === kind) || !name || !how || !proof || rest.length || !['bundle', 'terminal', 'source'].includes(how)) throw Error(`${path}:${i + 1}: incomplete trace row; finish the proof before folding its trace`)
      const normalized = slash(isAbsolute(proof) ? relative(ROOT, proof) : proof)
      const key = `${kind}\t${name}`
      if (!keys.has(key) || !enrolled.has(normalized)) continue
      const rows = seen.get(key) ?? []
      if (!rows.some(r => r.proof === normalized && r.how === how)) rows.push({ proof: normalized, how })
      seen.set(key, rows)
    }
  }
  for (const p of args) {
    if (statSync(p).isDirectory()) {
      for (const file of readdirSync(p, { withFileTypes: true })) if (file.isFile() && file.name.endsWith('.tsv')) read(join(p, file.name), true)
    } else if (full) throw Error('--full needs a trace directory containing completed proof receipts')
    else read(p, false)
  }
  return { seen, completed }
}
function run(): void {
  const flags = process.argv.slice(2)
  const write = flags.includes('--write'), full = flags.includes('--full')
  const args = flags.filter(a => !['--write', '--full', '--report'].includes(a))
  if (full && !write || write !== (args.length > 0)) throw Error('usage: prove-feature-map.ts [--report] [--write [--full] <trace file or directory>…]')
  const keys = catalogue(), enrolled = members(), path = join(ROOT, TABLE)
  checkSites()
  const old = existsSync(path) ? parse(readFileSync(path, 'utf8'), TABLE) : new Map<string, Row>()
  const { seen, completed } = inputs(args, full, enrolled, keys)
  const rows = new Map(old)
  for (const key of [...keys].sort(order)) {
    const current = old.get(key)
    if (write) {
      const evidence = seen.get(key) ?? []
      const missed = current && completed.has(current.proof) && !evidence.some(r => r.proof === current.proof)
      const next = current && current.proof !== 'none' && !(full && missed) ? [current, ...evidence.filter(r => r.proof === current.proof)].sort(compare)[0]! : evidence.sort(compare)[0] ?? none
      rows.set(key, next)
    }
    const row = rows.get(key)
    if (!row) throw Error(`${TABLE}: missing ${key}; run its proof with the trace on, then --write <trace directory>`)
    if (row.proof !== 'none') {
      if (!statSync(join(ROOT, row.proof), { throwIfNoEntry: false })?.isFile()) throw Error(`${TABLE}: ${key} names a missing proof ${row.proof}; run the replacement proof and fold its trace`)
      if (!enrolled.has(row.proof)) throw Error(`${TABLE}: ${key} names ${row.proof} but no suite runs it; add its member row`)
    }
  }
  for (const key of old.keys()) if (!keys.has(key)) {
    if (!write) throw Error(`${TABLE}: stale feature ${key}; fold a trace with --write`)
    rows.delete(key)
  }
  checkFloor(rows, old)
  if (write) {
    for (const key of [...new Set([...rows.keys(), ...old.keys()])].sort(order)) {
      const a = old.get(key), b = rows.get(key)
      if (a?.proof !== b?.proof || a?.how !== b?.how) console.log(`${key}\t${a?.proof ?? '-'}:${a?.how ?? '-'} -> ${b?.proof ?? '-'}:${b?.how ?? '-'}`)
    }
    writeFileSync(path, [HEADER, ...[...rows].sort(([a], [b]) => order(a, b)).map(([key, row]) => `${key}\t${row.proof}\t${row.how}`), ''].join('\n'))
  }
  if (flags.includes('--report')) for (const k of kinds) {
    const byKind = [...rows].filter(([key]) => key.startsWith(`${k}\t`)).map(([, r]) => r.how)
    console.log(`${k}: ${byKind.length} features, ${byKind.filter(h => h === 'terminal' || h === 'bundle').length} built, ${byKind.filter(h => h === 'source').length} source only, ${byKind.filter(h => h === 'none').length} none`)
  }
  console.log(`${rows.size} feature rows; every named proof is enrolled`)
}
function checkFloor(rows: Map<string, Row>, disk: Map<string, Row>): void {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  const at = (ref: string): Map<string, Row> => parse(git('show', `${ref}:${TABLE}`), ref)
  const check = (floor: Map<string, Row>, next: Map<string, Row>, ref: string): void => {
    for (const [key, row] of next) if (row.proof === 'none' && floor.get(key)?.proof !== 'none') throw Error(`${TABLE}: new none row ${key} at ${ref}; run its proof with the trace on and fold it with --write`)
  }
  const writes = git('rev-list', '--first-parent', '--reverse', 'HEAD', '--', TABLE).trim().split('\n').filter(Boolean)
  let floor = writes.length ? at(writes[0]!) : disk
  for (const ref of writes.slice(1)) {
    const next = at(ref)
    check(floor, next, ref)
    floor = next
  }
  check(floor, rows, 'working tree')
  const unproved = [...rows.values()].filter(row => row.proof === 'none').length
  if (unproved > NONE_FLOOR) throw Error(`${TABLE}: ${unproved} none rows exceeds floor ${NONE_FLOOR}; run each proof with the trace on and fold it with --write`)
}
try { run() } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 }
