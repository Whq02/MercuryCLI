#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { GRAPH_ROOT } from './graph.ts'
import { runCensus, treeOptions } from './exportCensus.ts'

const REPORT = process.argv.includes('--report')
const UNUSED_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205])
const SCHEMA = 'src/platform/config/schema.ts'

const ALLOW: Array<{ key: string; reason: string }> = [
  { key: 'src/commands/mission/mission-jsx.tsx:call(context)', reason: 'Command call signature requires (onDone, context, args); mission-jsx reads only onDone and args.' },
  { key: 'src/commands/mission/mission.ts:call(context)', reason: 'Command call signature requires (args, context); the mission command reads only args.' },
  { key: 'src/daemon/control/reconcileRecords.ts:reconcileDaemonRecords(opts)', reason: 'Optional opts parameter on exported reconcileDaemonRecords kept for callers passing projectDir.' },
  { key: 'src/daemon/process-sweep/processSweepRun.ts:readPlane(waitMs)', reason: 'Timeout parameter waitMs kept on readPlane signature from the process-sweep reader.' },
  { key: 'src/daemon/saturn/saturnAccount.ts:liveFactsForSessionFire(sessionId)', reason: 'Exported liveFactsForSessionFire keeps sessionId in its three-argument call contract.' },
  { key: 'src/daemon/switchboard/bootBirthFacts.ts:birthFallbackModel(resolved)', reason: 'Exported birthFallbackModel keeps resolved as its first parameter for boot callers.' },
  { key: 'src/engine/loop/turn/noToolReply.ts:pauseTurnContinuation(reply)', reason: 'Turn rule function handed as a value in the noToolReply rule table must match its shared signature.' },
  { key: 'src/engine/loop/turn/noToolReply.ts:toolCallRefusalRecovery(reply)', reason: 'Turn rule function handed as a value in the noToolReply rule table must match its shared signature.' },
  { key: 'src/engine/loop/turn/noToolReply.ts:turnBudgetSpent(reply)', reason: 'Turn rule function handed as a value in the noToolReply rule table must match its shared signature.' },
  { key: 'src/engine/loop/turn/noToolReply.ts:stopHooks(reply)', reason: 'Turn rule function handed as a value in the noToolReply rule table must match its shared signature.' },
  { key: 'src/engine/loop/turn/noToolReply.ts:checkpointSettleGuard(reply)', reason: 'Turn rule function handed as a value in the noToolReply rule table must match its shared signature.' },
  { key: 'src/engine/loop/turn/noToolReply.ts:queuedMessage(reply)', reason: 'Turn rule function handed as a value in the noToolReply rule table must match its shared signature.' },
  { key: 'src/engine/system-prompt/systemPromptSections.ts:DANGEROUS_uncachedSystemPromptSection(reason)', reason: 'Callers must pass an explicit reason explaining why a system prompt section stays uncached.' },
  { key: 'src/integrations/resources/adapters/service.ts:resolve(ctx)', reason: 'Resource adapter resolve method matches the shared adapter interface signature (uri, ctx).' },
  { key: 'src/models/sign-in/flow-cards/enterKeys.tsx:SuccessEnterConfirms(input)', reason: 'useInput callback receives (input, key) in a sign-in flow card that reads only key.' },
  { key: 'src/models/sign-in/flow-cards/enterKeys.tsx:ErrorEnterRetries(input)', reason: 'useInput callback receives (input, key) in a sign-in flow card that reads only key.' },
  { key: 'src/platform/substrate/fileStore.ts:stopWatching(path)', reason: 'Watcher teardown helper handed as a callback value expecting (path) in fileStore.' },
  { key: 'src/screen/diff/diffSources.ts:enumerateExtraSources(sessionId)', reason: 'Exported enumerateExtraSources keeps sessionId in its signature for diff workspace callers.' },
  { key: 'src/tools/eval/prompt.ts:buildEvalPrompt(tools)', reason: 'Helper matches the tool prompt(options) contract that passes tools alongside other options.' },
]
const allowed = new Map(ALLOW.map(a => [a.key, a.reason]))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${cond ? '' : ` — ${deadExportsFixHint(label)}`}`)
}
function deadExportsFixHint(label: string): string {
  if (label.startsWith('zero unread declarations')) return 'fix: delete each listed unused import, local, function, type or parameter from its file under src/ (--report lists them all)'
  if (label.startsWith('zero exports nothing imports')) return 'fix: delete each listed unimported export from its file, or import it where it is used (the census is runCensus in scripts/orphans/exportCensus.ts)'
  if (label.startsWith('zero schema keys')) return 'fix: delete each listed key from src/platform/config/schema.ts, or read it by name somewhere under src/'
  return 'fix: the checker under test is collectUnusedDeclarations, schemaKeys and unreadKeys in scripts/orphans/prove-dead-exports.ts; the allow list ALLOW in the same file takes an entry only with a reason of 40 or more characters and leaves when the name is read'
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

type Dead = { key: string; what: string }
type CensusResult = { found: Dead[]; dead: Dead[] }

function enclosingOwnerOfParameter(sf: ts.SourceFile, pos: number): string | null {
  let inParameter = false
  let owner: string | null = null
  const visit = (node: ts.Node): void => {
    if (pos < node.getStart(sf) || pos > node.getEnd()) return
    if (ts.isParameter(node)) inParameter = true
    if (!inParameter) {
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) owner = node.name.text
      else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name))) owner = node.name.text
      else if (ts.isConstructorDeclaration(node)) owner = 'constructor'
      else if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)) owner = node.name.text
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return inParameter ? owner : null
}

function collectUnusedDeclarations(program: ts.Program, root: string): Dead[] {
  const out: Dead[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root + '/')) continue
    const rel = relative(root, sf.fileName)
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (!UNUSED_CODES.has(d.code) || d.start === undefined) continue
      const { line } = sf.getLineAndCharacterOfPosition(d.start)
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      const name = text.match(/^'([^']+)'/)?.[1] ?? (d.code === 6192 ? '<every import of the declaration>' : text)
      const owner = enclosingOwnerOfParameter(sf, d.start)
      const key = owner ? `${rel}:${owner}(${name})` : `${rel}:${name}`
      out.push({ key, what: `${rel}:${line + 1} ${owner ? `${owner}(${name})` : name} (TS${d.code})` })
    }
  }
  return out
}

function unusedDeclarations(fileNames: string[], options: ts.CompilerOptions, root: string): Dead[] {
  const program = ts.createProgram(fileNames, { ...options, noUnusedLocals: true, noUnusedParameters: true, noEmit: true })
  return collectUnusedDeclarations(program, root)
}

function treeProgramInputs(): { fileNames: string[]; options: ts.CompilerOptions } {
  const cfg = ts.readConfigFile(join(GRAPH_ROOT, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, GRAPH_ROOT)
  return { fileNames: parsed.fileNames, options: parsed.options }
}

function schemaKeysFromSourceFile(sf: ts.SourceFile): string[] {
  const keys = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) keys.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...keys].sort()
}

function schemaKeys(text: string): string[] {
  return schemaKeysFromSourceFile(ts.createSourceFile(SCHEMA, text, ts.ScriptTarget.Latest, true))
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) yield p
  }
}

function unreadKeys(keys: string[], readers: Array<{ file: string; text: string }>): string[] {
  return keys.filter(key => {
    const word = new RegExp(`(^|[^A-Za-z0-9_$])${key}([^A-Za-z0-9_$]|$)`)
    return !readers.some(r => word.test(r.text))
  })
}

function selfTest(): void {
  section('§0 self-test on a synthetic project: the checker names an unused import, local, function, type and parameter, and never an export')
  const root = mkdtempSync(join(tmpdir(), 'dead-exports-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'b.ts'), ['export const read = 1', 'export const unreadExport = 2', 'export function helper(): number {', '  return read', '}', ''].join('\n'))
    writeFileSync(
      join(root, 'src', 'a.ts'),
      [
        "import { read, unreadImport } from './b.js'",
        'function usedFn(): number {',
        '  const kept = read',
        '  const unusedLocal = 2',
        '  return kept',
        '}',
        'function unusedFn(): void {}',
        'function withUnusedParam(used: number, unusedParam: string): number {',
        '  return used',
        '}',
        'function otherWithUnused(unusedParam: number): number {',
        '  return 1',
        '}',
        'type UnusedType = string',
        "export const out = usedFn() + withUnusedParam(1, 'x') + otherWithUnused(2)",
        '',
      ].join('\n'),
    )
    const files = [join(root, 'src', 'a.ts'), join(root, 'src', 'b.ts')]
    const found = unusedDeclarations(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, types: [] }, root)
    const keys = found.map(f => f.key).sort()
    check('the unused import specifier is named', keys.includes('src/a.ts:unreadImport'), keys.join(', '))
    check('the unused local is named', keys.includes('src/a.ts:unusedLocal'))
    check('the unused function is named', keys.includes('src/a.ts:unusedFn'))
    check('the unused type alias is named', keys.includes('src/a.ts:UnusedType'))
    check('the unused parameter is named with its owner', keys.includes('src/a.ts:withUnusedParam(unusedParam)'), keys.join(', '))
    check('two functions with the same unused parameter name get distinct keys', keys.includes('src/a.ts:otherWithUnused(unusedParam)'), keys.join(', '))
    check('a used declaration, a used parameter, a used import and an exported name are never named', !keys.some(k => /:usedFn$|:read$|:kept$|:unreadExport$|:helper$|:out$|\(used\)$/.test(k)), keys.join(', '))
    check('exactly those six', keys.length === 6, keys.join(', '))
    const schemaText = ['type A = {', '  readKey: number', '  unreadKey?: string', "  'quoted-key'?: boolean", '}', 'export type Config = A', ''].join('\n')
    const keysOut = schemaKeys(schemaText)
    check('every property signature of the schema is a key, quoted or bare', keysOut.join(',') === 'quoted-key,readKey,unreadKey', keysOut.join(','))
    const unread = unreadKeys(keysOut, [{ file: 'x.ts', text: 'const v = cfg.readKey + cfg["quoted-key"]' }])
    check('a key read by name is read, a key read nowhere is not, and a prefix match is no read', unread.join(',') === 'unreadKey', unread.join(','))
    check('readKeyed does not count as a read of readKey', unreadKeys(['readKey'], [{ file: 'x.ts', text: 'cfg.readKeyed' }]).join(',') === 'readKey')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function declarationCensus(): CensusResult & { schemaFile: ts.SourceFile } {
  section('§1 every declaration under src/ that nothing reads: an import, a local, a function, a type, a parameter (the checker with noUnusedLocals + noUnusedParameters)')
  const { fileNames, options } = treeProgramInputs()
  const program = ts.createProgram(fileNames, { ...options, noUnusedLocals: true, noUnusedParameters: true, noEmit: true })
  const found = collectUnusedDeclarations(program, GRAPH_ROOT)
  const schemaFile = program.getSourceFile(join(GRAPH_ROOT, SCHEMA))
  if (!schemaFile) throw new Error(`${SCHEMA} missing from the TypeScript program`)
  const dead = found.filter(f => !allowed.has(f.key))
  console.log(`  program ${fileNames.length} files · unread declarations ${found.length} · allowed ${found.length - dead.length}`)
  check(`zero unread declarations (found ${dead.length})`, dead.length === 0, `\n    ${dead.slice(0, 60).map(d => d.what).join('\n    ')}${dead.length > 60 ? `\n    … ${dead.length - 60} more (--report lists them)` : ''}`)
  if (REPORT && dead.length) for (const d of dead) console.log(`    ${d.what}`)
  return { found, dead, schemaFile }
}

function exportCensus(): CensusResult {
  section('§2 every export under src/ and scripts/ that nothing imports, loads, names or scans (the export census classes)')
  const census = runCensus(treeOptions())
  const found = census.rows.filter(r => r.class === 'candidate').map(r => ({ key: `${r.file}:${r.name}`, what: `${r.file} ${r.name}${r.typeOnly ? ' (type)' : ''}` }))
  const dead = found.filter(f => !allowed.has(f.key))
  console.log(`  exports ${census.rows.length} · read ${census.tally.read} · unread in a named class ${census.rows.length - census.tally.read - census.tally.candidate}`)
  check(`zero exports nothing imports (found ${dead.length})`, dead.length === 0, `\n    ${dead.map(d => d.what).join('\n    ')}`)
  return { found, dead }
}

function settingsCensus(schemaFile: ts.SourceFile): CensusResult {
  section(`§3 every key the settings schema carries (${SCHEMA}) is read by name somewhere under src/`)
  const keys = schemaKeysFromSourceFile(schemaFile)
  const readers: Array<{ file: string; text: string }> = []
  for (const p of walk(join(GRAPH_ROOT, 'src'))) {
    const rel = relative(GRAPH_ROOT, p)
    if (rel === SCHEMA) continue
    readers.push({ file: rel, text: readFileSync(p, 'utf8') })
  }
  const found = unreadKeys(keys, readers).map(k => ({ key: `${SCHEMA}:${k}`, what: k }))
  const dead = found.filter(f => !allowed.has(f.key))
  console.log(`  keys ${keys.length} · readers ${readers.length} files`)
  check(`zero schema keys no code reads (found ${dead.length})`, dead.length === 0, dead.map(d => d.what).join(', '))
  return { found, dead }
}

function allowListIsHonest(results: CensusResult[]): void {
  section('§4 the allow list: every entry carries a reason and names something the censuses still find unread')
  if (ALLOW.length === 0) {
    console.log('  the allow list is empty: every declaration, export and settings key in the tree is read')
    return
  }
  const found = new Set(results.flatMap(r => r.found.map(f => f.key)))
  for (const a of ALLOW) {
    check(`${a.key} — a reason of at least 40 characters`, a.reason.length >= 40, `${a.reason.length} chars`)
    check(`${a.key} — still unread (a cured entry leaves the list)`, found.has(a.key))
  }
}

console.log('============================================================')
console.log(' the dead-code census: no declaration, export or settings key that nothing reads')
console.log('============================================================')
selfTest()
const r1 = declarationCensus()
const r2 = exportCensus()
const r3 = settingsCensus(r1.schemaFile)
allowListIsHonest([r1, r2, r3])
const total = r1.dead.length + r2.dead.length + r3.dead.length
console.log(failures === 0 ? `\n✅ DEAD-CODE CENSUS GREEN — ${checks} checks, nothing unread` : `\n❌ DEAD-CODE CENSUS RED — ${total} unread (${r1.dead.length} declarations · ${r2.dead.length} exports · ${r3.dead.length} settings keys); ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
