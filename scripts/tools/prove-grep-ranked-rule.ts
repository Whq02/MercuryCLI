#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RANKED_FIXTURE_DESCRIPTION, writeRankedFixture } from './rankedFixture.ts'

const HOME = mkdtempSync(join(realpathSync(tmpdir()), 'grep-ranked-rule-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { countPassArgs, holdsWord, linePassArgs, rankedRefusal, rankedScope, rankedSearch, rankedWords, renderRanked } = await import('../../src/tools/GrepTool/rankedSearch.ts')
const { ripGrepAnswer } = await import('../../src/utils/ripgrep.ts')

type Pass = { lines: string[]; complete: boolean; reason?: string }
const names = (pattern: string): string[] => rankedWords(pattern).map(word => word.word)

const base = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-ranked-rule-')))
process.on('exit', () => {
  try {
    rmSync(base, { recursive: true, force: true })
    rmSync(HOME, { recursive: true, force: true })
  } catch {
  }
})
const root = join(base, 'project')
const fixture = writeRankedFixture(root)
const scope = ['--hidden', '--glob', '!.git']
const calls: Array<{ args: string[]; target: string }> = []
const real = async (args: string[], target: string): Promise<Pass> => {
  calls.push({ args, target })
  return ripGrepAnswer(args, target, new AbortController().signal, { cwd: root })
}
const short = (file: string): string => file.slice(root.length + 1)

console.log('the fixture tree: a description of a behaviour finds the file that implements it, with its line range')
{
  const answer = await rankedSearch({ pattern: RANKED_FIXTURE_DESCRIPTION, root, scope, run: real })
  const shown = renderRanked(answer, short)
  const order = answer.files.map(file => short(file.file))
  const at = order.indexOf('src/net/uploadQueue.ts')
  check('the three words of the description are the ones counted', JSON.stringify(answer.words.map(word => word.word)) === '["retry","fail","upload"]', JSON.stringify(answer.words))
  check('the implementing file is in the first three results', at >= 0 && at < 3, order.join(' | '))
  check('it is the first result', at === 0, order.join(' | '))
  const range = answer.files[at]?.ranges[0]
  check(
    'its strongest range lies inside the function that retries, and holds the line that gives up',
    range !== undefined && range.start >= fixture.signature && range.end <= fixture.signature + 13 && range.start <= fixture.failure && range.end >= fixture.failure,
    JSON.stringify({ range, signature: fixture.signature, failure: fixture.failure }),
  )
  check('its row names the file, the range and the lines holding each word', shown.text.split('\n')[1] === 'src/net/uploadQueue.ts:31-38, 8 (retry 2, fail 1, upload 3)', shown.text.split('\n')[1])
  check('a file with more of every word but no two of them near each other ranks below it', order.indexOf('src/legacy/everything.ts') > at, order.join(' | '))
  check('a one-line bundle, an ignored folder and the VCS folder are never named', !order.some(file => file.startsWith('dist/') || file.startsWith('ignored/') || file.startsWith('.git/')), order.join(' | '))
  check('the first line says how it ranked, how many files hold each word and how many were searched', /^Ranked by words, not by meaning: 8 of \d+ files holding retry \(\d+ files\), fail \(\d+\), upload \(\d+\), among \d+ searched\.$/.test(shown.text.split('\n')[0]!), shown.text.split('\n')[0])
  check('the last line says that other words would not be found', shown.text.split('\n').at(-1) === 'A file that says it in other words is not listed: add the names it may go by to pattern.', shown.text.split('\n').at(-1))
  check('eight files at most, three ranges a file at most, forty lines a range at most', answer.files.length <= 8 && answer.files.every(file => file.ranges.length <= 3 && file.ranges.every(range => range.end - range.start < 40)), JSON.stringify(answer.files.map(file => file.ranges)))
  check('one counting pass a word and one line pass: four ripgrep runs', calls.length === 4, String(calls.length))
  const counted = new Set<string>()
  for (const call of calls.slice(0, 3)) for (const line of (await ripGrepAnswer(call.args, call.target, new AbortController().signal, { cwd: root })).lines) if (line.includes('\0')) counted.add(line.slice(0, line.indexOf('\0')))
  const linePass = calls[3]!
  const named = [...linePass.args.slice(linePass.args.indexOf('--') + 1), linePass.target]
  check('the line pass names only files the counting passes returned, twenty-four at most', named.length <= 24 && named.every(file => counted.has(file)), named.filter(file => !counted.has(file)).join(' | '))
  const again = renderRanked(await rankedSearch({ pattern: RANKED_FIXTURE_DESCRIPTION, root, scope, run: real }), short)
  check('the same question gives the same bytes', again.text === shown.text, again.text)
  const other = renderRanked(await rankedSearch({ pattern: 'retrying the uploads that failed', root, scope, run: real }), short)
  check('other forms of the same words give the same files and ranges in the same order', JSON.stringify(other.rows) === JSON.stringify(shown.rows), other.text)
  const stem = await rankedSearch({ pattern: 'stem a word', root, scope, run: real })
  const stemmed = stem.files.map(file => short(file.file))
  check('a word counts at a word start: "stem" finds the stemmer and never a file that only says "system"', stemmed[0] === 'src/text/stemmer.ts' && !stemmed.includes('src/store/system.ts'), stemmed.join(' | '))
  const missed = renderRanked(await rankedSearch({ pattern: 'transmit the document again once the connection drops', root, scope, run: real }), short)
  check(
    'it finds by words: the same behaviour in other words finds nothing, and the answer says how many files it searched and that it ranks by words only',
    /^No file among \d+ searched holds transmit, docu, once, connection or drop\. This ranks by words only: add the names the behaviour may go by\.$/.test(missed.text),
    missed.text,
  )
}

console.log('the words: derived as memory derives them, split inside identifiers, twelve at most')
{
  check('glue words, words under three letters and numbers are dropped', JSON.stringify(names('where do we retry a failed upload 20 times')) === '["retry","fail","upload","time"]', JSON.stringify(names('where do we retry a failed upload 20 times')))
  check('identifiers are split at their parts', JSON.stringify(names('retryCount in upload_queue for the HTTPServer')) === '["retry","count","upload","queue","http","server"]', JSON.stringify(names('retryCount in upload_queue for the HTTPServer')))
  check('a stem under four letters gives way to the word itself', JSON.stringify(names('apply the running comment')) === '["apply","running","comment"]', JSON.stringify(names('apply the running comment')))
  check('a word is counted once whatever its form', JSON.stringify(names('retry retries retried retrying')) === '["retry"]', JSON.stringify(names('retry retries retried retrying')))
  const retry = rankedWords('retries')[0]!
  check('each word has its lower, upper and capitalised spellings, and a final y its ie form', JSON.stringify(retry.spellings) === '["retry","RETRY","Retry","retrie","RETRIE","Retrie"]', JSON.stringify(retry.spellings))
  const many = Array.from({ length: 40 }, (_, index) => `word${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}x`).join(' ')
  check('twelve words at most are counted', rankedWords(many).length === 12, String(rankedWords(many).length))
}

console.log('a word counts where it starts a word or a part of an identifier')
{
  const word = rankedWords('stem')[0]!
  const cases: Array<[string, boolean]> = [
    ['const stem = 1', true],
    ['stemWord(word)', true],
    ['the_stem_table', true],
    ['wordStemmer.run()', true],
    ['MAX_STEM_LENGTH', true],
    ['toSTEMForm', true],
    ['the system is idle', false],
    ['SYSTEM_DEFAULT', false],
    ['ecosystem', false],
    ['SystemState', false],
  ]
  const wrong = cases.filter(([text, expected]) => holdsWord(text, word) !== expected).map(([text]) => text)
  check('ten spellings: six word starts count, four words that merely contain the letters do not', wrong.length === 0, wrong.join(' | '))
}

console.log('the words are data, never syntax')
{
  const hostile = '--files -e --pre=sh $(reboot) `id` ;rm -rf / .* (a|b)+ \\d{3} [z-a'
  const words = rankedWords(hostile)
  const pairs = words.flatMap(word => countPassArgs(scope, word).slice(scope.length))
  const afterFlags = words.every(word => {
    const args = countPassArgs(scope, word).slice(scope.length)
    return JSON.stringify(args.slice(0, 5)) === '["-c","--with-filename","--null","--stats","-F"]' && args.slice(5).every((arg, index) => (index % 2 === 0 ? arg === '-e' : /^[A-Za-z0-9]+$/.test(arg)))
  })
  check('every word reaches ripgrep as a fixed string behind -e, letters and digits only', words.length > 0 && afterFlags, JSON.stringify(pairs))
  const before = calls.length
  const answer = await rankedSearch({ pattern: hostile, root, scope, run: real })
  check('a pattern full of flags, shell and regex syntax runs as words and finds nothing it should not', answer.incomplete === undefined && calls.length === before + words.length + (answer.candidates > 0 ? 1 : 0), JSON.stringify({ incomplete: answer.incomplete, ran: calls.length - before, words: words.length }))
  const line = linePassArgs(rankedWords('retry'), ['/x/-e', '/x/--pre=sh'])
  check('the line pass gives its files after --, so a file name is never read as a flag', line.indexOf('--') === line.length - 3 && line.includes('-F') && line[line.indexOf('--max-columns') + 1] === '400' && line[line.indexOf('--max-count') + 1] === '500', JSON.stringify(line))
  const refusals: Array<[string, string, RegExp]> = [
    ['only glue words', 'where is the one that does this', /no word to count/],
    ['one letter', 'x', /no word to count/],
    ['5,000 words', Array.from({ length: 5000 }, (_, index) => `word${index}`).join(' '), /1000 characters at most/],
    ['a NUL byte', 'retry\0upload', /not text/],
    ['an escape sequence', 'retry \u001b[31m upload', /not text/],
    ['half of a surrogate pair', 'retry \ud83d upload', /not text/],
    ['bytes that did not decode', 'retry \ufffd\ufffd upload', /not text/],
  ]
  for (const [label, pattern, expected] of refusals) {
    const refusal = rankedRefusal(pattern)
    check(`${label}: answered in a sentence`, refusal !== null && expected.test(refusal) && refusal.startsWith('output_mode "ranked" '), String(refusal))
  }
  check('a plain description is not refused', rankedRefusal(RANKED_FIXTURE_DESCRIPTION) === null && rankedRefusal('retry\tthe\nupload') === null)
}

console.log('the scope comes from Grep: only what narrows the search is kept, in its order')
{
  const grepArgs = ['--hidden', '--type-add', 'pdf:*.pdf', '--glob', '!.git', '--max-columns', '500', '-l', 'x', '--type', 'ts', '--max-depth', '3', '--glob', 'src/**', '--iglob', '!/secret/**']
  check('hidden files, type, depth and every glob stay; the pattern and the output flags go', JSON.stringify(rankedScope(grepArgs)) === JSON.stringify(['--hidden', '--type-add', 'pdf:*.pdf', '--glob', '!.git', '--type', 'ts', '--max-depth', '3', '--glob', 'src/**', '--iglob', '!/secret/**']), JSON.stringify(rankedScope(grepArgs)))
  check('a deny rule stays last, after the caller\'s own glob', rankedScope(grepArgs).at(-1) === '!/secret/**')
}

console.log('the rule, on rows written by hand')
{
  const R = '/r'
  const rows = (counts: Record<string, number>, searched: number): Pass => ({ lines: [...Object.entries(counts).map(([file, count]) => `${R}/${file}\0${count}`), `${searched} files searched`], complete: true })
  const lines = (found: Record<string, Array<[number, string]>>): Pass => ({ lines: Object.entries(found).flatMap(([file, hits]) => hits.map(([line, text]) => `${R}/${file}\0${line}:${text}`)), complete: true })
  const scripted = (passes: Pass[]) => {
    const seen: Array<{ args: string[]; target: string }> = []
    let at = 0
    return { seen, run: async (args: string[], target: string): Promise<Pass> => (seen.push({ args, target }), passes[at++] ?? { lines: [], complete: true }) }
  }
  const rank = async (pattern: string, passes: Pass[], withhold?: (files: string[]) => string[]) => {
    const script = scripted(passes)
    const answer = await rankedSearch({ pattern, root: R, scope: [], run: script.run, ...(withhold ? { withhold } : {}) })
    return { answer, order: answer.files.map(file => file.file.slice(R.length + 1)), seen: script.seen }
  }

  const rare = await rank('alpha beta', [rows({ 'a.ts': 3, 'b.ts': 3, 'c.ts': 3, 'd.ts': 3, 'e.ts': 3, 'f.ts': 3 }, 6), rows({ 'b.ts': 1 }, 6), lines({ 'a.ts': [[1, 'alpha'], [2, 'alpha'], [3, 'alpha']], 'b.ts': [[1, 'beta']] })])
  check('rarity outweighs repetition: one line of a word one file holds beats three lines of a word every file holds', rare.order[0] === 'b.ts', rare.order.join(' | '))

  const near = await rank('alpha beta', [rows({ 'far.ts': 2, 'near.ts': 2, 'x.ts': 1 }, 9), rows({ 'far.ts': 2, 'near.ts': 2, 'y.ts': 1 }, 9), lines({ 'far.ts': [[1, 'alpha'], [2, 'alpha'], [200, 'beta'], [201, 'beta']], 'near.ts': [[50, 'alpha'], [51, 'beta'], [52, 'alpha beta']] })])
  check('the densest range is in the score: the same counts close together rank above the same counts apart', near.order[0] === 'near.ts' && near.order[1] === 'far.ts', near.order.join(' | '))
  check('a range is the matching lines no more than five apart', JSON.stringify(near.answer.files[0]!.ranges.map(range => [range.start, range.end])) === '[[50,52]]' && JSON.stringify(near.answer.files[1]!.ranges.map(range => [range.start, range.end])) === '[[1,2],[200,201]]', JSON.stringify(near.answer.files.map(file => file.ranges)))

  const path = await rank('alpha', [rows({ 'plain.ts': 1, 'alphaStore.ts': 1, 'z.ts': 1 }, 9), lines({ 'plain.ts': [[1, 'alpha']], 'alphaStore.ts': [[1, 'alpha']], 'z.ts': [[1, 'alpha']] })])
  check('a word in the path is a bonus', path.order[0] === 'alphaStore.ts', path.order.join(' | '))
  check('a tie is broken by path', path.order[1] === 'plain.ts' && path.order[2] === 'z.ts', path.order.join(' | '))

  const shuffled = await rank('alpha', [rows({ 'z.ts': 1, 'alphaStore.ts': 1, 'plain.ts': 1 }, 9), lines({ 'z.ts': [[1, 'alpha']], 'plain.ts': [[1, 'alpha']], 'alphaStore.ts': [[1, 'alpha']] })])
  check('rows arriving in another order give the same answer', renderRanked(shuffled.answer, file => file).text === renderRanked(path.answer, file => file).text, renderRanked(shuffled.answer, file => file).text)

  const wide: Record<string, number> = {}
  const wideLines: Record<string, Array<[number, string]>> = {}
  for (let index = 0; index < 40; index++) {
    const file = `f${String(index).padStart(2, '0')}.ts`
    wide[file] = 40 - index
    wideLines[file] = Array.from({ length: 200 }, (_, line) => [line * 3 + 1, 'alpha'] as [number, string])
  }
  const cut = await rank('alpha', [rows(wide, 90), lines(wideLines)])
  const namedFiles = [...cut.seen[1]!.args.slice(cut.seen[1]!.args.indexOf('--') + 1), cut.seen[1]!.target]
  check('forty candidates: twenty-four are read line by line, eight are returned', namedFiles.length === 24 && cut.answer.files.length === 8, JSON.stringify({ named: namedFiles.length, returned: cut.answer.files.length }))
  check('a range stops at forty lines and a file gives three', cut.answer.files.every(file => file.ranges.length === 3 && file.ranges.every(range => range.end - range.start < 40)), JSON.stringify(cut.answer.files[0]!.ranges))

  const strayed = await rank('alpha', [{ lines: ['/elsewhere/secret.ts\x003', `${R}/a.ts\x001`, '/r-sibling/b.ts\x002', '2 files searched'], complete: true }, { lines: ['/elsewhere/secret.ts\x001:alpha', `${R}/a.ts\x001:alpha`], complete: true }])
  check('a row for a path outside the search root is not counted, and a line for a file that was not asked for is not read', strayed.order.join('|') === 'a.ts' && strayed.answer.candidates === 1, JSON.stringify({ order: strayed.order, candidates: strayed.answer.candidates }))

  const held = await rank('alpha', [rows({ 'a.ts': 1, '.env': 4 }, 10), lines({ 'a.ts': [[1, 'alpha']] })], files => files.filter(file => !file.endsWith('.env')))
  const heldLine = held.seen[1]!
  check('a withheld file leaves every number: not a candidate, not in a word\'s count, not among the files searched, not read', held.answer.candidates === 1 && held.answer.holding[0] === 1 && held.answer.searched === 9 && ![...heldLine.args, heldLine.target].some(arg => arg.endsWith('.env')), JSON.stringify({ candidates: held.answer.candidates, holding: held.answer.holding, searched: held.answer.searched }))

  const cutCount = await rank('alpha beta gamma', [rows({ 'a.ts': 1 }, 5), { lines: [`${R}/b.ts\x001`], complete: false, reason: 'the walk was cut' }, lines({ 'a.ts': [[1, 'alpha']] })])
  check('a counting pass that is cut ends the counting: the words counted so far are ranked and the answer says it is incomplete', cutCount.answer.incomplete === 'the walk was cut' && cutCount.answer.words.length === 1 && cutCount.seen.length === 3 && cutCount.order.join('|') === 'a.ts', JSON.stringify({ incomplete: cutCount.answer.incomplete, words: cutCount.answer.words.length, passes: cutCount.seen.length }))
  const cutFirst = await rank('alpha', [{ lines: [], complete: false, reason: 'out of time' }])
  check('cut before any word was counted: nothing is ranked and no line pass starts', cutFirst.seen.length === 1 && renderRanked(cutFirst.answer, file => file).text === 'Ranked by words, not by meaning: no word was counted before the search was cut.' && cutFirst.answer.incomplete === 'out of time', renderRanked(cutFirst.answer, file => file).text)
  const cutLine = await rank('alpha', [rows({ 'a.ts': 1, 'b.ts': 1 }, 5), { lines: [`${R}/a.ts\x001:alpha`], complete: false, reason: 'the reading was cut' }])
  check('a line pass that is cut ranks what arrived and says it is incomplete', cutLine.answer.incomplete === 'the reading was cut' && cutLine.order.join('|') === 'a.ts', JSON.stringify(cutLine.answer.incomplete))

  const long = await rank('alpha', [rows({ 'min.js': 1, 'a.ts': 1 }, 5), lines({ 'min.js': [[1, '[Omitted long matching line]']], 'a.ts': [[7, 'alpha']] })])
  check('a line ripgrep left out for its length counts for nothing', long.order.join('|') === 'a.ts', long.order.join(' | '))
  const substring = await rank('stem', [rows({ 'system.ts': 9, 'stemmer.ts': 1 }, 5), lines({ 'system.ts': [[1, 'the system'], [2, 'SYSTEM']], 'stemmer.ts': [[4, 'stemWord']] })])
  check('a file whose lines only contain the letters inside another word is not returned', substring.order.join('|') === 'stemmer.ts', substring.order.join(' | '))

  const exact = renderRanked((await rank('retry failed upload', [rows({ 'net/q.ts': 2, 'a.ts': 1 }, 1284), rows({ 'net/q.ts': 1 }, 1284), rows({ 'net/q.ts': 3 }, 1284), lines({ 'net/q.ts': [[41, 'retry upload'], [44, 'upload failed'], [78, 'retryUpload()'], [120, 'upload']], 'a.ts': [[9, 'retry']] })])).answer, file => file.slice(R.length + 1))
  check(
    'the answer, to the letter',
    exact.text ===
      [
        'Ranked by words, not by meaning: 2 of 2 files holding retry (2 files), fail (1), upload (1), among 1,284 searched.',
        'net/q.ts:41-44, 78, 120 (retry 2, fail 1, upload 4)',
        'a.ts:9 (retry 1)',
        'A file that says it in other words is not listed: add the names it may go by to pattern.',
      ].join('\n'),
    exact.text,
  )
  check('the rows a screen shows are the files with their ranges', JSON.stringify(exact.rows) === '["net/q.ts:41-44, 78, 120","a.ts:9"]', JSON.stringify(exact.rows))
  const one = renderRanked((await rank('alpha', [rows({}, 1)])).answer, file => file)
  check('nothing found, one word, one file searched', one.text === 'No file among 1 searched holds alpha. This ranks by words only: add the names the behaviour may go by.', one.text)
  const two = renderRanked((await rank('alpha beta', [rows({}, 12), rows({}, 12)])).answer, file => file)
  check('nothing found, two words', two.text === 'No file among 12 searched holds alpha or beta. This ranks by words only: add the names the behaviour may go by.', two.text)
}

rmSync(base, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grep-ranked-rule: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-grep-ranked-rule: all ${checks} green`)
