import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from '../builtin-tools/gitFixture.ts'

const world = gitFixture('ast-recovered-edit-')
let client: Awaited<ReturnType<typeof gitClient>> | undefined
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
const cases = [
  { file: 'plain.ts', source: 'const broken = ;\nconst result = needle(1);\n', pattern: 'needle($X)', rewrite: 'found($X)', expected: 'const broken = ;\nconst result = found(1);\n' },
  { file: 'shift.ts', source: 'needle(2);\nconst broken = ;\n', pattern: 'needle($X)', rewrite: '(\n found($X)\n)', expected: '(\n found(2)\n);\nconst broken = ;\n' },
  { file: 'windows.ts', source: 'const broken = ;\r\nconst result = needle(3);', pattern: 'needle($X)', rewrite: 'found($X)', expected: 'const broken = ;\r\nconst result = found(3);' },
  { file: 'unicode.ts', source: 'const café = "é";\nneedle(4);\nconst broken = ;\n', pattern: 'needle($X)', rewrite: '(\n found($X)\n)', expected: 'const café = "é";\n(\n found(4)\n);\nconst broken = ;\n' },
  { file: 'enum.m', source: 'typedef NS_ENUM(NSInteger, Kind) { KindHigh, KindLow, };\nint run(void) { NSLog(@"hello"); return 0; }\n', pattern: 'NSLog($X)', rewrite: 'auditLog($X)', expected: 'typedef NS_ENUM(NSInteger, Kind) { KindHigh, KindLow, };\nint run(void) { auditLog(@"hello"); return 0; }\n' },
  { file: 'missing.sql', source: 'BEGIN;\nSELECT name FROM items;\nCOMMIT\n', pattern: 'SELECT $X FROM items', rewrite: 'SELECT $X FROM records', expected: 'BEGIN;\nSELECT name FROM records;\nCOMMIT\n' },
]
try {
  writeFileSync(join(world.home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['AstSearch', 'AstEdit', 'Read'] } }))
  for (const fixture of cases) world.put(fixture.file, fixture.source)
  client = await gitClient(world)
  const call = async (name: string, input: Record<string, unknown>): Promise<{ text: string; state?: string; plan?: string; matchCount?: number }> => {
    const raw = await client!.call(name, input)
    try { const data = JSON.parse(raw); return typeof data.text === 'string' ? data : { text: raw } } catch { return { text: raw } }
  }
  for (const fixture of cases) {
    const args = { path: fixture.file, pattern: fixture.pattern, rewrite: fixture.rewrite }
    const preview = await call('AstEdit', args)
    check(`${fixture.file}: a clean node beside existing damage has one preview`, preview.state === 'dry-run' && preview.matchCount === 1 && preview.text.includes('Searched recovered tree:'), preview.text)
    check(`${fixture.file}: preview changes no source bytes`, world.get(fixture.file) === fixture.source)
    const applied = preview.plan ? await call('AstEdit', { ...args, apply: true, plan: preview.plan }) : preview
    check(`${fixture.file}: exact intended bytes land with existing error bytes retained`, applied.state === 'applied' && world.get(fixture.file) === fixture.expected, `${applied.text}\n${world.get(fixture.file)}`)
  }
  world.put('inside.ts', '@needle(1)\n')
  const insideSearch = await call('AstSearch', { path: 'inside.ts', pattern: 'needle($X)' })
  check('the dirty-ancestor fixture really exposes a recovered call', insideSearch.matchCount === 1 && insideSearch.text.includes('Searched recovered tree:'), insideSearch.text)
  const inside = await call('AstEdit', { path: 'inside.ts', pattern: 'needle($X)', rewrite: 'found($X)' })
  check('a clean-looking node inside an ERROR ancestor is refused before preview', inside.text.includes('the match touches a syntax-error region. Nothing was written.') && world.get('inside.ts') === '@needle(1)\n', inside.text)
  world.put('dirty.ts', 'function broken() { return needle(1; }\n')
  const dirtySearch = await call('AstSearch', { path: 'dirty.ts', pattern: 'function $NAME() { $$$BODY }' })
  check('the missing-token fixture really matches the entire recovered function', dirtySearch.matchCount === 1 && dirtySearch.text.includes('missing )'), dirtySearch.text)
  const dirty = await call('AstEdit', { path: 'dirty.ts', pattern: 'function $NAME() { $$$BODY }', rewrite: 'function $NAME() { return 1; }' })
  check('a matched subtree containing a missing token is refused', dirty.text.includes('the match touches a syntax-error region. Nothing was written.') && world.get('dirty.ts') === 'function broken() { return needle(1; }\n', dirty.text)
  const beforeDamage = 'needle(1);\nconst broken = ;\n'
  world.put('damage.ts', beforeDamage)
  world.put('candidate.ts', '/*;\nconst broken = ;\n')
  const beforeErrors = await call('AstSearch', { path: 'damage.ts', pattern: '$X' })
  const candidateErrors = await call('AstSearch', { path: 'candidate.ts', pattern: '$X' })
  const errorCount = (text: string) => (text.match(/\d+:\d+ (?:syntax error|missing)/g) ?? []).length
  check('the equal-count fixture really has one error before and after at different spans', errorCount(beforeErrors.text) === 1 && errorCount(candidateErrors.text) === 1, `${beforeErrors.text}\n${candidateErrors.text}`)
  const damage = await call('AstEdit', { path: 'damage.ts', pattern: 'needle($X)', rewrite: '/*' })
  check('equal error counts cannot hide a newly introduced error region', damage.text.includes('The rewrite introduces a syntax error in damage.ts at ') && world.get('damage.ts') === beforeDamage, damage.text)
  const many = Array.from({ length: 9 }, (_, i) => `const broken${i} = ;`).join('\n') + '\nneedle(3);\n'
  world.put('many.ts', many)
  const manyBad = await call('AstEdit', { path: 'many.ts', pattern: 'needle($X)', rewrite: 'found($X); const another = ' })
  check('a new error after nine existing errors is compared beyond the display cap', manyBad.text.includes('The rewrite introduces a syntax error in many.ts at ') && world.get('many.ts') === many, manyBad.text)
  const manyGood = await call('AstEdit', { path: 'many.ts', pattern: 'needle($X)', rewrite: 'found($X)' })
  check('many unchanged errors still permit a clean rewrite and bounded warning', manyGood.state === 'dry-run' && manyGood.text.includes('+6 more diagnostics'), manyGood.text)
  world.put('stale.ts', cases[0]!.source)
  const staleArgs = { path: 'stale.ts', pattern: 'needle($X)', rewrite: 'found($X)' }
  const stalePlan = await call('AstEdit', staleArgs)
  world.put('stale.ts', cases[0]!.source.replace('needle(1)', 'needle(9)'))
  const stale = stalePlan.plan ? await call('AstEdit', { ...staleArgs, apply: true, plan: stalePlan.plan }) : stalePlan
  check('equal-count source drift still invalidates the frozen plan with no write', stale.text.includes('does not match the current dry run') && world.get('stale.ts').includes('needle(9)'), stale.text)
  world.put('delete.ts', 'needle(1);\nconst broken = ;\n')
  const deletedPlan = await call('AstEdit', { path: 'delete.ts', pattern: 'needle($X)', rewrite: '' })
  const deleted = deletedPlan.plan ? await call('AstEdit', { path: 'delete.ts', pattern: 'needle($X)', rewrite: '', apply: true, plan: deletedPlan.plan }) : deletedPlan
  check('clean-node deletion preserves the pre-existing damaged declaration', deleted.state === 'applied' && !world.get('delete.ts').includes('needle') && world.get('delete.ts').includes('const broken = ;'), deleted.text)
} finally { await client?.close(); world.dispose() }
console.log(`Recovered structural edit: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
