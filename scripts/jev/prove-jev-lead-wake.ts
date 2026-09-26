#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = 'scripts/jev/lead-wake.ts'
let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function finish(): never {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

section('§0 the wake script is on this tree')
check(`the wake script exists at ${SCRIPT}`, existsSync(join(ROOT, SCRIPT)), 'no such file on this tree — the lead wake has not landed')
if (failures > 0) finish()

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-lead-wake-home-')))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'jev-lead-wake-comms-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET', 'MERCURY_JEV_BASE', 'MERCURY_OPENROUTER_API_BASE']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { startJevStandin, openrouterFailure, LEAD_WAKE_FIXTURES, fixtureAnswerer } = await import('./lib/jevStandin.ts')
const router = await startJevStandin('openrouter')
router.answerWith(fixtureAnswerer(LEAD_WAKE_FIXTURES))
process.env.MERCURY_OPENROUTER_API_BASE = `${router.base}/api/v1`
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const OR_KEY = 'proof-openrouter-key-not-real'
secrets.writeStoredOpenrouterApiKey(OR_KEY)
setting.setJevEnabled(true, 'openrouter')

const wake = await import('./lead-wake.ts')

const COMMS = join(SCRATCH, 'comms')
mkdirSync(COMMS)
const STATE = join(SCRATCH, 'state', 'wake.state')
const LEAD_HEADER = '# LEAD-W1 — the lead-dev’s lines to the lead\n\nThe day’s history is elsewhere; bugs only below, one per line, newest at the bottom.\n'
writeFileSync(join(COMMS, 'LEAD-W1.md'), `${LEAD_HEADER}\nCURRENT (22:3x): NO LIMITS is the law; the pool ended with nine reds, owners to name from their logs.\nthe usage popup still clips its last row at 80 columns after the expired-key fix\n`)
writeFileSync(join(COMMS, 'ALPHA.md'), [
  '# ALPHA',
  '',
  '2026-09-26 21:02:11 BST — LANDED 1a2b3c4d5 (one commit), clean worktree; typecheck 0; suite 12/12 green fixture-id:lead-wake-landing',
  '2026-09-26 21:10:40 BST — BLOCKED: the fixture socket path exceeds the AF_UNIX limit under the required scratchpad; need the lead’s word on a shorter alias fixture-id:lead-wake-blocked',
  '2026-09-26 21:12:03 BST — status: re-truing the frames at 80x21, nothing owed yet fixture-id:lead-wake-status',
  '',
].join('\n'))
writeFileSync(join(COMMS, 'BETA.md'), [
  '# BETA',
  '',
  '21:20:15 (BST) — QUESTION FOR THE LEAD: does the popup bound the view or the terminal at 178x51? fixture-id:lead-wake-question',
  '21:25:44 (BST) — finding: the composer keeps its draft across a fork; no product change needed fixture-id:lead-wake-finding',
  '21:31:09 (BST) — scope request: src/utils/config/schema.ts:331 needs two additive fields; asking before the edit fixture-id:lead-wake-scope',
  '',
].join('\n'))
writeFileSync(join(COMMS, 'MERCURY-LEAD-W1.md'), '# the lead’s own lines\n\n21:40:00 BST — to ALPHA: use the short alias; never read this file as a question fixture-id:lead-wake-own\n')

type Run = { rc: number | null; out: string; err: string; lines: string[] }
function run(args: string[]): Promise<Run> {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ['run', SCRIPT, ...args], { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })
    child.on('close', code => resolveRun({ rc: code, out, err, lines: out.trimEnd().split('\n') }))
  })
}
const bodies = (): string[] => router.received.map(record => record.rawBody)
const states = (): Record<string, unknown> => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as Record<string, unknown>) : {})

