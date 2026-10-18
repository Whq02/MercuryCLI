import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { BASE, ROOT, argument, baseSources, git, hasBaseObject, scratch } from './support.ts'

function contract(root: string): Record<string, unknown> {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  const entries = ['src/ink.ts', 'src/ink/ink.tsx', 'src/ink/components/ScrollBox.tsx']
  const program = ts.createProgram(entries.map(path => join(root, path)), options)
  const checker = program.getTypeChecker()
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseStructuralFallback | ts.TypeFormatFlags.InTypeAlias
  const printed = (type: ts.Type): string => checker.typeToString(type, undefined, flags).replaceAll(root, '<root>')
  const shape = (type: ts.Type): unknown => ({
    text: printed(type),
    calls: type.getCallSignatures().map(signature => checker.signatureToString(signature, undefined, flags)),
    constructs: type.getConstructSignatures().map(signature => checker.signatureToString(signature, undefined, flags)),
    members: type.getProperties().map(member => {
      const at = member.valueDeclaration ?? member.declarations?.[0] ?? program.getSourceFile(join(root, entries[0]!))!
      assert.ok(at, `no type context for ${member.name}`)
      return [member.name.replace(/(__@[^@]+)@\d+$/, '$1'), !!(member.flags & ts.SymbolFlags.Optional), printed(checker.getTypeOfSymbolAtLocation(member, at))]
    }).sort(([a], [b]) => String(a).localeCompare(String(b))),
  })
  const result: Record<string, unknown> = {}
  for (const entry of entries) {
    const source = program.getSourceFile(join(root, entry))
    assert.ok(source, `missing ${entry}`)
    const module = checker.getSymbolAtLocation(source)
    assert.ok(module)
    for (const item of checker.getExportsOfModule(module)) {
      const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item
      const at = target.valueDeclaration ?? target.declarations?.[0]
      assert.ok(at, `unresolved export ${entry}:${item.name}`)
      const value = target.flags & ts.SymbolFlags.Value ? checker.getTypeOfSymbolAtLocation(target, at) : null
      const type = target.flags & ts.SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(target) : null
      result[`${entry}:${item.name}`] = { value: value && shape(value), type: type && shape(type) }
    }
  }
  return result
}

function exportedNames(root: string, files: readonly string[]): Map<string, Set<string>> {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  const program = ts.createProgram(files.map(path => join(root, path)), options)
  const checker = program.getTypeChecker()
  return new Map(files.map(path => {
    const source = program.getSourceFile(join(root, path))
    const module = source ? checker.getSymbolAtLocation(source) : undefined
    return [path, new Set(module ? checker.getExportsOfModule(module).map(item => item.name) : [])]
  }))
}

const own = argument('--work-dir') === undefined
const work = argument('--work-dir') ?? scratch('engine-contract-')
try {
  const recordedPath = join(import.meta.dir, `contract-${BASE.slice(0, 9)}.json`)
  if (process.argv.includes('--record-base')) {
    assert.ok(hasBaseObject(), 'the base object is required to record its contract')
    assert.equal(git('diff', BASE, '--', 'src'), '', 'contract recording precedes product changes')
    writeFileSync(recordedPath, JSON.stringify({ base: BASE, exports: contract(baseSources(work)) }, null, 1) + '\n', { flag: 'wx' })
  }
  assert.ok(existsSync(recordedPath), 'the committed base contract record is missing')
  const recorded = JSON.parse(readFileSync(recordedPath, 'utf8'))
  assert.equal(recorded.base, BASE)
  const before = recorded.exports as Record<string, unknown>
  const after = contract(ROOT)
  const moved = new Map<string, string>()
  const records = readFileSync(join(import.meta.dir, 'contract-moved.tsv'), 'utf8').trimEnd().split('\n')
  assert.equal(records.shift(), 'kind\tname\treason\tlane\tcommit')
  for (const line of records) {
    const [kind, name, reason, lane, commit, extra] = line.split('\t')
    assert.ok(kind && name && reason && lane && commit && extra === undefined, `incomplete movement record: ${line}`)
    assert.ok(kind === 'shape' || kind === 'unexported', `unknown movement kind: ${line}`)
    assert.ok(!moved.has(`${kind}:${name}`), `duplicate movement record: ${line}`)
    moved.set(`${kind}:${name}`, `${reason} (${lane}, ${commit})`)
  }
  let named = 0
  for (const [name, expected] of Object.entries(before)) {
    assert.ok(Object.hasOwn(after, name), `export disappeared: ${name}`)
    try {
      assert.deepEqual(after[name], expected)
    } catch (error) {
      const record = moved.get(`shape:${name}`)
      assert.ok(record, `export shape changed: ${name} — ${String(error)}`)
      named++
      console.log(`[NAMED] ${name} — ${record}`)
    }
  }
  let kept = 0
  if (hasBaseObject()) {
    const removed: Array<{ path: string; line: string }> = []
    let path = ''
    for (const line of git('diff', '--unified=0', BASE, '--', 'src/ink', 'src/ink.ts').split('\n')) {
      if (line.startsWith('+++ b/')) path = line.slice('+++ b/'.length)
      else if (/^-export\b/.test(line)) removed.push({ path, line })
    }
    const stillExported = exportedNames(ROOT, [...new Set(removed.map(item => item.path))].filter(file => existsSync(join(ROOT, file))))
    for (const { path, line } of removed) {
      const declared = /^-export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const\s+enum|type|interface|const|let|function|class|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]
      assert.ok(declared, `an exported declaration was removed in a shape the record cannot name: ${line}`)
      const exportName = /^-export\s+default\b/.test(line) ? 'default' : declared
      if (stillExported.get(path)?.has(exportName)) {
        kept++
        continue
      }
      const record = moved.get(`unexported:${declared}`)
      assert.ok(record, `an exported declaration was removed or renamed: ${declared}`)
      named++
      console.log(`[NAMED] -export ${declared} — ${record}`)
    }
    if (kept > 0) console.log(`[KEPT] ${kept} export line(s) rewritten in place — the same name is still exported by the same file`)
  } else {
    console.log('[BASE RECORD] base git object absent; exported names and resolved shapes checked against the committed contract record, textual diff unavailable')
  }
  const count = Object.keys(before).filter(name => name.startsWith('src/ink.ts:')).length
  console.log(`[PASS] engine contract: ${count} facade exports and ${Object.keys(before).length - count} engine/scroll exports keep their names and resolved type shapes except the ${named} movements the record names${hasBaseObject() ? `; every -export line named or still exported (${kept} rewritten in place)` : '; committed base record used'}`)
} finally {
  if (own) rmSync(work, { recursive: true, force: true })
}
