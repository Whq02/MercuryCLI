#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const FIXTURE = join(import.meta.dir, 'parser-corpus-parity.json')
const RECORD = process.argv.includes('--record')

type Entry = {
  from: string
  command: string
  tree: string
  walk: unknown
  semantics: unknown
  abort: unknown
  string: unknown
  raw: unknown
}
type Fixture = {
  grammar: string
  nodeTypeIds: Record<string, number>
  emptySemantics: unknown
  entries: Entry[]
}
type TreeNode = { type: string; text: string; startIndex: number; endIndex: number; children: TreeNode[] }
type GrammarNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: (GrammarNode | null)[]
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)
const hash16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

console.log('============================================================')
console.log(' Bash parser — corpus parity (the tree and the verdict)')
console.log('============================================================')

const ast = await import('../../src/utils/bash/ast.ts')
const parser = await import('../../src/utils/bash/parser.ts')

const grammarDir = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const grammarWasm = join(grammarDir, 'tree-sitter-bash.wasm')
const grammarModule = (await import(join(grammarDir, 'tree-sitter.js'))) as {
  Parser: {
    init(options: { locateFile: (file: string) => string }): Promise<void>
    new (): { setLanguage(language: unknown): void; parse(text: string): { rootNode: GrammarNode } | null }
  }
  Language: { load(path: string): Promise<unknown> }
}
await grammarModule.Parser.init({ locateFile: (file: string) => join(grammarDir, file) })
const bash = new grammarModule.Parser()
bash.setLanguage(await grammarModule.Language.load(grammarWasm))
const grammarId = hash16(readFileSync(grammarWasm).toString('base64'))

function toTree(node: GrammarNode): TreeNode {
  const children: TreeNode[] = []
  for (const child of node.children) if (child) children.push(toTree(child))
  return { type: node.type, text: node.text, startIndex: node.startIndex, endIndex: node.endIndex, children }
}

function treeOf(command: string): TreeNode | null {
  const parsed = bash.parse(command)
  return parsed ? toTree(parsed.rootNode) : null
}

async function settle(from: string, command: string): Promise<Entry> {
  const tree = treeOf(command)
  const walk = tree ? ast.parseForSecurityFromAst(command, tree) : { kind: 'no-tree' }
  const semantics = walk.kind === 'simple' ? ast.checkSemantics(walk.commands) : null
  return {
    from,
    command,
    tree: tree ? hash16(JSON.stringify(tree)) : 'none',
    walk,
    semantics,
    abort: ast.parseForSecurityFromAst(command, parser.PARSE_ABORTED),
    string: await ast.parseForSecurity(command),
    raw: await parser.parseCommandRaw(command),
  }
}

function nodeTypeTable(entries: Entry[]): Record<string, number> {
  const names = new Set<string>(['', 'ERROR', 'PARSE_ABORT', 'command', 'program'])
  for (const entry of entries) {
    const verdict = entry.walk as { nodeType?: string }
    if (typeof verdict.nodeType === 'string') names.add(verdict.nodeType)
  }
  const table: Record<string, number> = { undefined: ast.nodeTypeId(undefined) }
  for (const name of [...names].sort()) table[name] = ast.nodeTypeId(name)
  return table
}

if (!existsSync(FIXTURE)) {
  check('the corpus fixture exists beside the proof (record it once from the base with --record)', false, FIXTURE)
} else {
  const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
  const current: Entry[] = []
  for (const entry of recorded.entries) current.push(await settle(entry.from, entry.command))
  const fixture: Fixture = {
    grammar: grammarId,
    nodeTypeIds: nodeTypeTable(current),
    emptySemantics: ast.checkSemantics([]),
    entries: current,
  }

  if (RECORD) {
    const lines = fixture.entries.map(entry => '  ' + JSON.stringify(entry))
    const head = JSON.stringify({ grammar: fixture.grammar, nodeTypeIds: fixture.nodeTypeIds, emptySemantics: fixture.emptySemantics }).slice(1, -1)
    writeFileSync(FIXTURE, `{${head},\n "entries": [\n${lines.join(',\n')}\n ]\n}\n`)
    console.log(`\n  [RECORDED] ${fixture.entries.length} commands → ${FIXTURE}`)
  } else {
    section(`(1) the grammar and the id table (${Object.keys(recorded.nodeTypeIds).length} node kinds)`)
    check('the grammar that builds the trees is the recorded one', recorded.grammar === grammarId, `${recorded.grammar} vs ${grammarId}`)
    check('nodeTypeId gives the recorded id for every recorded kind', same(recorded.nodeTypeIds, fixture.nodeTypeIds), JSON.stringify(fixture.nodeTypeIds))
    check('checkSemantics over no commands is the recorded verdict', same(recorded.emptySemantics, fixture.emptySemantics), JSON.stringify(fixture.emptySemantics))

    section(`(2) the corpus — ${recorded.entries.length} commands, every tree and verdict byte-identical`)
    const fields: (keyof Entry)[] = ['tree', 'walk', 'semantics', 'abort', 'string', 'raw']
    const moved: string[] = []
    const perSource = new Map<string, number>()
    const kinds = new Map<string, number>()
    for (let i = 0; i < recorded.entries.length; i++) {
      const want = recorded.entries[i] as Entry
      const got = current[i] as Entry
      perSource.set(want.from, (perSource.get(want.from) ?? 0) + 1)
      const kind = (want.walk as { kind: string }).kind
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      for (const field of fields) {
        if (!same(want[field], got[field])) {
          moved.push(`${JSON.stringify(want.command.slice(0, 60))} ${field}: got ${JSON.stringify(got[field])} want ${JSON.stringify(want[field])}`)
        }
      }
    }
    for (const [from, count] of [...perSource.entries()].sort()) console.log(`    ${from}: ${count}`)
    for (const [kind, count] of [...kinds.entries()].sort()) console.log(`    walk verdict ${kind}: ${count}`)
    check(`every command's tree hash, walk verdict, semantic verdict, abort verdict, string-road verdict and raw parse are the recorded bytes (${recorded.entries.length} commands)`, moved.length === 0, `${moved.length} moved; first: ${moved[0] ?? ''}`)
    for (const line of moved.slice(0, 12)) console.log(`      ${line}`)
    check('the corpus reaches every walk verdict kind', kinds.has('simple') && kinds.has('too-complex'), [...kinds.keys()].join(','))
    check('the corpus holds at least one command refused by each pre-check and the abort road', recorded.entries.some(e => (e.abort as { nodeType?: string }).nodeType === 'PARSE_ABORT') && recorded.entries.filter(e => (e.abort as { nodeType?: string }).nodeType === undefined).length >= 6)
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(RECORD ? ' ✅ CORPUS RECORDED' : ` ✅ PARSER CORPUS PARITY GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} PARSER CORPUS PARITY FAILURE(S)`)
process.exit(1)