section('§1 the pure pieces: lines, stamps, the state and the file order')
check('a heading and a blank line are not lines; a bug line and a stamped line are', !wake.judgedLine('# H') && !wake.judgedLine('   ') && wake.judgedLine('the popup clips') && wake.judgedLine('21:02:11 (BST) — LANDED'))
check('the stamp splits off in every form the comms files use', JSON.stringify(wake.splitStamp('2026-09-26 21:02:11 BST — LANDED x')) === JSON.stringify({ stamp: '21:02:11', words: 'LANDED x' }) && JSON.stringify(wake.splitStamp('21:20:15 (BST) — Q')) === JSON.stringify({ stamp: '21:20:15', words: 'Q' }) && JSON.stringify(wake.splitStamp('- 21:20 — Q')) === JSON.stringify({ stamp: '21:20', words: 'Q' }) && JSON.stringify(wake.splitStamp('22:56 · density LANDED')) === JSON.stringify({ stamp: '22:56', words: 'density LANDED' }) && JSON.stringify(wake.splitStamp('[2026-09-26 16:16:42 BST] THIRD COMMIT')) === JSON.stringify({ stamp: '16:16:42', words: 'THIRD COMMIT' }) && JSON.stringify(wake.splitStamp('2026-09-26 18:49:44 +0100 — to the lead')) === JSON.stringify({ stamp: '18:49:44', words: 'to the lead' }) && wake.splitStamp('CURRENT (22:3x): law').stamp === null)
const fresh = wake.newLinesOf('X.md', '# X\n\na\nb\nc\n', undefined, 2)
check('no state: the last N judged lines, numbered by their place in the file', fresh.lines.map(l => `${l.number}:${l.words}`).join(',') === '4:b,5:c' && fresh.count === 5 && !fresh.rewound)
const since = wake.newLinesOf('X.md', '# X\n\na\nb\nc\n', 4, 2)
check('a state: every judged line past the count', since.lines.map(l => `${l.number}:${l.words}`).join(',') === '5:c')
const shrunk = wake.newLinesOf('X.md', '# X\n\na\n', 9, 2)
check('a file shorter than the state saw is re-read whole', shrunk.rewound && shrunk.lines.map(l => l.words).join(',') === 'a' && shrunk.count === 3)
check('the file order puts the lead-dev’s file first and never the lead’s own', JSON.stringify(wake.commsFiles(COMMS)) === JSON.stringify(['LEAD-W1.md', 'ALPHA.md', 'BETA.md']))
check('the question set is one noul, needs_answer, and the floor is 0.8', wake.LEAD_WAKE_QUESTIONS.length === 1 && wake.LEAD_WAKE_QUESTIONS[0]!.id === 'needs_answer' && wake.LEAD_WAKE_QUESTIONS[0]!.kind === 'noul' && wake.LEAD_WAKE_QUESTION_FLOOR === 0.8)
check('a missing or malformed state reads as empty', JSON.stringify(wake.readState(join(SCRATCH, 'none'))) === '{}' && (() => {
  writeFileSync(join(SCRATCH, 'bad.state'), '[1,2')
  return JSON.stringify(wake.readState(join(SCRATCH, 'bad.state'))) === '{}'
})())

section('§2 no arguments is a usage refusal, exit 4')
const usage = await run([])
check('exit 4 with a usage line', usage.rc === 4 && /usage: /.test(usage.err + usage.out), `${usage.rc} ${usage.err.slice(0, 120)}`)
const noState = await run([COMMS])
check('a comms dir without --state is refused', noState.rc === 4 && /--state/.test(noState.err))

