#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

console.log('============================================================')
console.log(' Grep content mode — a context line carries the file text unchanged and the path spelled the way its match line is')
console.log('============================================================')

const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

const base = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-context-')))
const dir = join(base, 'work')
mkdirSync(join(dir, 'sub'), { recursive: true })
writeFileSync(join(dir, 'notes.txt'), 'alpha line\nsee http://example.com/a/b for MARK1 here\nnext/line with a/b/c path\n')
writeFileSync(join(dir, 'grep-colon.txt'), 'l1\nsee a/b/c: value here\nMARK3 is here\nurl http://x.io/p/q: end\nl5\n')
writeFileSync(join(dir, '2024-01-15-notes.md'), 'one\nsee a/b: c\nMARK4 here\ntwo/three: x\nfive\n')
writeFileSync(join(dir, 'sub', 'deep.txt'), 'top\nsee x//y: z\nMARK5 here\n./rel: w\nend\n')
writeFileSync(join(dir, 'ratio.txt'), 'x\nsee 12:30: and a-8-b/c\nMARK6 here\n10-20-30 : 7:8: d/e\nz\n')
writeFileSync(join(dir, 'multi.txt'), 'a\nMARK7 one/x: y\nb/c: d\nc\nd\nMARK7 two/x: y\ne\n')
const elsewhere = join(base, 'elsewhere')
mkdirSync(elsewhere)
writeFileSync(join(elsewhere, 'o.txt'), 'x\nsee a/b/c: here\nMARK9\ny\n')
const real = join(base, 'real')
mkdirSync(real)
writeFileSync(join(real, 'target.txt'), 'p\nsee a/b: c\nneedle here\nq\n')
const link = join(base, 'link')
symlinkSync(real, link, 'junction')

const context = {
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
} as never
type Answer = { data: { content?: string; numLines?: number; numFiles: number; numMatches?: number; filenames: string[]; appliedLimit?: number; appliedOffset?: number; incomplete?: string } }
const search = async (cwd: string, input: Record<string, unknown>): Promise<Answer> =>
  (await runWithCwdOverride(cwd, () => GrepTool.call(input as never, context))) as Answer
const lines = (answer: Answer): string[] => (answer.data.content ?? '').split('\n')
const numbered = (path: string, kind: ':' | '-', number: number, text: string): string => `${path}${kind}${number}${kind}${text}`
const rel = (...parts: string[]): string => relative(dir, join(dir, ...parts))
const groups = (answer: Answer): string[] => (answer.data.content ?? '').split('\n--\n').sort()

