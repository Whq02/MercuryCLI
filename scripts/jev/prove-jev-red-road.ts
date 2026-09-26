#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET', 'MERCURY_JEV_BASE', 'MERCURY_OPENROUTER_API_BASE']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { startJevStandin, openrouterFailure, RED_ROAD_FIXTURES, fixtureAnswerer } = await import('./lib/jevStandin.ts')
const router = await startJevStandin('openrouter')
router.answerWith(fixtureAnswerer(RED_ROAD_FIXTURES))
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

const LOGS: Record<string, string> = {
  killed: [
    '[PASS] the crew table lists the seat',
    '[PASS] a landing row keeps its sha',
    'capture 178x51 seat-3 frame 12 settled in 410ms',
    '[PASS] the picker paints inside the view',
    'Killed: 9',
    'fixture-id:red-road-killed',
  ].join('\n'),
  starved: [
    'seat-2 send 4/9 due at 3.2s',
    'UNDELIVERED-SENDS 5 of 9 (first stuck: "/model" at 3.2s)',
    'capture deadline exceeded after 45s: the screen never settled within the ceiling',
    'frames: 0 · last frame EMPTY · exit=null',
    '[FAIL] the picker popup stays inside the view — no frame captured',
    'fixture-id:red-road-starved',
    '1 of 12 checks failed',
  ].join('\n'),
  product: [
    '[PASS] the status line carries the road',
    '[FAIL] the row’s copy is the one exported statusLine — expected "JEV ready — OpenRouter road" vs "JEV ready — official road"',
    'fixture-id:red-road-product',
    '11/12 checks passed',
  ].join('\n'),
  unsure: [
    '[PASS] the seat boots',
    'error: connect ECONNREFUSED 127.0.0.1:1',
    '[FAIL] the doctor row names the key — expected a row, got none',
    'fixture-id:red-road-unsure',
  ].join('\n'),
}
const logPath = (name: string, ext = '.log'): string => {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `prove-fixture-${name}${ext}`)
  writeFileSync(path, `${LOGS[name]}\n`)
  return path
}

type Run = { rc: number | null; out: string; err: string; line: string }
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
const lastBody = (): { raw: string; body: Record<string, unknown> } => {
  const record = router.received.at(-1)
  return { raw: record?.rawBody ?? '', body: (record?.body ?? {}) as Record<string, unknown> }
}

