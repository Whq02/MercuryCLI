import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from '../builtin-tools/gitFixture.ts'

const world = gitFixture('ast-recovered-search-')
let client: Awaited<ReturnType<typeof gitClient>> | undefined
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
const cases = [
  { file: 'syntax.ts', code: 'const broken = ;\nconst result = needle(1);\n', pattern: 'needle($X)', language: 'typescript', expected: 'needle(1)' },
  { file: 'missing.ts', code: 'const result = needle(2);\nfunction broken() {\n', pattern: 'needle($X)', language: 'typescript', expected: 'needle(2)' },
  { file: 'enum.m', code: 'typedef NS_ENUM(NSInteger, Kind) {\n KindHigh, KindLow,\n};\nint run(void) { NSLog(@"hello"); return 0; }\n', pattern: 'NSLog($X)', language: 'objc', expected: 'NSLog(@"hello")' },
  { file: 'nonnull.m', code: 'NS_ASSUME_NONNULL_BEGIN\n@interface Harbour : NSObject\n@property (nonatomic, copy) NSString *name;\n@end\nNS_ASSUME_NONNULL_END\nint run(void) { NSLog(@"world"); return 0; }\n', pattern: 'NSLog($X)', language: 'objc', expected: 'NSLog(@"world")' },
  { file: 'missing.sql', code: 'BEGIN;\nSELECT name FROM items;\nCOMMIT\n', pattern: 'SELECT $X FROM items', language: 'sql', expected: 'SELECT name FROM items' },
]
try {
  for (const fixture of cases) world.put(fixture.file, fixture.code)
  world.put('many.ts', Array.from({ length: 9 }, (_, i) => `const broken${i} = ;`).join('\n') + '\nneedle(3);\n')
  world.put('clean.ts', 'const a = needle(1);\nconst b = needle(2);\n')
  client = await gitClient(world)
  const search = async (input: Record<string, unknown>): Promise<{ text: string; matchCount?: number; parseFailures?: number }> => {
    const raw = await client!.call('AstSearch', input)
    try { return JSON.parse(raw) } catch { return { text: raw } }
  }
  for (const fixture of cases) {
    const result = await search({ pattern: fixture.pattern, path: fixture.file })
    check(`${fixture.file}: the intact construct matches on the recovered tree`, result.matchCount === 1 && result.text.includes(fixture.expected), JSON.stringify(result))
    check(`${fixture.file}: warning names the file, language and source location`, result.text.includes(`Searched recovered tree: ${fixture.file} (${fixture.language}; `) && /\d+:\d+ (?:syntax error|missing)/.test(result.text) && result.text.includes('Matches may include parser recovery.') && !result.text.includes('Did not parse, never matched:'), result.text)
    check(`${fixture.file}: the parse-problem count stays honest and search writes nothing`, result.parseFailures === 1 && world.get(fixture.file) === fixture.code, JSON.stringify(result))
  }
  const missing = await search({ pattern: 'SELECT $X FROM items', path: 'missing.sql' })
  check('an inserted punctuation token is reported as missing', missing.text.includes('missing ;') && missing.text.includes('Searched recovered tree:'), missing.text)
  const many = await search({ pattern: 'needle($X)', path: 'many.ts' })
  check('display reports exact omitted diagnostics beyond the first three', many.matchCount === 1 && many.text.includes('+6 more diagnostics'), many.text)
  const page = await search({ pattern: 'needle($X)', path: 'clean.ts', limit: 1, offset: 1 })
  check('clean-file capture and pagination retain their normal words', page.text.includes('clean.ts:2:11') && page.text.includes('$X = 2') && !page.text.includes('recovered'), page.text)
  const count = await search({ pattern: 'needle($X)', path: 'syntax.ts', mode: 'count' })
  check('count mode includes recovered matches and the same warning', count.matchCount === 1 && count.text.includes('syntax.ts: 1') && count.text.includes('Searched recovered tree:'), count.text)
  mkdirSync(join(world.root, 'warnings'))
  for (let i = 0; i < 7; i++) world.put(`warnings/f${i}.ts`, `const broken = ;\nneedle(${i});\n`)
  const grouped = await search({ pattern: 'needle($X)', path: 'warnings' })
  check('the bounded warning names five recovered files and the exact omitted count', grouped.matchCount === 7 && grouped.text.split('Searched recovered tree:').length === 6 && grouped.text.includes('+2 more files searched over recovered trees.'), grouped.text)
  check('paging and counting leave every source file unchanged', cases.every(fixture => world.get(fixture.file) === fixture.code))
} finally { await client?.close(); world.dispose() }
console.log(`Recovered structural search: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