try {
  console.log('\n§1 the two reproductions: one context line each side of a match, the file searched by a relative path')
  const lead = await search(dir, { pattern: 'MARK1', path: 'notes.txt', output_mode: 'content', '-C': 1 })
  check(
    'a context line is spelled with the same relative path as its match line',
    j(lines(lead)) === j([numbered('notes.txt', '-', 1, 'alpha line'), numbered('notes.txt', ':', 2, 'see http://example.com/a/b for MARK1 here'), numbered('notes.txt', '-', 3, 'next/line with a/b/c path')]),
    j(lines(lead)),
  )
  const colon = await search(dir, { pattern: 'MARK3', path: 'grep-colon.txt', output_mode: 'content', '-C': 1 })
  const colonWant = [numbered('grep-colon.txt', '-', 2, 'see a/b/c: value here'), numbered('grep-colon.txt', ':', 3, 'MARK3 is here'), numbered('grep-colon.txt', '-', 4, 'url http://x.io/p/q: end')]
  check('a context line whose own text holds a colon keeps its text byte for byte (no slash turned into a backslash)', j(lines(colon)) === j(colonWant), j(lines(colon)))
  const alias = await search(dir, { pattern: 'MARK3', path: 'grep-colon.txt', output_mode: 'content', context: 1 })
  check('the context parameter answers exactly as -C does', j(lines(alias)) === j(colonWant), j(lines(alias)))

  console.log('\n§2 the other context shapes')
  const askew = await search(dir, { pattern: 'MARK3', path: 'grep-colon.txt', output_mode: 'content', '-B': 2, '-A': 1 })
  check(
    '-B 2 -A 1: the context line without a colon is spelled like the rest',
    j(lines(askew)) === j([numbered('grep-colon.txt', '-', 1, 'l1'), ...colonWant]),
    j(lines(askew)),
  )
  const bare = await search(dir, { pattern: 'MARK3', path: 'grep-colon.txt', output_mode: 'content', '-C': 1, '-n': false })
  check(
    'without line numbers the context lines keep their text and their path',
    j(lines(bare)) === j(['grep-colon.txt-see a/b/c: value here', 'grep-colon.txt:MARK3 is here', 'grep-colon.txt-url http://x.io/p/q: end']),
    j(lines(bare)),
  )
  const dated = await search(dir, { pattern: 'MARK4', path: '2024-01-15-notes.md', output_mode: 'content', '-C': 1 })
  check(
    'a file named with dashes and digits is read as one path on every line',
    j(lines(dated)) === j([numbered('2024-01-15-notes.md', '-', 2, 'see a/b: c'), numbered('2024-01-15-notes.md', ':', 3, 'MARK4 here'), numbered('2024-01-15-notes.md', '-', 4, 'two/three: x')]),
    j(lines(dated)),
  )
  const deepPath = rel('sub', 'deep.txt')
  const deep = await search(dir, { pattern: 'MARK5', path: join('sub', 'deep.txt'), output_mode: 'content', '-C': 1 })
  check(
    'a file in a folder is spelled by its relative path on every line, and a double slash or a dot segment in the context text survives',
    j(lines(deep)) === j([numbered(deepPath, '-', 2, 'see x//y: z'), numbered(deepPath, ':', 3, 'MARK5 here'), numbered(deepPath, '-', 4, './rel: w')]),
    j(lines(deep)),
  )
  const ratio = await search(dir, { pattern: 'MARK6', path: 'ratio.txt', output_mode: 'content', '-C': 1 })
  check(
    'colon-number and dash-number runs inside the context text are text, never a prefix',
    j(lines(ratio)) === j([numbered('ratio.txt', '-', 2, 'see 12:30: and a-8-b/c'), numbered('ratio.txt', ':', 3, 'MARK6 here'), numbered('ratio.txt', '-', 4, '10-20-30 : 7:8: d/e')]),
    j(lines(ratio)),
  )
  const multi = await search(dir, { pattern: 'MARK7', path: 'multi.txt', output_mode: 'content', '-C': 1 })
  check(
    'two hits in one file with a gap: the separator line stays as it is and both groups carry the one path',
    j(lines(multi)) ===
      j([numbered('multi.txt', '-', 1, 'a'), numbered('multi.txt', ':', 2, 'MARK7 one/x: y'), numbered('multi.txt', '-', 3, 'b/c: d'), '--', numbered('multi.txt', '-', 5, 'd'), numbered('multi.txt', ':', 6, 'MARK7 two/x: y'), numbered('multi.txt', '-', 7, 'e')]),
    j(lines(multi)),
  )

  console.log('\n§3 a search over the whole folder: groups of several files, whatever order the walk answers in')
  const all = await search(dir, { pattern: 'MARK', output_mode: 'content', '-C': 1 })
  const wantGroups = [
    [numbered('notes.txt', '-', 1, 'alpha line'), numbered('notes.txt', ':', 2, 'see http://example.com/a/b for MARK1 here'), numbered('notes.txt', '-', 3, 'next/line with a/b/c path')],
    colonWant,
    [numbered('2024-01-15-notes.md', '-', 2, 'see a/b: c'), numbered('2024-01-15-notes.md', ':', 3, 'MARK4 here'), numbered('2024-01-15-notes.md', '-', 4, 'two/three: x')],
    [numbered(deepPath, '-', 2, 'see x//y: z'), numbered(deepPath, ':', 3, 'MARK5 here'), numbered(deepPath, '-', 4, './rel: w')],
    [numbered('ratio.txt', '-', 2, 'see 12:30: and a-8-b/c'), numbered('ratio.txt', ':', 3, 'MARK6 here'), numbered('ratio.txt', '-', 4, '10-20-30 : 7:8: d/e')],
    [numbered('multi.txt', '-', 1, 'a'), numbered('multi.txt', ':', 2, 'MARK7 one/x: y'), numbered('multi.txt', '-', 3, 'b/c: d')],
    [numbered('multi.txt', '-', 5, 'd'), numbered('multi.txt', ':', 6, 'MARK7 two/x: y'), numbered('multi.txt', '-', 7, 'e')],
  ].map(group => group.join('\n')).sort()
  check('every group of every file is spelled under its own relative path with its text unchanged', j(groups(all)) === j(wantGroups), j(groups(all)))
  check('the answer counts its lines as before: the seven groups of three and the six separators between them', all.data.numLines === 27 && all.data.incomplete === undefined, j({ numLines: all.data.numLines, incomplete: all.data.incomplete }))

  console.log('\n§4 a page that starts or ends inside a group')
  const first = await search(dir, { pattern: 'MARK3', path: 'grep-colon.txt', output_mode: 'content', '-C': 2, head_limit: 2 })
  check(
    'a first page of two context lines (the hit is on the next page) is spelled like the hit will be',
    j(lines(first)) === j([numbered('grep-colon.txt', '-', 1, 'l1'), numbered('grep-colon.txt', '-', 2, 'see a/b/c: value here')]) && first.data.appliedLimit === 2 && first.data.numLines === 2,
    j({ lines: lines(first), appliedLimit: first.data.appliedLimit, numLines: first.data.numLines }),
  )
  const last = await search(dir, { pattern: 'MARK3', path: 'grep-colon.txt', output_mode: 'content', '-C': 2, head_limit: 2, offset: 3 })
  check(
    'a page that opens after the hit holds only context lines, spelled the same',
    j(lines(last)) === j([numbered('grep-colon.txt', '-', 4, 'url http://x.io/p/q: end'), numbered('grep-colon.txt', '-', 5, 'l5')]) && last.data.appliedOffset === 3 && last.data.numLines === 2,
    j({ lines: lines(last), appliedOffset: last.data.appliedOffset, numLines: last.data.numLines }),
  )

  console.log('\n§5 a file given through a linked folder: the context lines take the spelling the search was given')
  const targetPath = join('link', 'target.txt')
  const viaFile = await search(base, { pattern: 'needle', path: join(link, 'target.txt'), output_mode: 'content', '-C': 1 })
  check(
    'a file root reached through a link spells every line under the given path',
    j(lines(viaFile)) === j([numbered(targetPath, '-', 2, 'see a/b: c'), numbered(targetPath, ':', 3, 'needle here'), numbered(targetPath, '-', 4, 'q')]),
    j(lines(viaFile)),
  )
  const viaDirectory = await search(base, { pattern: 'needle', path: link, output_mode: 'content', '-C': 1 })
  check(
    'a folder root reached through a link too',
    j(lines(viaDirectory)) === j([numbered(targetPath, '-', 2, 'see a/b: c'), numbered(targetPath, ':', 3, 'needle here'), numbered(targetPath, '-', 4, 'q')]),
    j(lines(viaDirectory)),
  )

  console.log('\n§6 what must not move: a file outside the working folder keeps its absolute path on every line; the other modes and a search without context answer as before')
  const outside = join(elsewhere, 'o.txt')
  const away = await search(dir, { pattern: 'MARK9', path: outside, output_mode: 'content', '-C': 1 })
  check(
    'outside the working folder every line, context included, carries the absolute path',
    j(lines(away)) === j([numbered(outside, '-', 2, 'see a/b/c: here'), numbered(outside, ':', 3, 'MARK9'), numbered(outside, '-', 4, 'y')]),
    j(lines(away)),
  )
  const plain = await search(dir, { pattern: 'MARK', output_mode: 'content' })
  const plainWant = [
    numbered('notes.txt', ':', 2, 'see http://example.com/a/b for MARK1 here'),
    numbered('grep-colon.txt', ':', 3, 'MARK3 is here'),
    numbered('2024-01-15-notes.md', ':', 3, 'MARK4 here'),
    numbered(deepPath, ':', 3, 'MARK5 here'),
    numbered('ratio.txt', ':', 3, 'MARK6 here'),
    numbered('multi.txt', ':', 2, 'MARK7 one/x: y'),
    numbered('multi.txt', ':', 6, 'MARK7 two/x: y'),
  ].sort()
  check('a content search without context lists its hits under their relative paths', j([...lines(plain)].sort()) === j(plainWant) && plain.data.numLines === 7, j(lines(plain)))
  const counted = await search(dir, { pattern: 'MARK', output_mode: 'count' })
  const countWant = ['notes.txt:1', 'grep-colon.txt:1', '2024-01-15-notes.md:1', `${deepPath}:1`, 'ratio.txt:1', 'multi.txt:2'].sort()
  check('count mode answers its tallies per relative path', j([...lines(counted)].sort()) === j(countWant) && counted.data.numMatches === 7 && counted.data.numFiles === 6, j({ lines: lines(counted), numMatches: counted.data.numMatches, numFiles: counted.data.numFiles }))
  const listed = await search(dir, { pattern: 'MARK' })
  check('the file list answers the relative paths', j([...listed.data.filenames].sort()) === j(['notes.txt', 'grep-colon.txt', '2024-01-15-notes.md', deepPath, 'ratio.txt', 'multi.txt'].sort()), j(listed.data.filenames))
  const none = await search(dir, { pattern: 'NOSUCHWORD', output_mode: 'content', '-C': 1 })
  check('a search with context and no hit answers an empty content', (none.data.content ?? '') === '' && none.data.numLines === 0, j(none.data))
} catch (error) {
  failures++
  console.log(`  [FAIL] the proof threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n  ALL PASS' : `\n  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
