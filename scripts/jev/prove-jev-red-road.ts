#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = 'scripts/jev/red-road.ts'
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

section('§0 the road script is on this tree')
check(`the road script exists at ${SCRIPT}`, existsSync(join(ROOT, SCRIPT)), 'no such file on this tree — the chain red road has not landed')
if (failures > 0) finish()

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-red-road-home-')))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'jev-red-road-logs-')))
const TREE = join(SCRATCH, 'tree')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET', 'MERCURY_JEV_BASE', 'MERCURY_OPENROUTER_API_BASE']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const roadModule = (await import('./red-road.ts')) as Record<string, unknown>
const roadQuestions = (roadModule.RED_ROAD_QUESTIONS ?? []) as { id: string; kind: string }[]
check('the road reruns first (rerunProver, waitForLoad) and asks the side noul and the five-way class, not killed?/starved? from the log alone', typeof roadModule.rerunProver === 'function' && typeof roadModule.waitForLoad === 'function' && JSON.stringify(roadQuestions.map(q => [q.id, q.kind])) === JSON.stringify([['real', 'noul'], ['class', 'choice']]), `the road's questions are ${JSON.stringify(roadQuestions.map(q => [q.id, q.kind]))}; rerunProver ${typeof roadModule.rerunProver}`)
check('the road builds the evidence package (redRoadSections, redRoadChecks, redRoadSource, redRoadNeedles, redRoadChanged) and exits one code per class (RED_ROAD_EXITS)', ['redRoadSections', 'redRoadChecks', 'redRoadSource', 'redRoadNeedles', 'redRoadChanged'].every(name => typeof roadModule[name] === 'function') && typeof roadModule.RED_ROAD_EXITS === 'object', 'the package builders are absent: the road sends the log tail and two nouls')
const standinModule = (await import('./lib/jevStandin.ts')) as Record<string, unknown>
check('the stand-in answers the side noul and the five-way choice per fixture (fixtureChoiceAnswerer, RED_ROAD_CHOICE_FIXTURES)', typeof standinModule.fixtureChoiceAnswerer === 'function' && typeof standinModule.RED_ROAD_CHOICE_FIXTURES === 'object', 'the rerun-first road and its five-way stand-in have not landed on this tree')
if (failures > 0) finish()
const { startJevStandin, openrouterFailure, RED_ROAD_CHOICE_FIXTURES, fixtureChoiceAnswerer } = await import('./lib/jevStandin.ts')
const router = await startJevStandin('openrouter')
router.answerWith(fixtureChoiceAnswerer(RED_ROAD_CHOICE_FIXTURES))
process.env.MERCURY_OPENROUTER_API_BASE = `${router.base}/api/v1`
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const OR_KEY = 'proof-openrouter-key-not-real'
secrets.writeStoredOpenrouterApiKey(OR_KEY)
setting.setJevEnabled(true, 'openrouter')

const road = await import('./red-road.ts')

const OLD_WORDS = 'JEV ready — official road'
const NEW_WORDS = 'JEV ready — OpenRouter road'
const PROVER = 'scripts/fx/prove-fixture-stale.ts'
const PROVER_TEXT = [
  '#!/usr/bin/env bun',
  "import { writeFileSync } from 'node:fs'",
  `const EXPECTED = '${OLD_WORDS}'`,
  "const shown = process.env.RED_ROAD_FIXTURE_SHOWN ?? 'JEV ready — OpenRouter road'",
  "if (process.env.RED_ROAD_MARKER) writeFileSync(process.env.RED_ROAD_MARKER, String(Date.now()))",
  "console.log('[PASS] the status line carries the road')",
  "const ok = shown === EXPECTED",
  "console.log(`[${ok ? 'PASS' : 'FAIL'}] the row’s copy is the one exported statusLine${ok ? '' : ` — expected \"${EXPECTED}\" vs \"${shown}\"`}`)",
  "console.log('fixture-id:red-road-stale')",
  "console.log(`${ok ? 2 : 1}/2 checks passed`)",
  'process.exit(ok ? 0 : 1)',
  '',
].join('\n')