section('§1 the pure pieces: the evidence is the log’s own words and numbers; the verdict follows the floors')
const evidence = road.redRoadEvidence(LOGS.killed!, { rc: 137, secs: 1052, hangSecs: null, retry: null })
check('the evidence has exactly the three keys run, tail, signatures', JSON.stringify(Object.keys(evidence)) === JSON.stringify(['run', 'tail', 'signatures']))
check('the run line names the exit code, the signal and the wall', /exit code 137/.test(evidence.run) && /SIGKILL/.test(evidence.run) && /1052s/.test(evidence.run), evidence.run)
check('the run line says no verdict line closed the log', /own verdict line absent/.test(evidence.run), evidence.run)
check('the tail is the log’s last lines verbatim', evidence.tail.endsWith('Killed: 9\nfixture-id:red-road-killed'))
check('the kill signature is matched', /Killed: 9/.test(evidence.signatures) && !/\[PASS\]/.test(evidence.signatures), evidence.signatures)
const starvedEvidence = road.redRoadEvidence(LOGS.starved!, { rc: 1, secs: 61, hangSecs: null, retry: null })
check('the starvation signatures are matched', /UNDELIVERED-SENDS/.test(starvedEvidence.signatures) && /capture deadline exceeded/.test(starvedEvidence.signatures) && /exit=null/.test(starvedEvidence.signatures), starvedEvidence.signatures)
check('a rc 1 run names no signal and its own verdict line', /exit code 1 · no signal/.test(starvedEvidence.run) && /own verdict line present/.test(starvedEvidence.run), starvedEvidence.run)
const hung = road.redRoadEvidence('__SUITE_TIMEOUT after 900s (tree-killed; the 900s suite ceiling — the hang law)__', { rc: 137, secs: 900, hangSecs: 900, retry: null })
check('the harness’s own tree-kill sidecar and timeout line are named', /tree-kill sidecar present \(900s\)/.test(hung.run) && /__SUITE_TIMEOUT/.test(hung.signatures), hung.run)
const longTail = road.redRoadEvidence(Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(400)}`).join('\n'), { rc: 1, secs: 1, hangSecs: null, retry: null })
check(`the tail keeps the last ${road.RED_ROAD_TAIL_LINES} lines, each clipped to ${road.RED_ROAD_LINE_CLIP} characters`, longTail.tail.split('\n').length === road.RED_ROAD_TAIL_LINES && longTail.tail.split('\n').every(l => l.length <= road.RED_ROAD_LINE_CLIP) && longTail.tail.startsWith('line 140 '))
check('the question set is exactly the two nouls killed and starved', JSON.stringify(road.RED_ROAD_QUESTIONS.map(q => [q.id, q.kind])) === JSON.stringify([['killed', 'noul'], ['starved', 'noul']]))
check('the floors are the study’s: yes at 0.6, real at killed ≤ 0.06 and starved ≤ 0.09', road.RED_ROAD_CONFIDENT_FLOOR === 0.6 && road.RED_ROAD_KILLED_REAL_CEILING === 0.06 && road.RED_ROAD_STARVED_REAL_CEILING === 0.09)
const verdict = (killed: number, starved: number, floor?: number) => road.redRoadVerdict({ killed, starved }, floor)
check('a confident kill is KILLED', verdict(0.92, 0.2) === 'KILLED')
check('a confident starvation is STARVED', verdict(0.12, 0.73) === 'STARVED')
check('both confident: the larger wins, a tie goes to KILLED', verdict(0.7, 0.9) === 'STARVED' && verdict(0.8, 0.8) === 'KILLED')
check('both at or under the real ceilings is REAL', verdict(0.06, 0.09) === 'REAL' && verdict(0.03, 0.05) === 'REAL')
check('between the ceilings and the floor is UNSURE', verdict(0.31, 0.22) === 'UNSURE' && verdict(0.07, 0.01) === 'UNSURE' && verdict(0.59, 0.0) === 'UNSURE')
check('the floor is the seam: at 0.95 the 0.92 kill is UNSURE', verdict(0.92, 0.2, 0.95) === 'UNSURE')
check('the road’s home: an explicit --home wins, a pinned scratch is kept, the preload’s proof home yields the operator’s own store', road.roadHome('/x/y', { MERCURY_CONFIG_DIR: HOME }) === '/x/y' && road.roadHome(undefined, { MERCURY_CONFIG_DIR: HOME }) === HOME && road.roadHome(undefined, { MERCURY_CONFIG_DIR: join(tmpdir(), 'mercury-proof-home-abc123') }).endsWith('/.mercury') && road.roadHome(undefined, {}).endsWith('/.mercury'))
check('a results row yields rc, wall and the retry', JSON.stringify(road.parseResultsRow('daemon\tcpu\t137\t1052\t-\t-')) === JSON.stringify({ rc: 137, secs: 1052, retry: null }) && JSON.stringify(road.parseResultsRow('ui-3 pty 1 88 0 40')) === JSON.stringify({ rc: 1, secs: 88, retry: { rc: 0, secs: 40 } }))

section('§2 no arguments is a usage refusal, exit 4')
const usage = await run([])
check('exit 4 with a usage line', usage.rc === 4 && /usage: /.test(usage.err + usage.out), `${usage.rc} ${usage.err.slice(0, 120)}`)

section('§3 a killed log: KILLED, one request holding only the log’s words, exit 0 without a rerun')
router.reset()
const killedLog = logPath('killed')
const killed = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--secs', '1052', '--no-rerun'])
check('the verdict line is KILLED p=0.92 · starved 0.20 · rerun skipped', killed.line === 'KILLED p=0.92 · starved 0.20 · rerun skipped', `${killed.rc} ${killed.line} ${killed.err.slice(0, 200)}`)
check('exit 0', killed.rc === 0)
check('exactly one request reached the stand-in, on the OpenRouter road', router.received.length === 1 && router.received[0]!.path === '/api/v1/systemone', String(router.received.length))
{
  const { raw, body } = lastBody()
  const state = (body.state ?? {}) as Record<string, unknown>
  const questions = (body.questions ?? {}) as Record<string, { type?: string }>
  check('the model pin and the deny/no-fallback provider block ride the body', body.model === 'typesafe/jev-1.13' && JSON.stringify(body.provider) === JSON.stringify({ data_collection: 'deny', allow_fallbacks: false }))
  check('the state is run, tail, signatures and nothing else', JSON.stringify(Object.keys(state)) === JSON.stringify(['run', 'tail', 'signatures']), JSON.stringify(Object.keys(state)))
  check('exactly two questions, both nouls, killed and starved', JSON.stringify(Object.keys(questions)) === JSON.stringify(['killed', 'starved']) && questions.killed?.type === 'noul' && questions.starved?.type === 'noul')
  check('the body carries no path — not the tree, not src/, not scripts/, not the log’s path, not the prover’s name', !raw.includes(ROOT) && !raw.includes('src/') && !raw.includes('scripts/') && !raw.includes(SCRATCH) && !raw.includes('prove-fixture-killed'), raw.slice(0, 200))
  check('the authorization is the stored OpenRouter key', router.received[0]!.headers.authorization === `Bearer ${OR_KEY}`)
}

section('§4 a killed log with the solo rerun: green closes it as base-red/killed with a receipt; red is a real red')
router.reset()
const marker = join(SCRATCH, 'rerun-ran')
const cleared = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--secs', '1052', '--tree', SCRATCH, '--', 'touch', marker])
const receipt = join(SCRATCH, 'killed', 'prove-fixture-killed.red-road.log')
check('the rerun command ran once in the tree given', existsSync(marker))
check('the verdict line names the solo rc 0 and the closing', /^KILLED p=0\.92 · starved 0\.20 · solo rerun rc=0 in \d+s → base-red\/killed · receipt /.test(cleared.line), `${cleared.rc} ${cleared.line} ${cleared.err.slice(0, 200)}`)
check('exit 0', cleared.rc === 0)
check('the receipt sits beside the log and carries the verdict, both uptime readings, the command and the rc', existsSync(receipt) && (() => {
  const text = readFileSync(receipt, 'utf8')
  return /verdict: KILLED p=0\.92 · starved 0\.20/.test(text) && /uptime before: /.test(text) && /uptime after: /.test(text) && /rerun: touch /.test(text) && /rerun rc=0 in \d+s/.test(text) && /closed: base-red\/killed/.test(text)
})(), existsSync(receipt) ? readFileSync(receipt, 'utf8').slice(0, 300) : 'no receipt')
check('the rerun’s own output is kept beside the receipt', existsSync(join(SCRATCH, 'killed', 'prove-fixture-killed.red-road.rerun.log')))
check('one Jev request for the whole road — the rerun is read by no model', router.received.length === 1, String(router.received.length))
router.reset()
const stillRed = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--', 'false'])
check('a rerun still red is a real red, exit 1', /^KILLED p=0\.92 · starved 0\.20 · solo rerun rc=1 in \d+s → real red · receipt /.test(stillRed.line) && stillRed.rc === 1, `${stillRed.rc} ${stillRed.line}`)
check('the receipt says so', /still red — a real red/.test(readFileSync(receipt, 'utf8')))

section('§5 a starved log is STARVED; the numbers ride the line and the JSON')
router.reset()
const starvedLog = logPath('starved', '.out')
const starved = await run(['ui', starvedLog, '--row', 'ui\tpty\t1\t61\t-\t-', '--no-rerun'])
check('STARVED p=0.73 · killed 0.12 · rerun skipped, exit 0', starved.line === 'STARVED p=0.73 · killed 0.12 · rerun skipped' && starved.rc === 0, `${starved.rc} ${starved.line} ${starved.err.slice(0, 200)}`)
check('the row gave the run its rc and wall', /exit code 1 · no signal · wall 61s/.test(String(((lastBody().body.state ?? {}) as Record<string, unknown>).run)), String(((lastBody().body.state ?? {}) as Record<string, unknown>).run))
router.reset()
const json = await run(['ui', starvedLog, '--row', 'ui\tpty\t1\t61\t-\t-', '--no-rerun', '--json'])
const parsed = (() => {
  try {
    return JSON.parse(json.line) as Record<string, unknown>
  } catch {
    return {}
  }
})()
check('--json prints one JSON line with the verdict, both numbers, the run and the exit', parsed.verdict === 'STARVED' && parsed.killed === 0.12 && parsed.starved === 0.73 && parsed.rc === 1 && parsed.secs === 61 && parsed.exit === 0 && parsed.rerun === 'skipped', json.line.slice(0, 200))
check('the JSON names the model that answered and the tokens', typeof parsed.model === 'string' && (parsed.model as string).startsWith('typesafe/jev') && typeof parsed.inputTokens === 'number', json.line.slice(0, 200))

section('§6 the sidecars beside a pool log stand in for the row')
router.reset()
const sidecarLog = logPath('killed', '.out')
writeFileSync(join(SCRATCH, 'killed', 'prove-fixture-killed.rc'), '137\n')
writeFileSync(join(SCRATCH, 'killed', 'prove-fixture-killed.secs'), '900\n')
writeFileSync(join(SCRATCH, 'killed', 'prove-fixture-killed.hang'), '900\n')
const sidecar = await run(['crew', sidecarLog, '--no-rerun', '--json'])
const sidecarJson = (() => {
  try {
    return JSON.parse(sidecar.line) as Record<string, unknown>
  } catch {
    return {}
  }
})()
check('rc, wall and the hang sidecar are read from beside the log', sidecarJson.rc === 137 && sidecarJson.secs === 900 && sidecarJson.hangSecs === 900 && sidecarJson.signal === 'SIGKILL', sidecar.line.slice(0, 200))

section('§7 a product red is REAL (exit 1) and an in-between is UNSURE (exit 2); neither reruns')
router.reset()
const marker2 = join(SCRATCH, 'rerun-ran-2')
const product = await run(['scripts/jev/prove-fixture-product.ts', logPath('product'), '--rc', '1', '--', 'touch', marker2])
check('REAL — killed 0.03 · starved 0.05 → a seat with the log', product.line === 'REAL — killed 0.03 · starved 0.05 → a seat with the log' && product.rc === 1, `${product.rc} ${product.line} ${product.err.slice(0, 200)}`)
const unsure = await run(['scripts/jev/prove-fixture-unsure.ts', logPath('unsure'), '--rc', '1', '--', 'touch', marker2])
check('UNSURE — killed 0.31 · starved 0.22 → a seat with the log', unsure.line === 'UNSURE — killed 0.31 · starved 0.22 → a seat with the log' && unsure.rc === 2, `${unsure.rc} ${unsure.line}`)
check('no rerun ran for either', !existsSync(marker2))
const floored = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--floor', '0.95', '--no-rerun'])
check('--floor 0.95 turns the 0.92 kill into UNSURE', floored.line === 'UNSURE — killed 0.92 · starved 0.20 → a seat with the log' && floored.rc === 2, `${floored.rc} ${floored.line}`)

section('§8 a refusal, a pace line or a switched-off JEV is UNAVAILABLE (exit 3) with the status kind’s words; nothing reruns')
router.reset()
router.next(openrouterFailure(402, 'openrouter_credits'))
const credit = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--', 'touch', marker2])
check('a 402 for credit reads UNAVAILABLE — provider refused for credit …', /^UNAVAILABLE — provider refused for credit — OpenRouter said /.test(credit.line) && credit.rc === 3, `${credit.rc} ${credit.line} ${credit.err.slice(0, 200)}`)
router.reset()
router.next({ status: 429, body: { error: { message: 'Too Many Requests' } }, headers: { 'retry-after': '3' } })
const paced = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--', 'touch', marker2])
check('a 429 reads UNAVAILABLE — rate limited by the provider …', /^UNAVAILABLE — rate limited by the provider — 429 at /.test(paced.line) && paced.rc === 3, `${paced.rc} ${paced.line}`)
check('no rerun ran for either', !existsSync(marker2))
router.reset()
setting.setJevEnabled(false)
const off = await run(['scripts/crew/prove-fixture-killed.ts', killedLog, '--rc', '137', '--', 'touch', marker2])
check('JEV off in the store reads UNAVAILABLE — off — … and sends nothing', /^UNAVAILABLE — off — the JEV switch is off/.test(off.line) && off.rc === 3 && router.received.length === 0, `${off.rc} ${off.line}`)
setting.setJevEnabled(true, 'openrouter')

await router.close()
finish()