section('§3 the first wake: the lead-dev’s lines whole and first, the questions next by probability, then the rest; the state written')
router.reset()
const first = await run([COMMS, '--state', STATE])
check('exit 0', first.rc === 0, `${first.rc} ${first.err.slice(0, 200)}`)
check('LEAD-W1.md’s lines come first, whole and unflagged', first.lines[0] === 'LEAD-W1.md — 3 new line(s), read whole:' && first.lines[1] === '  3: The day’s history is elsewhere; bugs only below, one per line, newest at the bottom.' && first.lines[2]!.startsWith('  5: CURRENT (22:3x): NO LIMITS') && first.lines[3] === '  6: the usage popup still clips its last row at 80 columns after the expired-key fix', first.lines.slice(0, 4).join(' | '))
check('the questions follow, highest probability first, with file, line number, stamp and the line', first.lines[4] === 'QUESTIONS (p ≥ 0.80) — 3:' && /^  QUESTION BETA\.md:5 21:31:09 p=0\.93 · scope request: /.test(first.lines[5] ?? '') && /^  QUESTION ALPHA\.md:4 21:10:40 p=0\.91 · BLOCKED: /.test(first.lines[6] ?? '') && /^  QUESTION BETA\.md:3 21:20:15 p=0\.82 · QUESTION FOR THE LEAD: /.test(first.lines[7] ?? ''), first.lines.slice(4, 8).join(' | '))
check('the rest follow with their numbers, by file and line', first.lines[8] === 'THE REST — 3 line(s):' && /^  ALPHA\.md:3 21:02:11 p=0\.08 · LANDED /.test(first.lines[9] ?? '') && /^  ALPHA\.md:5 21:12:03 p=0\.12 · status: /.test(first.lines[10] ?? '') && /^  BETA\.md:4 21:25:44 p=0\.41 · finding: /.test(first.lines[11] ?? ''), first.lines.slice(8, 12).join(' | '))
check('one request per comms line, six in all, on the OpenRouter road', router.received.length === 6 && router.received.every(r => r.path === '/api/v1/systemone'), String(router.received.length))
check('every body carries only the file name and the line’s words with the one noul', bodies().every(raw => {
  const body = JSON.parse(raw) as { state: Record<string, unknown>; questions: Record<string, { type: string }> }
  return JSON.stringify(Object.keys(body.state)) === JSON.stringify(['file', 'line']) && JSON.stringify(Object.keys(body.questions)) === JSON.stringify(['needs_answer']) && body.questions.needs_answer!.type === 'noul'
}), bodies()[0]?.slice(0, 200))
check('no body carries a path, the lead-dev’s words, or the lead’s own file', bodies().every(raw => !raw.includes(ROOT) && !raw.includes(SCRATCH) && !raw.includes('NO LIMITS') && !raw.includes('lead-wake-own') && !raw.includes('MERCURY-LEAD-W1')))
check('the stamp is split off the words that leave the machine', bodies().every(raw => !/\d{2}:\d{2}:\d{2}/.test((JSON.parse(raw) as { state: { line: string } }).state.line)))
check('the state file holds the line count of every file read, and not the lead’s own', JSON.stringify(states()) === JSON.stringify({ 'LEAD-W1.md': 6, 'ALPHA.md': 5, 'BETA.md': 5 }), JSON.stringify(states()))

section('§4 the second wake finds nothing new; a line appended after the state is found alone')
router.reset()
const second = await run([COMMS, '--state', STATE])
check('nothing new: the lead-dev’s file says so and no line is listed', second.rc === 0 && second.lines[0] === 'LEAD-W1.md — no new line' && second.lines[1] === 'no new comms line since the last wake' && router.received.length === 0, second.lines.join(' | '))
appendFileSync(join(COMMS, 'ALPHA.md'), '2026-09-26 21:50:00 BST — QUESTION FOR THE LEAD: may I widen the popup by one column? fixture-id:lead-wake-question\n')
appendFileSync(join(COMMS, 'LEAD-W1.md'), 'the crew transcript drops the landed row’s sha after a compaction\n')
router.reset()
const third = await run([COMMS, '--state', STATE])
check('the appended lead-dev line prints first; the appended question is the one flagged line; one request', third.lines[0] === 'LEAD-W1.md — 1 new line(s), read whole:' && third.lines[1] === '  7: the crew transcript drops the landed row’s sha after a compaction' && third.lines[2] === 'QUESTIONS (p ≥ 0.80) — 1:' && /^  QUESTION ALPHA\.md:6 21:50:00 p=0\.82 · QUESTION FOR THE LEAD: may I widen/.test(third.lines[3] ?? '') && third.lines[4] === 'THE REST — 0 line(s):' && router.received.length === 1, third.lines.join(' | '))
check('the state advanced', JSON.stringify(states()) === JSON.stringify({ 'LEAD-W1.md': 7, 'ALPHA.md': 6, 'BETA.md': 5 }), JSON.stringify(states()))

