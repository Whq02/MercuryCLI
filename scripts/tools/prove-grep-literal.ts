#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(realpathSync(tmpdir()), 'grep-literal-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getDescription } = await import('../../src/tools/GrepTool/prompt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { parameterStandIn } = await import('../../src/utils/toolErrors.ts')

const base = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-literal-')))
const dir = join(base, 'work')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'call.ts'), 'const a = foo(bar[0])\nconst b = foobar0\nconst c = foo(bar[1])\n')
writeFileSync(join(dir, 'env.sh'), 'echo $VAR\necho VAR\nprintf "%s" "$VAR"\n')
writeFileSync(join(dir, 'dots.txt'), 'a.b here\naxb there\na-b too\n')
writeFileSync(join(dir, 'dash.txt'), 'flag --literal-ish\nflag -F\n')
writeFileSync(join(dir, 'quotes.txt'), "say 'hi'\nsay \u2018hi\u2019\n")

const context = {
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
} as never
type Answer = { data: { content?: string; numLines?: number; numFiles: number; numMatches?: number; filenames: string[] } }
const grep = async (input: Record<string, unknown>): Promise<Answer> =>
  (await runWithCwdOverride(dir, () => GrepTool.call({ output_mode: 'content', path: dir, ...input } as never, context))) as Answer
const lines = (answer: Answer): string[] => (answer.data.content ?? '').split('\n').filter(Boolean)

console.log('literal: true matches the exact bytes of a pattern full of regex characters')
{
  const call = await grep({ pattern: 'foo(bar[0])', literal: true })
  check('foo(bar[0]) finds the one line that carries those bytes', lines(call).length === 1 && lines(call)[0]!.includes('foo(bar[0])'), JSON.stringify(call.data))
  const plain = await grep({ pattern: 'foo(bar[0])' })
  check('without literal the same pattern is a regex: the group and class match foobar0 instead', lines(plain).length === 1 && lines(plain)[0]!.includes('foobar0'), JSON.stringify(plain.data))
  const dollar = await grep({ pattern: '$VAR', literal: true })
  check('$VAR finds both lines that carry it (no end-of-line anchor)', lines(dollar).length === 2, JSON.stringify(dollar.data))
  const dot = await grep({ pattern: 'a.b', literal: true })
  check('a.b matches the dot itself and not axb or a-b', lines(dot).length === 1 && lines(dot)[0]!.includes('a.b here'), JSON.stringify(dot.data))
  const dotRegex = await grep({ pattern: 'a.b' })
  check('the default is unchanged: a.b as a regex matches all three', lines(dotRegex).length === 3, JSON.stringify(dotRegex.data))
}

console.log('refusals: the literal road adds nothing a regex would — no quote widening, no dash as an option, no PCRE2 road')
{
  const dash = await grep({ pattern: '-F', literal: true })
  check('a pattern that opens with a dash is text, never an option', lines(dash).length === 1 && lines(dash)[0]!.includes('flag -F'), JSON.stringify(dash.data))
  const straight = await grep({ pattern: "'hi'", literal: true })
  check("literal 'hi' matches the straight quotes only, never the curly spelling", lines(straight).length === 1 && lines(straight)[0]!.includes("say 'hi'"), JSON.stringify(straight.data))
  const widened = await grep({ pattern: "'hi'" })
  check('the regex road still widens quotes to both spellings (the control)', lines(widened).length === 2, JSON.stringify(widened.data))
  const count = await grep({ pattern: 'foo(bar[', literal: true, output_mode: 'count' })
  check('an unbalanced bracket is plain text in count mode too', count.data.numMatches === 2, JSON.stringify(count.data))
  const files = await grep({ pattern: '(', literal: true, output_mode: 'files_with_matches' })
  check('a lone parenthesis lists the files that carry one', files.data.numFiles === 1 && files.data.filenames[0]!.endsWith('call.ts'), JSON.stringify(files.data))
  const insensitive = await grep({ pattern: 'FOO(BAR[0])', literal: true, '-i': true })
  check('literal composes with -i', lines(insensitive).length === 1, JSON.stringify(insensitive.data))
  const off = await grep({ pattern: 'foo(bar[0])', literal: false })
  check('literal: false is the regex road', lines(off).length === 1 && lines(off)[0]!.includes('foobar0'), JSON.stringify(off.data))
}

console.log('the description says when to use it and the schema carries the switch')
{
  const description = getDescription()
  check('the usage line names literal: true with the three examples', description.includes('`literal: true` matches the pattern as exact text (rg -F): `foo(bar[0])`, `$VAR` or `a.b` need no escaping'), description)
  const schema = GrepTool.inputJSONSchema as { properties?: Record<string, { type?: string; description?: string }> } | undefined
  const properties = schema?.properties ?? (GrepTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape
  check('the schema has a literal property, off by default', 'literal' in properties && !/literal: true/.test(JSON.stringify(GrepTool.inputSchema.safeParse({ pattern: 'x' }))))
  check('the -F stand-in points at the switch instead of asking the model to escape', parameterStandIn('Grep', '-F') === 'literal true matches the pattern as exact text')
  const parsed = GrepTool.inputSchema.safeParse({ pattern: 'x', literal: 'true' })
  check('a spelled-out literal is read by the same semantic boolean the other switches use', parsed.success === true && (parsed.data as { literal?: boolean }).literal === true, JSON.stringify(parsed))
  check('a word that is not a boolean is refused like any other switch', GrepTool.inputSchema.safeParse({ pattern: 'x', literal: 'yes' }).success === false)
}

rmSync(base, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grep-literal: ${failures} FAILED`)
  process.exit(1)
}
console.log('\nprove-grep-literal: all green')
