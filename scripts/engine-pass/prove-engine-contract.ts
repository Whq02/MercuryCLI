import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { BASE, ROOT, argument, baseSources, git, hasBaseObject, scratch } from './support.ts'

function contract(root: string): Record<string, unknown> {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  const entries = ['src/screen/themedRenderer.ts', 'src/screen/renderer/screenInstance.tsx', 'src/screen/renderer/elements/ScrollBox.tsx']
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
    assert.ok(module, `no module symbol resolved for ${entry} in scripts/engine-pass/prove-engine-contract.ts`)
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

type MovementRecord = { note: string; digest: string | null }

const shapeDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function checkShapeExports(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  moved: ReadonlyMap<string, MovementRecord>,
  quiet = false,
): number {
  let named = 0
  const unrecorded: string[] = []
  const drifted: string[] = []
  for (const [name, expected] of Object.entries(before)) {
    assert.ok(Object.hasOwn(after, name), `export disappeared: ${name}`)
    try {
      assert.deepEqual(after[name], expected)
    } catch (error) {
      const record = moved.get(`shape:${name}`)
      const actualDigest = shapeDigest(after[name])
      if (!record) {
        if (!quiet) console.log(`[MOVED] ${name} — ${String(error)}`)
        unrecorded.push(`shape\t${name}\t<what moved, and what reads the same>\t<lane>\t<commit>\t${actualDigest}`)
        continue
      }
      if (actualDigest !== record.digest) {
        drifted.push(`${name}\t${actualDigest}\t(recorded ${record.digest}: ${record.note})`)
        continue
      }
      named++
      if (!quiet) console.log(`[NAMED] ${name} (${actualDigest.slice(0, 12)}) — ${record.note}`)
    }
  }
  assert.equal(
    drifted.length,
    0,
    `export shape drifted past its recorded movement: ${drifted.length} row(s) of scripts/engine-pass/contract-moved.tsv no longer hold. Give each its new digest once its reason covers the move (the name, the digest it reads now, what is recorded):\n${drifted.join('\n')}`,
  )
  assert.equal(
    unrecorded.length,
    0,
    `export shape changed: ${unrecorded.length} export(s) moved with no row in scripts/engine-pass/contract-moved.tsv. Add each row below with its reason, lane and commit (tabs between the six columns):\n${unrecorded.join('\n')}`,
  )
  return named
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
  const moved = new Map<string, MovementRecord>()
  const records = readFileSync(join(import.meta.dir, 'contract-moved.tsv'), 'utf8').trimEnd().split('\n')
  assert.equal(records.shift(), 'kind\tname\treason\tlane\tcommit\tdigest')
  for (const line of records) {
    const [kind, name, reason, lane, commit, digest, extra] = line.split('\t')
    assert.ok(kind && name && reason && lane && commit && extra === undefined, `incomplete movement record: ${line}`)
    assert.ok(kind === 'shape' || kind === 'unexported', `unknown movement kind: ${line}`)
    if (kind === 'shape') {
      assert.ok(digest !== undefined && /^[0-9a-f]{64}$/.test(digest), `shape movement record requires a 64-hex sha256 digest: ${line}`)
    } else {
      assert.equal(digest, undefined, `unexported movement record carries no shape digest: ${line}`)
    }
    assert.ok(!moved.has(`${kind}:${name}`), `duplicate movement record: ${line}`)
    moved.set(`${kind}:${name}`, { note: `${reason} (${lane}, ${commit})`, digest: digest ?? null })
  }
  let named = checkShapeExports(before, after, moved)
  const driftedTarget = 'src/screen/renderer/elements/ScrollBox.tsx:ScrollBoxProps'
  const driftedAfter = { ...after, [driftedTarget]: { ...(after[driftedTarget] as Record<string, unknown>), drifted: true } }
  assert.throws(
    () => checkShapeExports(before, driftedAfter, moved, true),
    /export shape drifted past its recorded movement/,
  )
  const count = Object.keys(before).filter(name => name.startsWith('src/screen/themedRenderer.ts:')).length
  console.log(`[PASS] engine contract: ${count} facade exports and ${Object.keys(before).length - count} engine/scroll exports keep their names and resolved type shapes except the ${named} movements the record names`)
} finally {
  if (own) rmSync(work, { recursive: true, force: true })
}