section('§5 a rewritten, shorter file is re-read whole')
writeFileSync(join(COMMS, 'BETA.md'), '# BETA\n\n21:55:00 (BST) — status: rewritten from scratch, one line fixture-id:lead-wake-status\n')
router.reset()
const rewound = await run([COMMS, '--state', STATE])
check('the shorter file is read whole and said so', rewound.lines.some(l => /^  BETA\.md:3 21:55:00 p=0\.12 · status: rewritten/.test(l)) && rewound.lines.includes('re-read whole (shorter than the last wake saw): BETA.md') && router.received.length === 1, rewound.lines.join(' | '))

section('§6 the floor is the seam and --json is the record')
appendFileSync(join(COMMS, 'BETA.md'), '21:58:00 (BST) — scope request: one more field, please fixture-id:lead-wake-scope\n')
router.reset()
const floored = await run([COMMS, '--state', STATE, '--floor', '0.95', '--json'])
const record = (() => {
  try {
    return JSON.parse(floored.lines.at(-1) ?? '') as Record<string, unknown>
  } catch {
    return {}
  }
})()
check('--floor 0.95 flags nothing and --json carries the rest with its probability, the state and no unavailable line', Array.isArray(record.questions) && (record.questions as unknown[]).length === 0 && Array.isArray(record.rest) && (record.rest as Array<{ p: number; file: string }>)[0]?.p === 0.93 && (record.rest as Array<{ file: string }>)[0]?.file === 'BETA.md' && record.unavailable === undefined && (record.state as Record<string, number>)['BETA.md'] === 4, floored.lines.at(-1)?.slice(0, 300))

section('§7 a refusal on one line leaves that line listed unjudged; JEV off lists every line unflagged; the wake never loses a line')
appendFileSync(join(COMMS, 'ALPHA.md'), '2026-09-26 22:01:00 BST — BLOCKED: waiting on the fixture ruling fixture-id:lead-wake-blocked\n')
appendFileSync(join(COMMS, 'BETA.md'), '22:02:00 (BST) — LANDED 9f8e7d6c5, clean worktree fixture-id:lead-wake-landing\n')
router.reset()
router.next(openrouterFailure(402, 'openrouter_credits'))
const refused = await run([COMMS, '--state', STATE])
check('the refused line is listed without a number and the status kind’s words are printed once', refused.rc === 0 && refused.lines.some(l => /^jev unavailable — provider refused for credit — OpenRouter said /.test(l)) && refused.lines.filter(l => / unjudged · /.test(l)).length === 1 && refused.lines.filter(l => / p=0\.\d\d · /.test(l)).length === 1, refused.lines.join(' | '))
appendFileSync(join(COMMS, 'ALPHA.md'), '2026-09-26 22:05:00 BST — QUESTION FOR THE LEAD: which frame size is canonical? fixture-id:lead-wake-question\n')
appendFileSync(join(COMMS, 'BETA.md'), '22:06:00 (BST) — status: idle fixture-id:lead-wake-status\n')
setting.setJevEnabled(false)
router.reset()
const off = await run([COMMS, '--state', STATE])
check('JEV off: no request, the off words once, every new line listed unjudged, exit 0', off.rc === 0 && router.received.length === 0 && off.lines.includes('QUESTIONS (p ≥ 0.80) — none flagged') && off.lines.some(l => /^jev unavailable — off — the JEV switch is off/.test(l)) && off.lines.filter(l => / unjudged · /.test(l)).length === 2, off.lines.join(' | '))
check('the state still advanced', (states() as Record<string, number>)['ALPHA.md'] === 8 && (states() as Record<string, number>)['BETA.md'] === 6, JSON.stringify(states()))
setting.setJevEnabled(true, 'openrouter')

await router.close()
finish()
