#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

const ROAD = process.env.GREP_PCRE2_ROAD ?? 'engine'
const LOOKAROUND = '(?<![A-Za-z])system(?![A-Za-z])'
const BACKREFERENCE = '(foo)\\1'
const CLAUSE_LOOKAROUND = 'matched with PCRE2: the pattern uses lookaround'
const CLAUSE_BACKREFERENCE = 'matched with PCRE2: the pattern uses a backreference'

const grepModule = (await import('../../src/tools/GrepTool/GrepTool.ts')) as unknown as {
  GrepTool: typeof import('../../src/tools/GrepTool/GrepTool.ts').GrepTool
  pcreOnlyConstruct?: (pattern: string) => string | null
}
const { GrepTool } = grepModule
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { resolveRipgrep, ripGrepAnswer, isRipgrepUsageDiagnostic } = await import('../../src/utils/ripgrep.ts')
const { whichSync } = await import('../../src/utils/which.ts')

type Data = {
  mode?: string
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
  incomplete?: string
  engine?: string
}
type Outcome = { data: Data; text: string; error: string | null; errorName: string | null }

const context = {
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
} as never

const search = async (fixture: string, input: Record<string, unknown>): Promise<Outcome> => {
  try {
    const result = (await GrepTool.call({ path: fixture, ...input } as never, context)) as { data: Data }
    const block = GrepTool.mapToolResultToToolResultBlockParam(result.data as never, 'tu-1') as { content: unknown }
    return { data: result.data, text: String(block.content), error: null, errorName: null }
  } catch (error) {
    return { data: { numFiles: 0, filenames: [] }, text: '', error: error instanceof Error ? error.message : String(error), errorName: error instanceof Error ? error.name : null }
  }
}
const names = (outcome: Outcome): string[] => outcome.data.filenames.map(f => f.split(/[\\/]/).pop() ?? f).sort()
const oneLine = (text: string | null): boolean => text !== null && !text.includes('\n')
type Engine = { typed: boolean; text: string }
const engineAnswer = async (args: string[], fixture: string): Promise<Engine> => {
  try {
    const answer = await ripGrepAnswer(args, fixture, new AbortController().signal)
    return { typed: false, text: `${answer.complete ? 'complete' : 'INCOMPLETE'} answer: ${answer.reason ?? j(answer.lines)}` }
  } catch (error) {
    return { typed: error instanceof Error && error.name === 'RipgrepUsageError', text: error instanceof Error ? error.message : String(error) }
  }
}

const resolvedRg = (): { mode: string; rgPath: string; rgArgs: string[]; real: string } => {
  const { mode, config } = resolveRipgrep()
  const bare = !config.rgPath.includes('/') && !config.rgPath.includes('\\')
  return { mode, rgPath: config.rgPath, rgArgs: config.rgArgs, real: bare ? (whichSync(config.rgPath) ?? config.rgPath) : config.rgPath }
}