function sh(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync(args[0]!, args.slice(1), { cwd: TREE, encoding: 'utf8', env: { ...process.env, ...env } })
  if (result.status !== 0) throw new Error(`${args.join(' ')} → ${result.status}: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}
mkdirSync(join(TREE, 'src'), { recursive: true })
mkdirSync(join(TREE, 'scripts', 'fx'), { recursive: true })
writeFileSync(join(TREE, 'src', 'status.ts'), `export const READY = '${OLD_WORDS}'\nexport const OTHER = 'a row that never changes'\n`)
writeFileSync(join(TREE, PROVER), PROVER_TEXT)
const GIT_ID = { GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@mercury.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@mercury.invalid' }
const DAY = 86_400_000
const dateA = new Date(Date.now() - 3 * DAY).toISOString()
const dateB = new Date(Date.now() - 1 * DAY).toISOString()
sh(['git', 'init', '-q', '-b', 'main'])
sh(['git', 'add', '.'])
sh(['git', 'commit', '-q', '-m', 'the check and the words it reads'], { ...GIT_ID, GIT_AUTHOR_DATE: dateA, GIT_COMMITTER_DATE: dateA })
const shaA = sh(['git', 'rev-parse', '--short', 'HEAD'])
sh(['git', 'tag', 'v0.0.1'])
writeFileSync(join(TREE, 'src', 'status.ts'), `export const READY = '${NEW_WORDS}'\nexport const OTHER = 'a row that never changes'\n`)
sh(['git', 'commit', '-q', '-am', 'the status row names the road'], { ...GIT_ID, GIT_AUTHOR_DATE: dateB, GIT_COMMITTER_DATE: dateB })
const shaB = sh(['git', 'rev-parse', '--short', 'HEAD'])
const dateC = new Date(Date.now() - 1 * DAY + 3_600_000).toISOString()
writeFileSync(join(TREE, PROVER), PROVER_TEXT.replace("import { writeFileSync } from 'node:fs'", "import { writeFileSync as writeFile } from 'node:fs'\nconst writeFileSync = writeFile"))
sh(['git', 'commit', '-q', '-am', 'the prover imports under another name'], { ...GIT_ID, GIT_AUTHOR_DATE: dateC, GIT_COMMITTER_DATE: dateC })
const shaC = sh(['git', 'rev-parse', '--short', 'HEAD'])
writeFileSync(join(TREE, 'scripts', 'fx', 'prove-nul.ts'), "console.log('[FAIL] the nul needle is preserved — no')\ncheck('the nul needle is preserved', shown.includes('bad\u0000needle'))\n")

const LOGS: Record<string, string> = {
  stale: [
    '[PASS] the status line carries the road',
    `[FAIL] the row’s copy is the one exported statusLine — expected "${OLD_WORDS}" vs "${NEW_WORDS}"`,
    'fixture-id:red-road-stale',
    '1/2 checks passed',
  ].join('\n'),
  killed: ['[PASS] the crew table lists the seat', 'capture 178x51 seat-3 frame 12 settled in 410ms', 'Killed: 9', 'fixture-id:red-road-killed'].join('\n'),
  product: ['[PASS] the seat boots', '[FAIL] the doctor row names the key — expected a row, got none', 'fixture-id:red-road-product', '1 of 2 checks failed'].join('\n'),
  unsure: ['[FAIL] the picker stays inside the view — no frame captured', 'fixture-id:red-road-unsure'].join('\n'),
  none: ['[FAIL] the footer reads the model — expected Fable, got nothing', 'fixture-id:red-road-none'].join('\n'),
  split: ['[FAIL] the retired ids are named beneath the OpenAI line — row 20 is the footer', 'fixture-id:red-road-split'].join('\n'),
  hosted: ['error: ENOENT: no such file or directory, mkdtemp \'/private/tmp/mw/prompt-XXXXXX\'', 'fixture-id:red-road-hosted', '      at mkdtempSync (node:fs:1)'].join('\n'),
  suite: [
    '── scripts/fx/prove-green-one.ts',
    '[PASS] fine',
    '── scripts/fx/prove-green-one.ts  3s rc=0',
    '── scripts/fx/prove-fixture-stale.ts',
    '[PASS] the status line carries the road',
    `[FAIL] the row’s copy is the one exported statusLine — expected "${OLD_WORDS}" vs "${NEW_WORDS}"`,
    'fixture-id:red-road-stale',
    '── scripts/fx/prove-fixture-stale.ts  1s rc=1',
    '── scripts/fx/prove-slow-two.ts',
    '[PASS] booted',
    'Killed: 9',
    'fixture-id:red-road-killed',
    '── scripts/fx/prove-slow-two.ts  900s rc=137',
  ].join('\n'),
  green: ['── scripts/fx/prove-green-one.ts', '[PASS] fine', '── scripts/fx/prove-green-one.ts  3s rc=0'].join('\n'),
  tail: ['── scripts/fx/prove-green-one.ts  3s rc=0', '── scripts/fx/prove-hung.ts', '[PASS] booted', 'fixture-id:red-road-killed', '__SUITE_TIMEOUT after 3000s (tree-killed)__'].join('\n'),
}
const logPath = (name: string, ext = '.log'): string => {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `prove-fixture-${name}${ext}`)
  writeFileSync(path, `${LOGS[name]}\n`)
  return path
}

type Run = { rc: number | null; out: string; err: string; line: string }
const BASE_FLAGS = ['--load-ceiling', '100000', '--tree', TREE]
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ['run', SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    child.on('close', code => resolveRun({ rc: code, out, err, line: out.trim().split('\n').pop() ?? '' }))
  })
}
const bodyAt = (index: number): { raw: string; state: Record<string, string>; questions: Record<string, { type?: string; criteria?: Record<string, unknown> }> } => {
  const record = router.received[index]
  const body = (record?.body ?? {}) as Record<string, unknown>
  return { raw: record?.rawBody ?? '', state: (body.state ?? {}) as Record<string, string>, questions: (body.questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, unknown> }> }
}
const parseJson = (line: string): Record<string, unknown> => {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return {}
  }
}
const errWords = (err: string): string => {
  const named = err.split('\n').filter(line => /\b(E[A-Z]{3,}|[A-Za-z]+Error)\b/.test(line)).slice(0, 3).join(' | ')
  return named !== '' ? named : err.slice(0, 300)
}

section('§1 the pure pieces: sections, checks, the source line, the needles, the floor and the severity order')
check('the question set is the side noul `real` then one choice `class` with product, stale, run, hosted and the escape', road.RED_ROAD_QUESTIONS.length === 2 && road.RED_ROAD_REAL_QUESTION.id === 'real' && road.RED_ROAD_REAL_QUESTION.kind === 'noul' && road.RED_ROAD_QUESTION.id === 'class' && road.RED_ROAD_QUESTION.kind === 'choice' && JSON.stringify(Object.keys(road.RED_ROAD_QUESTION.options ?? {})) === JSON.stringify(['product', 'stale', 'run', 'hosted']) && road.RED_ROAD_QUESTION.allow_none === true && typeof road.RED_ROAD_QUESTION.none_means === 'string')
check('the exits are one per class: run 0 · product 1 · stale 2 · hosted 3 · cannot tell 4 · unavailable 5 · usage 6', JSON.stringify(road.RED_ROAD_EXITS) === JSON.stringify({ run: 0, product: 1, stale: 2, hosted: 3, unsure: 4, unavailable: 5, usage: 6 }))
const suiteRun = { rc: 1, secs: 904, hangSecs: null, retry: null }
const sections = road.redRoadSections(LOGS.suite!, 'fx', suiteRun)
check('a suite log splits at its prover marks: three sections, the green one rc=0, the red ones rc=1 and rc=137 with their walls', sections.length === 3 && sections[0]!.rc === 0 && sections[1]!.prover === 'scripts/fx/prove-fixture-stale.ts' && sections[1]!.rc === 1 && sections[1]!.secs === 1 && sections[2]!.rc === 137 && sections[2]!.secs === 900, JSON.stringify(sections.map(s => [s.prover, s.rc, s.secs])))
const tailSections = road.redRoadSections(LOGS.tail!, 'fx', { rc: 137, secs: 3000, hangSecs: 3000, retry: null })
check('a tree-killed suite log names the prover still running at the kill as a killed section', tailSections.length === 2 && tailSections[1]!.prover === 'scripts/fx/prove-hung.ts' && tailSections[1]!.killed && tailSections[1]!.rc === 137, JSON.stringify(tailSections.map(s => [s.prover, s.rc, s.killed])))
const lone = road.redRoadSections(LOGS.product!, 'scripts/fx/prove-lone.ts', { rc: 1, secs: 9, hangSecs: null, retry: null })
check('a single-prover log is one section named by the argument', lone.length === 1 && lone[0]!.prover === 'scripts/fx/prove-lone.ts' && lone[0]!.rc === 1)
const mixed = road.redRoadChecks({ prover: 'x', rc: 1, secs: 1, killed: false, lines: ['  [FAIL] 80x21: the caret sits on New Session — got none', '  [FAIL] 80x14: the caret sits on New Session — got none', '  ✗ the covered frame is intact', 'FAIL  the chat journey ran to its marks — exit 4', '❌ MOTION SUITE RED', '❌ 3 CHECK(S) FAILED', '❌ the strip badge is PAINTED — (no ⚑ row)', 'error: Failed to start server. Is port 25211 in use?', '__SUITE_TIMEOUT after 900s (tree-killed)__'] })
check('the failing checks are read from every shape ([FAIL], ✗, FAIL, a ❌ that is not a summary, error:, the suite timeout) and a size prefix folds into one check with its repeat count', mixed.length === 6 && mixed[0]!.core === 'the caret sits on New Session' && mixed[0]!.repeats === 2 && mixed[1]!.core === 'the covered frame is intact' && mixed[2]!.core === 'the chat journey ran to its marks' && mixed[3]!.core === 'the strip badge is PAINTED' && mixed[4]!.kind === 'threw' && mixed[5]!.kind === 'killed', JSON.stringify(mixed.map(c => [c.core, c.kind, c.repeats])))
const silent = road.redRoadChecks({ prover: 'x', rc: 137, secs: 1, killed: false, lines: ['[PASS] booted', 'Killed: 9'] })
check('a red section with no failing line yields the one synthetic check naming its exit code', silent.length === 1 && silent[0]!.kind === 'silent' && /ended rc=137/.test(silent[0]!.label), JSON.stringify(silent))
const source = road.redRoadSource(mixed[0]!, "check(`${size}: the caret sits on New Session`, rows.some(r => r.includes('❯ New Session')), rows.join('|'))\nconst N = 64\n", 'scripts/fx/prove-x.ts')
check('the check’s source line is found through the core label inside a template literal, with its line number', source.found && source.where === 'scripts/fx/prove-x.ts:1' && source.lines[0]!.startsWith('1: check('), JSON.stringify(source))
const needles = road.redRoadNeedles(source.lines, mixed[0]!.core)
check('the needles are the product words the check reads, never the label itself, never a glyph-only string', JSON.stringify(needles) === JSON.stringify(['❯ New Session']), JSON.stringify(needles))
check('a path-shaped literal and a glyph-only literal are no needles', road.redRoadNeedles(["1: check('x', a === 'scripts/ui/prove-a.ts' && b === '▔▔▔▔' && c === 'the ready hint')"], 'x').join('|') === 'the ready hint')
check('the label candidates run from the whole label down to four-word windows', road.labelCandidates('the drive completed and the face painted its ready hint').includes('the face painted its ready hint') && road.labelCandidates('short').length === 0)
const verdictOf = (choice: string, real: number, probabilities: Record<string, number> = {}) => road.redRoadCheckVerdict({ type: 'choice', choice, probabilities: { product: 0.05, stale: 0.05, run: 0.05, hosted: 0.05, none: 0.05, ...probabilities }, confidence: 0.5 }, real, 0.6, 'x').verdict
check('with a diffuse choice the side noul decides: real ≥ 0.6 names product or stale, real ≤ 0.4 names run or hosted, the band between is CANNOT TELL whatever the choice said', verdictOf('run', 0.1) === 'run' && verdictOf('hosted', 0.4) === 'hosted' && verdictOf('stale', 0.6) === 'stale' && verdictOf('product', 0.95) === 'product' && verdictOf('product', 0.59) === 'unsure' && verdictOf('run', 0.41) === 'unsure' && verdictOf('none', 0.5) === 'unsure' && verdictOf('none', 0.95, { product: 0.3, stale: 0.4 }) === 'stale')
check('the five-way side mass decides first under the same floor (product 0.42 + stale 0.46 is STALE LAW at a noul of 0.5; run 0.85 + hosted 0.05 is RUN at a noul of 0.45); a diffuse choice falls to the noul', verdictOf('stale', 0.5, { product: 0.42, stale: 0.46, run: 0.06, hosted: 0.03 }) === 'stale' && verdictOf('run', 0.45, { product: 0.05, stale: 0.03, run: 0.85, hosted: 0.05 }) === 'run' && verdictOf('product', 0.5, { product: 0.35, stale: 0.2, run: 0.35, hosted: 0.05 }) === 'unsure' && verdictOf('product', 0.9, { product: 0.35, stale: 0.2, run: 0.35, hosted: 0.05 }) === 'product' && road.redRoadSide({ type: 'choice', choice: 'stale', probabilities: { product: 0.25, stale: 0.3, run: 0.35, hosted: 0.1, none: 0 }, confidence: 0.1 }, 0.2, 0.6) === 'flake' && road.redRoadSide({ type: 'choice', choice: 'stale', probabilities: { product: 0.3, stale: 0.3, run: 0.3, hosted: 0.1, none: 0 }, confidence: 0.1 }, 0.2, 0.6) === 'real')
check('a choice on the wrong side of the noul yields to the larger option on the noul’s side; the escape too', verdictOf('run', 0.9, { product: 0.2, stale: 0.35 }) === 'stale' && verdictOf('stale', 0.1, { run: 0.3, hosted: 0.5 }) === 'hosted' && verdictOf('none', 0.05, { run: 0.4 }) === 'run' && road.redRoadCheckVerdict(undefined, 0.9, 0.6, 'x').verdict === 'unsure' && road.redRoadCheckVerdict({ type: 'choice', choice: 'run', probabilities: { run: 1 }, confidence: 1 }, undefined, 0.6, 'x').verdict === 'unsure')
const proverOf = (...verdicts: ('product' | 'stale' | 'run' | 'hosted' | 'unsure')[]) => road.redRoadProverVerdict(verdicts.map(verdict => ({ label: '', verdict, choice: '', p: 0, confidence: 0, probabilities: {} })))
check('a prover reads its worst check: product over stale over cannot tell over hosted over run; no checks is cannot tell', proverOf('run', 'run') === 'run' && proverOf('run', 'hosted') === 'hosted' && proverOf('run', 'unsure') === 'unsure' && proverOf('unsure', 'stale') === 'stale' && proverOf('stale', 'product', 'run') === 'product' && proverOf() === 'unsure')
check('the exit follows the same order', road.redRoadExit(['run', 'run']) === 0 && road.redRoadExit(['run', 'product']) === 1 && road.redRoadExit(['stale']) === 2 && road.redRoadExit(['hosted', 'run']) === 3 && road.redRoadExit(['run', 'unsure']) === 4)
check('the prover command follows the file: bun for .ts, python3 for .py, bash for .sh, a suite name runs its run-all.sh', road.proverCommand('scripts/a/prove-x.ts').slice(1).join(' ') === 'run scripts/a/prove-x.ts' && road.proverCommand('scripts/a/prove-x.py').join(' ') === 'python3 scripts/a/prove-x.py' && road.proverCommand('scripts/a/run-all.sh')[0] === 'bash' && road.proverCommand('ui').join(' ') === 'bash scripts/ui/run-all.sh')
{
  const loads = [30, 25, 4]
  let at = 0
  const paused: number[] = []
  const waited = await road.waitForLoad(10, 900, () => ({ one: loads[Math.min(at++, loads.length - 1)]!, words: 'x' }), async ms => {
    paused.push(ms)
  })
  const never = await road.waitForLoad(10, 20, () => ({ one: 50, words: 'y' }), async () => {})
  check('the rerun waits for the 1-minute load to fall under the ceiling, polling every 10 s, and says so when the wait expires', waited.load.one === 4 && waited.waited === 20 && !waited.expired && paused.length === 2 && never.expired && never.waited === 20, JSON.stringify([waited, never]))
}
check('the road’s home: an explicit --home wins, a pinned scratch is kept, the preload’s proof home yields the operator’s own store', road.roadHome('/x/y', { MERCURY_CONFIG_DIR: HOME }) === '/x/y' && road.roadHome(undefined, { MERCURY_CONFIG_DIR: HOME }) === HOME && road.roadHome(undefined, { MERCURY_CONFIG_DIR: join(tmpdir(), 'mercury-proof-home-abc123') }).endsWith('/.mercury') && road.roadHome(undefined, {}).endsWith('/.mercury'))
check('a results row yields rc, wall and the retry', JSON.stringify(road.parseResultsRow('daemon\tcpu\t137\t1052\t-\t-')) === JSON.stringify({ rc: 137, secs: 1052, retry: null }) && JSON.stringify(road.parseResultsRow('ui-3 pty 1 88 0 40')) === JSON.stringify({ rc: 1, secs: 88, retry: { rc: 0, secs: 40 } }))
check('the signal words', road.signalWords(137) === 'SIGKILL (9)' && road.signalWords(1) === 'no signal' && road.signalWords(null) === 'no signal')

section('§2 no arguments is a usage refusal, exit 6; --rerun-log without --rerun-rc too')
const usage = await run([])
check('exit 6 with a usage line', usage.rc === 6 && /usage: /.test(usage.err + usage.out), `${usage.rc} ${usage.err.slice(0, 120)}`)
const half = await run(['x', logPath('product'), '--rerun-log', logPath('product')])
check('--rerun-log alone is refused, exit 6', half.rc === 6 && /--rerun-log and --rerun-rc go together/.test(half.err), `${half.rc} ${half.err.slice(0, 160)}`)

section('§3 the stale-law road: the prover reruns FIRST in the tree, then one request per failing check carries the six-fact package')
router.reset()
const marker = join(SCRATCH, 'rerun-ran')
const staleLog = logPath('stale')
const stale = await run([PROVER, staleLog, '--rc', '1', '--secs', '1', ...BASE_FLAGS, '--receipt', join(SCRATCH, 'stale', 'stale.red-road.log')], { RED_ROAD_MARKER: marker })
check('the verdict line reads STALE LAW for the prover, exit 2', /^STALE LAW — prove-fixture-stale\.ts STALE LAW → a seat with the log and the package · receipt /.test(stale.line) && stale.rc === 2, `${stale.rc} ${stale.line} ${errWords(stale.err)}`)
check('one check line rides above it with the class, the side probability, the four class probabilities and the confidence', /^\s+check: STALE LAW real=0\.94 \(product 0\.04 · stale 0\.90 · run 0\.03 · hosted 0\.01\) conf=0\.90 — the row’s copy is the one exported statusLine/m.test(stale.out), stale.out.slice(0, 400))
check('the default rerun ran the prover itself in the tree, before the request reached the stand-in', existsSync(marker) && router.received.length === 1 && Number(readFileSync(marker, 'utf8')) <= router.received[0]!.at, `${existsSync(marker)} ${router.received.length}`)
{
  const { raw, state, questions } = bodyAt(0)
  check('the state is the six facts expected, shown, changed, run, load, rerun and nothing else', JSON.stringify(Object.keys(state)) === JSON.stringify(['expected', 'shown', 'changed', 'run', 'load', 'rerun']), JSON.stringify(Object.keys(state)))
  check('the questions are the side noul and the five-way choice: product, stale, run, hosted and none', JSON.stringify(Object.keys(questions)) === JSON.stringify(['real', 'class']) && questions.real?.type === 'noul' && questions.class?.type === 'choice' && JSON.stringify(Object.keys(questions.class?.criteria ?? {})) === JSON.stringify(['product', 'stale', 'run', 'hosted', 'none']), JSON.stringify(questions))
  check('`expected` carries the check’s words and its source line in the prover', /^the check: the row’s copy is the one exported statusLine/.test(state.expected ?? '') && new RegExp(`source: ${PROVER}:9`).test(state.expected ?? '') && /EXPECTED/.test(state.expected ?? ''), state.expected)
  check('`shown` carries the log’s own rows with the failing one marked', /^>> \[FAIL\] the row’s copy/m.test(state.shown ?? '') && /\[PASS\] the status line carries the road/.test(state.shown ?? ''), state.shown)
  check('`changed` pins the check to the commit that last touched ITS line (the blame, not the file’s last commit), names the later product commit on the words it reads and calls it a STALE LAW candidate', new RegExp(`pin was last touched ${shaA} .*\\(the check's own line 9\\)`).test(state.changed ?? '') && !new RegExp(`pin was last touched ${shaC}`).test(state.changed ?? '') && new RegExp(`${shaB} .* the status row names the road`).test(state.changed ?? '') && /AFTER the check's pin \(STALE LAW candidate/.test(state.changed ?? '') && /not in src\//.test(state.changed ?? '') && /tag v0\.0\.1/.test(state.changed ?? ''), state.changed)
  check('`run` carries the exit, the wall, the verdict line and the signature read', /exit code 1 · no signal · wall 1s/.test(state.run ?? '') && /own verdict line present/.test(state.run ?? '') && /this box \(local\)/.test(state.run ?? ''), state.run)
  check('`load` carries the load now and says what the log did not record', /1\/5\/15 now, on the road: [\d.]+ [\d.]+ [\d.]+/.test(state.load ?? '') && /unrecorded/.test(state.load ?? ''), state.load)
  check('`rerun` carries the solo command, rc=1, the load at start and end, and that this same check failed again', /bun run scripts\/fx\/prove-fixture-stale\.ts — alone, in a fresh scratch home/.test(state.rerun ?? '') && /rc=1 \(no signal\) in \d+s/.test(state.rerun ?? '') && /same check again: this same check failed again/.test(state.rerun ?? '') && /1\/5\/15 load at start/.test(state.rerun ?? ''), state.rerun)
  check('the body carries no absolute path at all — not the road’s tree, the scratch tree, the home, the log, the bun binary, nor any /Users, /private, /var/folders or /tmp prefix', !raw.includes(ROOT) && !raw.includes(TREE) && !raw.includes(HOME) && !raw.includes(staleLog) && !/\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\//.test(raw) && /"rerun":"bun run scripts\/fx\/prove-fixture-stale\.ts — alone/.test(raw), raw.slice(0, 300))
  check('the authorization is the stored OpenRouter key on the OpenRouter road', router.received[0]!.headers.authorization === `Bearer ${OR_KEY}` && router.received[0]!.path === '/api/v1/systemone')
}
{
  const receipt = join(SCRATCH, 'stale', 'stale.red-road.log')
  const pkg = join(SCRATCH, 'stale', 'stale.red-road.package.json')
  check('the receipt and the package sit at --receipt: the receipt carries the rerun rc, both loads, the check and prover lines', existsSync(receipt) && (() => {
    const text = readFileSync(receipt, 'utf8')
    return /rerun rc=1 in \d+s · load at start/.test(text) && /same check again: yes/.test(text) && /check: STALE LAW real=0\.94/.test(text) && /^prover: STALE LAW — scripts\/fx\/prove-fixture-stale\.ts rc=1 · 1 check\(s\) · solo rerun rc=1/m.test(text) && /stale-law window: since .*tag v0\.0\.1/.test(text)
  })(), existsSync(receipt) ? readFileSync(receipt, 'utf8').slice(0, 600) : 'no receipt')
  check('the package is JSON with the question and one item of six facts', existsSync(pkg) && (() => {
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { question?: { id?: string }; items?: { id: string; expected?: string }[] }
    return parsed.question?.id === 'class' && parsed.items?.length === 1 && parsed.items[0]!.id === 'c1' && Object.keys(parsed.items[0]!).length === 7
  })(), 'no package')
  check('the rerun’s own output is kept beside the receipt', existsSync(join(SCRATCH, 'stale', 'stale.red-road.prove-fixture-stale.rerun.log')))
}

section('§3c the rerun home follows TMPDIR: a root this box never had is created on demand and used, the child inherits it, and neither the root nor the home reaches the wire')
{
  const pinnedRoot = join(realpathSync(mkdtempSync(join(tmpdir(), 'jev-red-road-tmpdir-'))), 'nested', 'scratch')
  router.reset()
  const marker6 = join(SCRATCH, 'rerun-ran-6')
  const receipt6 = join(SCRATCH, 'stale', 'tmpdir.red-road.log')
  const rerunLog6 = join(SCRATCH, 'stale', 'tmpdir.red-road.prove-fixture-stale.rerun.log')
  const under = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--receipt', receipt6, '--', 'sh', '-c', `echo "HOME_DIR=$MERCURY_CONFIG_DIR TMP_DIR=$TMPDIR"; touch "${marker6}"; exit 1`], { TMPDIR: pinnedRoot })
  const receiptText = existsSync(receipt6) ? readFileSync(receipt6, 'utf8') : ''
  const home = receiptText.match(/; home ([^)\n]+)\)/)?.[1] ?? ''
  const rerunText = existsSync(rerunLog6) ? readFileSync(rerunLog6, 'utf8') : ''
  check('the rerun ran in a fresh home under the pinned TMPDIR, which the road created on demand, and the child saw that TMPDIR', under.rc === 2 && existsSync(marker6) && home.startsWith(`${pinnedRoot}/`) && existsSync(home) && rerunText.includes(`HOME_DIR=${home} TMP_DIR=${pinnedRoot}`), `rc ${under.rc} · home on the receipt: ${home || '(none)'} · pinned root: ${pinnedRoot} · rerun log: ${rerunText.trim().slice(0, 200) || '(none)'} ${errWords(under.err)}`)
  const raw = bodyAt(0).raw
  check('neither the pinned root nor the home under it reaches the wire', raw !== '' && !raw.includes(pinnedRoot) && (home === '' || !raw.includes(home)) && !/\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\//.test(raw), raw.slice(0, 300))
  check('the scratch root is TMPDIR when set, else the platform temp dir; the road pins no box path', typeof road.redRoadScratch === 'function' && road.redRoadScratch({ TMPDIR: '/x/y/' }) === '/x/y' && road.redRoadScratch({}) === resolve(tmpdir()) && road.redRoadScratch({ TMPDIR: '  ' }) === resolve(tmpdir()) && !readFileSync(join(ROOT, SCRIPT), 'utf8').includes("'/private/tmp/mw'"), `redRoadScratch is ${typeof road.redRoadScratch}`)
}

section('§3b the review’s teeth: nothing dropped, nothing green on a red suite, one same-check read per check, no load-expiry rerun, no leaked secret, no orphan, no crash on a control byte')
{
  const many: string[] = []
  for (let n = 1; n <= 47; n++) many.push(`[FAIL] check number ${n} reads its row`, 'fixture-id:red-road-killed')
  many.push('[FAIL] check number 48 reads its row', 'fixture-id:red-road-product', '[FAIL] check number 49 reads its row', '[FAIL] check number 50 reads its row')
  LOGS.many = many.join('\n')
  const checks = road.redRoadChecks({ prover: 'x', rc: 1, secs: 1, killed: false, lines: many })
  check(`fifty failing checks read as ${road.RED_ROAD_CHECK_LIMIT} items, the last one carrying the three beyond the cap by name`, checks.length === road.RED_ROAD_CHECK_LIMIT && checks[checks.length - 1]!.kind === 'overflow' && checks[checks.length - 1]!.repeats === 3 && /3 more failing checks in this prover, read together: check number 48 reads its row \| check number 49/.test(checks[checks.length - 1]!.label), JSON.stringify(checks.at(-1)))
  router.reset()
  const manyRun = await run(['scripts/fx/prove-fixture-many.ts', logPath('many'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
  check('end to end: 47 RUN items and one overflow item reading PRODUCT DEFECT make the prover PRODUCT DEFECT, exit 1 — the cap drops nothing', manyRun.rc === 1 && router.received.length === road.RED_ROAD_CHECK_LIMIT && /^PRODUCT DEFECT — prove-fixture-many\.ts PRODUCT DEFECT/.test(manyRun.line), `${manyRun.rc} ${router.received.length} ${manyRun.line}`)
}
{
  LOGS.tailred = ['── scripts/fx/prove-green-one.ts  3s rc=0', '[FAIL] product is broken after the last mark', 'fixture-id:red-road-product'].join('\n')
  LOGS.ansi = ['\x1b[1m[FAIL] the painted row\x1b[0m', 'fixture-id:red-road-product', '\x1b[31m── scripts/fx/prove-painted.ts  2s rc=1\x1b[0m'].join('\n')
  const tailSections2 = road.redRoadSections(LOGS.tailred, 'fx', { rc: 1, secs: 3, hangSecs: null, retry: null })
  check('a red suite whose failure sits after its last (green) prover mark keeps that tail as a red section named the suite’s own', tailSections2.length === 2 && tailSections2[1]!.rc === 1 && /the suite's own tail/.test(tailSections2[1]!.prover), JSON.stringify(tailSections2.map(s => [s.prover, s.rc])))
  const ansiSections = road.redRoadSections(LOGS.ansi, 'fx', { rc: 1, secs: 2, hangSecs: null, retry: null })
  check('ANSI colour around a prover mark is stripped before the mark is read', ansiSections.length === 1 && ansiSections[0]!.prover === 'scripts/fx/prove-painted.ts' && ansiSections[0]!.rc === 1 && road.redRoadChecks(ansiSections[0]!)[0]!.core === 'the painted row', JSON.stringify(ansiSections.map(s => [s.prover, s.rc])))
  router.reset()
  const tailRun = await run(['fx', logPath('tailred', '.out'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
  check('end to end: that suite reads PRODUCT DEFECT, exit 1, never GREEN', tailRun.rc === 1 && router.received.length === 1 && /^PRODUCT DEFECT — /.test(tailRun.line), `${tailRun.rc} ${tailRun.line}`)
  const greenStill = await run(['fx', logPath('green', '.out'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
  check('a red suite rc with every mark green and no failing line still yields the synthetic check, not GREEN', greenStill.rc !== 0 && !/^GREEN/.test(greenStill.line), `${greenStill.rc} ${greenStill.line}`)
}
{
  LOGS.pair = ['[FAIL] alpha reads the row — no', 'fixture-id:red-road-product', '[FAIL] beta reads the row — no', 'fixture-id:red-road-product'].join('\n')
  const pairLog = logPath('pair')
  const soloLog = join(SCRATCH, 'pair', 'solo.log')
  writeFileSync(soloLog, '[FAIL] alpha reads the row — again\n1/2 checks passed\n')
  router.reset()
  await run(['scripts/fx/prove-fixture-pair.ts', pairLog, '--rc', '1', ...BASE_FLAGS, '--rerun-log', soloLog, '--rerun-rc', '1'])
  const alpha = bodyAt(0).state.rerun ?? ''
  const beta = bodyAt(1).state.rerun ?? ''
  check('the same-check read is per check: alpha says this same check failed again, beta says not this check and names alpha', /same check again: this same check failed again \(alpha reads the row/.test(alpha) && /same check again: not this check; the rerun failed 1 other check\(s\): alpha reads the row/.test(beta), `${alpha}\n---\n${beta}`)
}
{
  router.reset()
  const marker5 = join(SCRATCH, 'rerun-ran-5')
  const starved = await run([PROVER, staleLog, '--rc', '1', '--tree', TREE, '--load-ceiling', '0', '--load-wait', '0', '--', 'touch', marker5])
  check('when the 1-minute load never falls under the ceiling nothing reruns: the fact says so, the receipt says so, the prover line says so', !existsSync(marker5) && /not rerun: the 1-minute load stayed above 0 for 0s/.test(bodyAt(0).state.rerun ?? '') && /no rerun \(the load never fell under the ceiling\)/.test(starved.out) && /rerun: not run — the 1-minute load stayed above 0/.test(readFileSync(join(SCRATCH, 'stale', 'prove-fixture-stale.red-road.log'), 'utf8')), `${starved.rc} ${bodyAt(0).state.rerun}\n${starved.out}`)
}
{
  const scrubbed = road.scrubbedEnv({ OPENAI_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', GOOGLE_API_KEY: 'g', MOONSHOT_ACCESS_TOKEN: 't', MERCURY_API_UNIX_SOCKET: '/s', GH_TOKEN: 'gh', HTTPS_PROXY: 'p', HOME: '/h', PATH: '/bin', TERM: 'xterm' })
  check('the rerun’s environment carries no credential spelling and no transport override', JSON.stringify(Object.keys(scrubbed).sort()) === JSON.stringify(['HOME', 'PATH', 'TERM']), JSON.stringify(scrubbed))
  router.reset()
  const leak = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--', 'sh', '-c', 'echo "K=${OPENAI_API_KEY:-none} S=${MERCURY_API_UNIX_SOCKET:-none} T=${TYPESAFE_API_KEY:-none} A=${ANTHROPIC_API_KEY:-none}"; exit 1'], { OPENAI_API_KEY: 'review-fake-openai', MERCURY_API_UNIX_SOCKET: '/private/tmp/fake.sock', TYPESAFE_API_KEY: 'review-fake-typesafe' })
  check('end to end: the child sees none of them and the proof key stands in for the one it needs', /K=none S=none T=none A=proof-key-ci-gate-not-a-real-key/.test(bodyAt(0).state.rerun ?? ''), `${leak.rc} ${bodyAt(0).state.rerun}`)
}
{
  router.reset()
  const orphan = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--', 'sh', '-c', 'sleep 30 </dev/null >/dev/null 2>&1 & echo "ORPHAN_PID=$!"; exit 1'])
  const pid = Number((bodyAt(0).state.rerun ?? '').match(/ORPHAN_PID=(\d+)/)?.[1] ?? '0')
  const alive = (() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })()
  check('a descendant the prover left behind is gone once the road returns (the process group is closed on every exit)', pid > 0 && !alive && orphan.rc === 2, `pid ${pid} alive ${alive} rc ${orphan.rc}`)
}
{
  check('a needle with a control byte, a leading dash or no body never reaches git', !road.safeNeedle('bad\u0000needle') && !road.safeNeedle('-rf') && !road.safeNeedle('') && road.safeNeedle('JEV ready — official road'))
  LOGS.nul = ['[FAIL] the nul needle is preserved — no', 'fixture-id:red-road-product'].join('\n')
  router.reset()
  const nul = await run(['scripts/fx/prove-nul.ts', logPath('nul'), '--rc', '1', ...BASE_FLAGS, '--no-rerun', '--json'])
  const nulParsed = parseJson(nul.line)
  check('a prover whose literal carries a NUL byte still yields a verdict (the needle is skipped), never a crash', nulParsed.verdict === 'product' && nul.rc === 1 && /no product needle could be read|→/.test(String(((nulParsed.provers as { checks: unknown[] }[] | undefined)?.length ?? 0) > 0 ? 'ok →' : '')), `${nul.rc} ${nul.line.slice(0, 200)} ${nul.err.slice(0, 200)}`)
}
{
  LOGS.paths = ['[FAIL] the frame lists the home — /Users/someone/private-project/x and /private/tmp/mw/drive-abc/frame.txt and /var/folders/ab/cd12/T/proof-home-xyz', 'fixture-id:red-road-product'].join('\n')
  router.reset()
  await run(['scripts/fx/prove-fixture-paths.ts', logPath('paths'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
  const raw = bodyAt(0).raw
  check('absolute paths inside the log’s own rows are redacted on the wire (~, <scratch>, <tmp>) and kept whole in the package on disk', !/\/Users\/|\/private\/|\/var\/folders\//.test(raw) && /~\/private-project\/x/.test(raw) && /<scratch>\/drive-abc\/frame\.txt/.test(raw) && /<tmp>\/proof-home-xyz/.test(raw) && readFileSync(join(SCRATCH, 'paths', 'prove-fixture-paths.red-road.package.json'), 'utf8').includes('/Users/someone/private-project/x'), raw.slice(0, 400))
}

section('§4 the run class: a killed log whose solo rerun goes green closes as the run, exit 0')
router.reset()
const marker2 = join(SCRATCH, 'rerun-ran-2')
const killedLog = logPath('killed')
const killed = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--secs', '1052', ...BASE_FLAGS, '--', 'touch', marker2])
check('the verdict line reads RUN → closed as the run, not the tree, exit 0', /^RUN — prove-fixture-killed\.ts RUN → closed as the run, not the tree · receipt /.test(killed.line) && killed.rc === 0 && existsSync(marker2), `${killed.rc} ${killed.line} ${killed.err.slice(0, 300)}`)
{
  const { state } = bodyAt(0)
  check('a silent kill is the one synthetic check; `run` names SIGKILL and the missing verdict line; `rerun` says green', /ended rc=137 with no failing check line/.test(state.expected ?? '') && /exit code 137 · SIGKILL \(9\)/.test(state.run ?? '') && /own verdict line absent/.test(state.run ?? '') && /Killed: 9/.test(state.run ?? '') && /rc=0 \(no signal\)/.test(state.rerun ?? '') && /green: no check failed/.test(state.rerun ?? ''), `${state.expected}\n${state.run}\n${state.rerun}`)
  check('the source fact says there is no check line to find', /no check line to find \(silent\)/.test(state.expected ?? ''), state.expected)
}
check('the receipt beside the log carries the rerun and the closing', existsSync(join(SCRATCH, 'killed', 'prove-fixture-killed.red-road.log')) && /touch .* rc=0|rerun rc=0/.test(readFileSync(join(SCRATCH, 'killed', 'prove-fixture-killed.red-road.log'), 'utf8')))

section('§5 a product red whose rerun stays red is PRODUCT DEFECT, exit 1; an answer under the floor is CANNOT TELL, exit 4; the escape too')
router.reset()
const product = await run(['scripts/fx/prove-fixture-product.ts', logPath('product'), '--rc', '1', ...BASE_FLAGS, '--', 'false'])
check('PRODUCT DEFECT, exit 1, the rerun rc=1 on the line', /^PRODUCT DEFECT — prove-fixture-product\.ts PRODUCT DEFECT → a seat with the log and the package/.test(product.line) && product.rc === 1 && /solo rerun rc=1/.test(product.out), `${product.rc} ${product.line}`)
check('the prover source is named absent from the tree in `expected`', /prove-fixture-product\.ts is not on this tree/.test(bodyAt(0).state.expected ?? ''), bodyAt(0).state.expected)
router.reset()
const unsure = await run(['scripts/fx/prove-fixture-unsure.ts', logPath('unsure'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
check('CANNOT TELL (run) real=0.50, exit 4', /^CANNOT TELL — prove-fixture-unsure\.ts CANNOT TELL → a seat with the log/.test(unsure.line) && unsure.rc === 4 && /check: CANNOT TELL \(run\) real=0\.50 \(product 0\.30 · stale 0\.20 · run 0\.35 · hosted 0\.05\) conf=0\.40/.test(unsure.out), `${unsure.rc} ${unsure.line}\n${unsure.out}`)
router.reset()
const none = await run(['scripts/fx/prove-fixture-none.ts', logPath('none'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
check('the escape option with the side noul in its band reads CANNOT TELL (none), exit 4', none.rc === 4 && /check: CANNOT TELL \(none\) real=0\.45/.test(none.out), `${none.rc} ${none.out}`)
router.reset()
const splitLog = logPath('split')
const split = await run(['scripts/fx/prove-fixture-split.ts', splitLog, '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
check('a real side at 0.91 split between product 0.42 and stale 0.50 (choice conf 0.30) is STALE LAW, exit 2 — the side decides, the split only names the class', split.rc === 2 && /check: STALE LAW real=0\.91 \(product 0\.42 · stale 0\.50 · run 0\.04 · hosted 0\.02\) conf=0\.30/.test(split.out), `${split.rc} ${split.out}`)
router.reset()
const floored = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--no-rerun', '--floor', '0.95'])
check('--floor 0.95 turns the real=0.94 stale answer (side mass 0.94) into CANNOT TELL, exit 4', floored.rc === 4 && /check: CANNOT TELL \(stale\) real=0\.94/.test(floored.out), `${floored.rc} ${floored.out}`)

section('§6 --hosted marks the log as the hosted runner’s; a hosted answer is HOSTED-ONLY, exit 3')
router.reset()
const hosted = await run(['scripts/prompt-input/prove-fixture-hosted.ts', logPath('hosted'), '--rc', '1', '--hosted', ...BASE_FLAGS, '--', 'true'])
check('HOSTED-ONLY, exit 3', /^HOSTED-ONLY — prove-fixture-hosted\.ts HOSTED-ONLY/.test(hosted.line) && hosted.rc === 3, `${hosted.rc} ${hosted.line}`)
check('`run` says the log is the hosted runner’s and the rerun is on this box; the thrown error is the check', /the hosted Linux runner/.test(bodyAt(0).state.run ?? '') && /the prover threw before its checks: the prover threw: ENOENT/.test(bodyAt(0).state.expected ?? ''), `${bodyAt(0).state.run}\n${bodyAt(0).state.expected}`)

section('§7 --no-rerun is a dry pass; --rerun-log/--rerun-rc stand in for the caller’s own solo run')
router.reset()
const marker3 = join(SCRATCH, 'rerun-ran-3')
const dry = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--no-rerun', '--', 'touch', marker3])
check('nothing reran; `rerun` says a dry pass; the prover line says no rerun', !existsSync(marker3) && /not rerun \(a dry pass: --no-rerun\)/.test(bodyAt(0).state.rerun ?? '') && /· no rerun$/m.test(dry.out), dry.out)
router.reset()
const supplied = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--rerun-log', staleLog, '--rerun-rc', '1', '--', 'touch', marker3])
check('the supplied rerun rides the package with its rc and the same-check read, and says its home and load are the caller’s; nothing reran', !existsSync(marker3) && /the caller's own rerun \(its home and load are the caller's, not measured here\)/.test(bodyAt(0).state.rerun ?? '') && /rc=1 \(no signal\)/.test(bodyAt(0).state.rerun ?? '') && /this same check failed again/.test(bodyAt(0).state.rerun ?? '') && supplied.rc === 2, `${supplied.rc} ${bodyAt(0).state.rerun}`)
router.reset()
const cache = join(SCRATCH, 'cache')
mkdirSync(cache)
await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--rerun-cache', cache, '--', 'touch', marker3])
const firstAt = existsSync(marker3) ? Number(readFileSync(marker3, 'utf8') || '0') : -1
const cachedRun = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--rerun-cache', cache, '--', 'false'])
const cacheKey = sh(['git', 'rev-parse', '--short=9', 'HEAD'])
check('--rerun-cache keeps the first rerun beside its JSON, keyed by the prover and the tree’s commit, and a second pass reads it instead of rerunning', firstAt >= 0 && existsSync(join(cache, `prove-fixture-stale.${cacheKey}.rerun.json`)) && existsSync(join(cache, `prove-fixture-stale.${cacheKey}.rerun.log`)) && cachedRun.rc === 2 && /kept from an earlier pass/.test(readFileSync(join(SCRATCH, 'stale', 'prove-fixture-stale.red-road.log'), 'utf8')), `${cachedRun.rc} ${cachedRun.line} ${cacheKey}`)

section('§8 --json prints one JSON line with the verdict, the exit, every prover and check with its numbers, the model and the tokens')
router.reset()
const json = await run([PROVER, staleLog, '--rc', '1', ...BASE_FLAGS, '--no-rerun', '--json'])
const parsed = parseJson(json.line)
const provers = (parsed.provers ?? []) as { prover: string; verdict: string; rerun: unknown; checks: { verdict: string; p: number; confidence: number; probabilities: Record<string, number> }[] }[]
check('one JSON line: verdict stale, exit 2, rc 1, the prover with its check real=0.94 conf=0.9 and the probabilities', parsed.verdict === 'stale' && parsed.exit === 2 && parsed.rc === 1 && provers.length === 1 && provers[0]!.verdict === 'stale' && provers[0]!.rerun === 'skipped' && provers[0]!.checks[0]!.p === 0.94 && provers[0]!.checks[0]!.confidence === 0.9 && provers[0]!.checks[0]!.probabilities.stale === 0.9, json.line.slice(0, 300))
check('the JSON names the model that answered, the tokens, the receipt and the package', typeof parsed.model === 'string' && (parsed.model as string).startsWith('typesafe/jev') && typeof parsed.inputTokens === 'number' && typeof parsed.receipt === 'string' && typeof parsed.package === 'string', json.line.slice(0, 300))

section('§9 a suite log with two red provers: one request per failing check, one verdict per prover, the worst verdict names the suite; the sidecars stand in for the row')
router.reset()
const suiteLog = logPath('suite', '.out')
writeFileSync(join(SCRATCH, 'suite', 'prove-fixture-suite.rc'), '1\n')
writeFileSync(join(SCRATCH, 'suite', 'prove-fixture-suite.secs'), '904\n')
writeFileSync(join(SCRATCH, 'suite', 'prove-fixture-suite.hang'), '900\n')
const suite = await run(['fx', suiteLog, ...BASE_FLAGS, '--no-rerun', '--json'])
const suiteParsed = parseJson(suite.line)
const suiteProvers = (suiteParsed.provers ?? []) as { prover: string; verdict: string; rc: number }[]
check('two red provers, two requests, the stale one and the killed one, the suite reads STALE LAW (the worst), exit 2', router.received.length === 2 && suiteProvers.length === 2 && suiteProvers[0]!.prover === 'scripts/fx/prove-fixture-stale.ts' && suiteProvers[0]!.verdict === 'stale' && suiteProvers[1]!.prover === 'scripts/fx/prove-slow-two.ts' && suiteProvers[1]!.verdict === 'run' && suiteParsed.verdict === 'stale' && suite.rc === 2, suite.line.slice(0, 400))
check('rc, wall and the hang sidecar are read from beside the log', suiteParsed.rc === 1 && suiteParsed.secs === 904 && suiteParsed.hangSecs === 900, suite.line.slice(0, 200))
check('the line names both provers with their classes', /^STALE LAW — prove-fixture-stale\.ts STALE LAW · prove-slow-two\.ts RUN → a seat/.test(String(suiteParsed.line)), String(suiteParsed.line))
router.reset()
const green = await run(['fx', logPath('green', '.out'), '--rc', '0', ...BASE_FLAGS])
check('a log whose every prover mark reads rc=0 is GREEN, exit 0, and nothing is asked', /^GREEN — no red prover/.test(green.line) && green.rc === 0 && router.received.length === 0, `${green.rc} ${green.line}`)

section('§9b the stale-law grep is the same whichever prover came first: the cache keeps history, not another prover’s pin comparison')
{
  writeFileSync(join(TREE, 'scripts', 'fx', 'prove-other.ts'), `console.log('[FAIL] the other prover reads the same words — no')\ncheck('the other prover reads the same words', shown === '${OLD_WORDS}')\n`)
  const dateD = new Date(Date.now() - 3_600_000).toISOString()
  sh(['git', 'add', 'scripts/fx/prove-other.ts'])
  sh(['git', 'commit', '-q', '-m', 'another prover reads the same words'], { ...GIT_ID, GIT_AUTHOR_DATE: dateD, GIT_COMMITTER_DATE: dateD })
  LOGS.order = ['── scripts/fx/prove-other.ts', '[FAIL] the other prover reads the same words — no', 'fixture-id:red-road-stale', '── scripts/fx/prove-other.ts  1s rc=1', '── scripts/fx/prove-fixture-stale.ts', '[PASS] the status line carries the road', `[FAIL] the row’s copy is the one exported statusLine — expected "${OLD_WORDS}" vs "${NEW_WORDS}"`, 'fixture-id:red-road-stale', '── scripts/fx/prove-fixture-stale.ts  1s rc=1'].join('\n')
  router.reset()
  await run(['fx', logPath('order', '.out'), '--rc', '1', ...BASE_FLAGS, '--no-rerun'])
  const other = bodyAt(0).state.changed ?? ''
  const stale2 = bodyAt(1).state.changed ?? ''
  check('the other prover (pinned after the product change) reads none after its pin; the stale prover, asked second with the same needle, still reads the product commit AFTER its own pin', /none after the check's pin/.test(other) && new RegExp(`vs pin ${shaA}`).test(other) === false && new RegExp(`1 AFTER the check's pin \\(STALE LAW candidate: ${shaB} vs pin ${shaA}\\)`).test(stale2), `${other}\n---\n${stale2}`)
}

section('§10 a refusal, a pace line or a switched-off JEV is UNAVAILABLE (exit 5) with the status kind’s words; the rerun still ran first and is on the receipt')
router.reset()
router.next(openrouterFailure(402, 'openrouter_credits'))
const marker4 = join(SCRATCH, 'rerun-ran-4')
const credit = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', ...BASE_FLAGS, '--', 'touch', marker4])
check('a 402 for credit reads UNAVAILABLE — provider refused for credit …, exit 5', /^UNAVAILABLE — provider refused for credit — OpenRouter said /.test(credit.line) && credit.rc === 5, `${credit.rc} ${credit.line} ${credit.err.slice(0, 200)}`)
check('the rerun ran first anyway and its rc is on the receipt', existsSync(marker4) && /rerun rc=0 in \d+s/.test(readFileSync(join(SCRATCH, 'killed', 'prove-fixture-killed.red-road.log'), 'utf8')))
router.reset()
router.next({ status: 429, body: { error: { message: 'Too Many Requests' } }, headers: { 'retry-after': '3' } })
const paced = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', ...BASE_FLAGS, '--no-rerun'])
check('a 429 reads UNAVAILABLE — rate limited by the provider …, exit 5', /^UNAVAILABLE — rate limited by the provider — 429 at /.test(paced.line) && paced.rc === 5, `${paced.rc} ${paced.line}`)
router.reset()
setting.setJevEnabled(false)
const off = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', ...BASE_FLAGS, '--no-rerun'])
check('JEV off in the store reads UNAVAILABLE — off — … and sends nothing', /^UNAVAILABLE — off — the JEV switch is off/.test(off.line) && off.rc === 5 && router.received.length === 0, `${off.rc} ${off.line}`)
setting.setJevEnabled(true, 'openrouter')

await router.close()
finish()
