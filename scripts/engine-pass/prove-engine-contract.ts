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
  for (const [name, expected] of Object.entries(before)) {
    assert.ok(Object.hasOwn(after, name), `export disappeared: ${name}`)
    assert.deepEqual(after[name], expected, `export shape changed: ${name}`)
  }
  if (hasBaseObject()) {
    const removed = git('diff', '--unified=0', BASE, '--', 'src/ink', 'src/ink.ts').split('\n').filter(line => /^-export\b/.test(line))
    assert.deepEqual(removed, [], 'an exported declaration was removed or renamed')
  } else {
    console.log('[BASE RECORD] base git object absent; exported names and resolved shapes checked against the committed contract record, textual diff unavailable')
  }
  const count = Object.keys(before).filter(name => name.startsWith('src/ink.ts:')).length
  console.log(`[PASS] engine contract: ${count} facade exports and ${Object.keys(before).length - count} engine/scroll exports keep their names and resolved type shapes${hasBaseObject() ? '; no -export line' : '; committed base record used'}`)
} finally {
  if (own) rmSync(work, { recursive: true, force: true })
}