if (ROAD !== 'engine') {
  const fixture = process.env.GREP_PCRE2_FIXTURE ?? ''
  const log = process.env.GREP_SHIM_LOG ?? ''
  const spawns = (): string[] => readFileSync(log, 'utf8').split('\n').filter(line => line !== '' && !line.includes('--version'))
  const reset = (): void => writeFileSync(log, '')
  console.log(`\n=== ${ROAD} road: a shimmed rg on PATH ${ROAD === 'absent' ? 'that refuses --pcre2 the way a build without PCRE2 does' : 'that logs every spawn'}`)
  const engine = resolvedRg()
  check('the shim is the engine the tool resolves (system mode, the bare name)', engine.mode === 'system' && engine.rgPath === 'rg', j(engine))
  const warm = await search(fixture, { pattern: 'middle' })
  const probeDeadline = Date.now() + 5000
  while (!readFileSync(log, 'utf8').includes('--version') && Date.now() < probeDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  check('the warm-up search ran through the shim and the once-per-process health probe has landed', warm.error === null && warm.data.numFiles === 1 && readFileSync(log, 'utf8').includes('middle') && readFileSync(log, 'utf8').includes('--version'), warm.error ?? readFileSync(log, 'utf8'))

  reset()
  const plain = await search(fixture, { pattern: 'system', output_mode: 'content' })
  check('a plain pattern answers its three lines', plain.error === null && plain.data.numLines === 3, plain.error ?? j(plain.data))
  check('...with exactly one rg spawn (no retry) and no --pcre2', spawns().length === 1 && !spawns()[0]!.includes('--pcre2'), j(spawns()))

  reset()
  const unbalanced = await search(fixture, { pattern: 'a(b' })
  check("an unbalanced group keeps rg's parse error", unbalanced.error !== null && /regex parse error/.test(unbalanced.error), unbalanced.error ?? 'answered')
  check("...and the error text carries rg's reason line (error: unclosed group)", (unbalanced.error ?? '').includes('error: unclosed group'), unbalanced.error ?? 'answered')
  check('...with exactly one rg spawn (a genuine syntax error is never retried)', spawns().length === 1, j(spawns()))

  reset()
  const lookaround = await search(fixture, { pattern: LOOKAROUND, output_mode: 'content' })
  if (ROAD === 'count') {
    check('the lookaround pattern spawns rg exactly twice: the default engine, then --pcre2', spawns().length === 2 && !spawns()[0]!.includes('--pcre2') && spawns()[1]!.includes('--pcre2'), j(spawns()))
    check('...and answers the match with the clause', lookaround.error === null && lookaround.data.numLines === 1 && lookaround.data.engine === CLAUSE_LOOKAROUND, lookaround.error ?? j(lookaround.data))
    reset()
    const backreference = await search(fixture, { pattern: BACKREFERENCE })
    check('the backreference pattern retries once with --pcre2 and answers its file', spawns().length === 2 && spawns()[1]!.includes('--pcre2') && backreference.error === null && backreference.data.numFiles === 1, backreference.error ?? j({ spawns: spawns(), data: backreference.data }))
  } else {
    check("without PCRE2 the lookaround refusal is one line: rg's parse error beside the \\b rewrite", oneLine(lookaround.error) && /regex parse error/.test(lookaround.error ?? '') && (lookaround.error ?? '').includes('\\bsystem\\b'), lookaround.error ?? 'answered')
    check("...carrying rg's reason line (error: look-around ... is not supported)", (lookaround.error ?? '').includes('error: look-around'), lookaround.error ?? 'answered')
    check('...as the typed usage refusal (RipgrepUsageError)', lookaround.errorName === 'RipgrepUsageError', j(lookaround.errorName))
    check('...after exactly one retry (two spawns, the second with --pcre2, no third)', spawns().length === 2 && spawns()[1]!.includes('--pcre2'), j(spawns()))
    reset()
    const backreference = await search(fixture, { pattern: BACKREFERENCE })
    check('without PCRE2 the backreference refusal teaches the alternative in one line', oneLine(backreference.error) && /regex parse error/.test(backreference.error ?? '') && (backreference.error ?? '').includes('foofoo'), backreference.error ?? 'answered')
    check("...carrying rg's reason line (error: backreferences are not supported)", (backreference.error ?? '').includes('error: backreferences are not supported'), backreference.error ?? 'answered')
    const refused = await engineAnswer(['--pcre2', 'x'], fixture)
    check('the engine wrapper hands a --pcre2 refusal to its caller as the typed usage error, never as an incomplete answer', refused.typed && refused.text.includes('PCRE2 is not available in this build of ripgrep'), refused.text)
  }
  console.log(failures === 0 ? `  ${ROAD} road: all green` : `  ${ROAD} road: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('============================================================')
console.log(' Grep — a lookaround or a backreference falls back to PCRE2 instead of refusing')
console.log('============================================================')

const base = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-pcre2-')))
const fixture = join(base, 'fixture')
mkdirSync(fixture)
writeFileSync(join(fixture, 'a.txt'), 'the system prompt\nsubsystem\nsystems\nfoo foo\nfoofoo\nfoo bar\n')
writeFileSync(join(fixture, 'b.txt'), 'start\nmiddle\nend\n')

try {
  console.log('\n§0 the constructs the fallback recognises (the scanner behind the retry)')
  check('the scanner is exported (pcreOnlyConstruct)', typeof grepModule.pcreOnlyConstruct === 'function')
  const scan = grepModule.pcreOnlyConstruct ?? ((): null => null)
  const table: Array<[string, string | null]> = [
    [LOOKAROUND, 'lookaround'],
    ['(?=foo)', 'lookaround'],
    ['(?<=foo)bar', 'lookaround'],
    ['(?!foo)bar', 'lookaround'],
    [BACKREFERENCE, 'a backreference'],
    ['(\\w+)\\s+\\1', 'a backreference'],
    ['(?<=x)(a)\\1', 'lookaround and a backreference'],
    ['system', null],
    ['\\bsystem\\b', null],
    ['a(b', null],
    ['(?<name>x)', null],
    ['(?i)foo', null],
    ['(?:foo)', null],
    ['\\(?=', null],
    ['[(?=]', null],
    ['[\\1]', null],
    ['\\\\1', null],
    ['(?<name>x)\\k<name>', null],
  ]
  for (const [pattern, expected] of table) {
    check(`${j(pattern)} ⇒ ${j(expected)}`, scan(pattern) === expected, j(scan(pattern)))
  }
  check("the usage classifier reads rg's PCRE2 refusal as a usage diagnostic", isRipgrepUsageDiagnostic('rg: PCRE2 is not available in this build of ripgrep'))
  check("...and rg's PCRE2 compile error", isRipgrepUsageDiagnostic('rg: PCRE2: error compiling pattern at offset 7: missing closing parenthesis'))
  check('...but not an I/O line about a file whose name starts with PCRE2', !isRipgrepUsageDiagnostic('rg: /scratch/PCRE2-notes.txt: Permission denied (os error 13)'))

  const engine = resolvedRg()
  const probe = spawnSync(engine.real, [...engine.rgArgs, '--pcre2-version'], { encoding: 'utf8' })
  const hasPcre2 = probe.status === 0 && /is available/.test(probe.stdout ?? '')
  console.log(`\n  engine: ${engine.mode} ${engine.real}\n  --pcre2-version: ${((probe.stdout || probe.stderr) ?? '').trim()} (exit ${String(probe.status)})`)

  console.log(`\n§1 ${LOOKAROUND} over the fixture`)
  const lookaround = await search(fixture, { pattern: LOOKAROUND, output_mode: 'content' })
  if (hasPcre2) {
    check('the lookaround pattern answers its match instead of a refusal', lookaround.error === null, lookaround.error ?? '')
    check('the whole word alone matched: "the system prompt", not subsystem or systems', lookaround.data.numLines === 1 && (lookaround.data.content ?? '').endsWith('a.txt:1:the system prompt'), j(lookaround.data))
    check('the data carries the engine clause', lookaround.data.engine === CLAUSE_LOOKAROUND, j(lookaround.data.engine))
    check('the model-facing result says so in one clause', lookaround.text.endsWith(`\n(${CLAUSE_LOOKAROUND})`), j(lookaround.text))
    check('the walk finished', lookaround.data.incomplete === undefined, j(lookaround.data.incomplete))
  } else {
    check('without PCRE2 the refusal is one line teaching the \\b rewrite', oneLine(lookaround.error) && (lookaround.error ?? '').includes('\\bsystem\\b'), lookaround.error ?? 'answered')
  }

  console.log(`\n§2 ${BACKREFERENCE} over the fixture`)
  const backreference = await search(fixture, { pattern: BACKREFERENCE, output_mode: 'content' })
  if (hasPcre2) {
    check('the backreference pattern answers its match instead of a refusal', backreference.error === null, backreference.error ?? '')
    check('the doubled text alone matched: foofoo, not "foo foo"', backreference.data.numLines === 1 && (backreference.data.content ?? '').endsWith('a.txt:5:foofoo'), j(backreference.data))
    check('the clause names the backreference', backreference.data.engine === CLAUSE_BACKREFERENCE && backreference.text.endsWith(`\n(${CLAUSE_BACKREFERENCE})`), j(backreference.text))
  } else {
    check('without PCRE2 the refusal is one line teaching the alternative', oneLine(backreference.error) && (backreference.error ?? '').includes('foofoo'), backreference.error ?? 'answered')
  }

  console.log('\n§3 a plain pattern is never retried and carries no clause')
  const plain = await search(fixture, { pattern: 'system', output_mode: 'content' })
  check('a plain pattern answers its three lines', plain.error === null && plain.data.numLines === 3, plain.error ?? j(plain.data))
  check('no engine clause on the data or the result', plain.data.engine === undefined && !plain.text.includes('PCRE2'), j(plain.text))

  console.log("\n§4 a genuine syntax error keeps rg's message")
  const unbalanced = await search(fixture, { pattern: 'a(b' })
  check("an unbalanced group is refused with rg's parse error", unbalanced.error !== null && /regex parse error/.test(unbalanced.error) && !unbalanced.error.includes('PCRE2'), unbalanced.error ?? 'answered')
  check("...and the error text carries rg's reason line (error: unclosed group), not only the echo and the carets", (unbalanced.error ?? '').includes('error: unclosed group') && unbalanced.errorName === 'RipgrepUsageError', unbalanced.error ?? 'answered')
  const both = await search(fixture, { pattern: '(?=a)b(c' })
  if (hasPcre2) {
    check('an unbalanced group beside a lookaround is refused with the engine that names the group', both.error !== null && /missing closing parenthesis|unclosed group/.test(both.error), both.error ?? 'answered')
    const compileError = await engineAnswer(['--pcre2', 'a(b'], fixture)
    check("the engine wrapper hands a PCRE2 compile error to its caller as the typed usage error carrying rg's line", compileError.typed && compileError.text.includes('rg: PCRE2: error compiling pattern') && compileError.text.includes('missing closing parenthesis'), compileError.text)
  } else {
    check('an unbalanced group beside a lookaround is refused in one line', oneLine(both.error), both.error ?? 'answered')
  }

  if (hasPcre2) {
    console.log('\n§5 multiline, case folding and the other modes compose with the fallback')
    const across = await search(fixture, { pattern: 'start(?=.*end)', output_mode: 'content', multiline: true })
    check('-U --multiline-dotall composes: a lookahead across lines matches', across.error === null && across.data.numLines === 1 && (across.data.content ?? '').endsWith('b.txt:1:start') && across.data.engine === CLAUSE_LOOKAROUND, across.error ?? j(across.data))
    const behind = await search(fixture, { pattern: '(?<=start\\n)middle', output_mode: 'content', multiline: true })
    check('-U composes: a lookbehind over the newline matches', behind.error === null && behind.data.numLines === 1 && (behind.data.content ?? '').endsWith('b.txt:2:middle'), behind.error ?? j(behind.data))
    const folded = await search(fixture, { pattern: '(?<![a-z])SYSTEM(?![a-z])', output_mode: 'content', '-i': true })
    check('-i composes', folded.error === null && folded.data.numLines === 1 && (folded.data.content ?? '').endsWith('a.txt:1:the system prompt'), folded.error ?? j(folded.data))
    const files = await search(fixture, { pattern: BACKREFERENCE })
    check('files_with_matches answers the file and the clause', files.error === null && j(names(files)) === j(['a.txt']) && files.text.startsWith('Found 1 file') && files.text.endsWith(`\n(${CLAUSE_BACKREFERENCE})`), files.error ?? j(files.text))
    const counted = await search(fixture, { pattern: BACKREFERENCE, output_mode: 'count' })
    check('count answers the tally and the clause', counted.error === null && counted.data.numMatches === 1 && counted.text.includes('1 match across 1 file') && counted.text.endsWith(`\n(${CLAUSE_BACKREFERENCE})`), counted.error ?? j(counted.text))
    const globbed = await search(fixture, { pattern: '(?<!sub)system', glob: 'a.txt' })
    check('a glob composes', globbed.error === null && j(names(globbed)) === j(['a.txt']), globbed.error ?? j(globbed.data))
    const none = await search(fixture, { pattern: '(?<!x)zzzz', output_mode: 'content' })
    check('a PCRE2 search with no match still says which engine ran', none.error === null && none.data.numLines === 0 && none.text === `No matches found\n(${CLAUSE_LOOKAROUND})`, none.error ?? j(none.text))
  }

  console.log('\n§6 the description tells the model in one sentence')
  const description = await GrepTool.description()
  check('the description names the fallback', /PCRE2/.test(description), description.split('\n').filter(line => /pcre2/i.test(line)).join(' | '))

  if (process.platform !== 'win32') {
    const shimDir = join(base, 'shim')
    mkdirSync(shimDir)
    const log = join(base, 'spawns.log')
    writeFileSync(log, '')
    writeFileSync(
      join(shimDir, 'rg'),
      [
        '#!/bin/sh',
        'tab="$(printf \'\\t\')"',
        'line=""',
        'for arg in "$@"; do line="${line}${arg}${tab}"; done',
        'printf \'%s\\n\' "$line" >> "$GREP_SHIM_LOG"',
        'if [ -n "$GREP_SHIM_NO_PCRE2" ]; then',
        '  for arg in "$@"; do',
        '    if [ "$arg" = "--pcre2" ]; then',
        '      echo "rg: PCRE2 is not available in this build of ripgrep" >&2',
        '      exit 2',
        '    fi',
        '  done',
        'fi',
        'exec "$GREP_SHIM_REAL_RG" "$@"',
        '',
      ].join('\n'),
    )
    chmodSync(join(shimDir, 'rg'), 0o755)
    for (const road of ['count', 'absent'] as const) {
      const child = spawnSync(process.execPath, ['run', fileURLToPath(import.meta.url)], {
        stdio: 'inherit',
        env: {
          ...process.env,
          GREP_PCRE2_ROAD: road,
          GREP_PCRE2_FIXTURE: fixture,
          GREP_SHIM_LOG: log,
          GREP_SHIM_REAL_RG: engine.real,
          ...(road === 'absent' ? { GREP_SHIM_NO_PCRE2: '1' } : {}),
          MERCURY_BUILTIN_RIPGREP: '0',
          PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        },
      })
      check(`the ${road} road passed`, child.status === 0, `exit ${String(child.status)}`)
    }
  } else {
    console.log('\n  (the shim roads need a POSIX shell; skipped on win32)')
  }
} catch (error) {
  failures++
  console.log(`  [FAIL] the proof threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n  ALL PASS' : `\n  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
