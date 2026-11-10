#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? path.join(REPO, 'dist/mercury.mjs')
const FRAMES = argAfter('--frames')
const SIZE = argAfter('--size') ?? '110x34'
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]

const LOCAL_TAG = 'qwen3.8-27b-32k:latest'
const NUM_CTX = 65_536
const NOTES = 6
const NOTE_CHARS = 40_000
const NOTE_WORDS = ['one', 'two', 'three', 'four', 'five', 'six']
const PICKUP_ASK = 'carry on from the notes'
const LOCAL_REPLY = 'the local model carries on from the notes'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log(`FAIL ${DIST} missing — build first (the drive proves the BUILT binary)`)
  process.exit(1)
}

type Capture = { kind: string; n?: number; at: number; count?: number; summary?: boolean; note?: boolean; numCtx?: number; numPredict?: number; pickup?: boolean; tools?: number }
type Grid = Array<Array<{ c: string }>>
type Payload = { grid: Grid; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
type Boundary = { trigger?: string; preTokens?: number; postTokens?: number; recentRounds?: { requested?: number; kept?: number; tokens?: number; reason?: string } }
const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-switchback-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'proof-key-ci-gate-not-a-real-key'
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(FIXTURE_CWD, { recursive: true })
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# switch back drive fixture\n')

const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn('node', [path.join(import.meta.dir, 'switch-back-local-fixture-server.ts'), captureFile, String(NUM_CTX), String(NOTE_CHARS)], { stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
})
const base = `http://127.0.0.1:${port}`

const out = path.join(RUN_HOME, 'grid.json')
const noteSends = NOTE_WORDS.slice(1, NOTES).map((word, index) => ({ atTick: 140 + index * 60, minTick: 10, requireAwait: true, awaitText: `design note ${index + 1} ends here`, awaitSettleTicks: 3, data: `write design note ${word}\r` }))
const cfg = {
  argv: ['node', DIST, '--model', 'claude-opus-4-8'],
  cwd: FIXTURE_CWD,
  sends: [
    { atTick: 40, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 80, minTick: 20, requireAwait: true, awaitText: '? for shortcuts', data: `write design note ${NOTE_WORDS[0]}\r` },
    ...noteSends,
    { atTick: 140 + NOTES * 60, minTick: 10, requireAwait: true, awaitText: `design note ${NOTES} ends here`, awaitSettleTicks: 3, data: `/model local/${LOCAL_TAG}\r`, mark: 'switch-sent' },
    { atTick: 200 + NOTES * 60, minTick: 8, requireAwait: true, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'card' },
    { atTick: 420 + NOTES * 60, minTick: 10, requireAwait: true, awaitText: 'Compacted —', awaitStableTicks: 15, data: `${PICKUP_ASK}\r`, mark: 'pickup-sent' },
  ],
  readyText: [LOCAL_REPLY],
  readySettleTicks: 6,
  stableTicks: 4,
  total: 1100 + NOTES * 60,
  cols: COLS,
  rows: ROWS,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  MERCURY_LOCAL_PROBE_TARGETS: `ollama=${base}`,
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_HEALTH_STATE_DIR: path.join(RUN_HOME, 'health-state'),
  MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
  MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
  BROWSER: '/usr/bin/true',
}
delete childEnv.NODE_ENV
delete childEnv.ANTHROPIC_AUTH_TOKEN
delete childEnv.MERCURY_LOCAL_BASE_URL
delete childEnv.MERCURY_LOCAL_API_KEY

const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(360_000), cwd: FIXTURE_CWD, env: childEnv })
try {
  fixture.kill('SIGTERM')
} catch {
}
const payload: Payload | null = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
const wire: Capture[] = readFileSync(captureFile, 'utf8')
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Capture)

function boundaries(home: string): Boundary[] {
  const found: Boundary[] = []
  const projects = path.join(home, 'projects')
  if (!existsSync(projects)) return found
  for (const project of readdirSync(projects)) {
    const dir = path.join(projects, project)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
        if (!line.includes('"boundaryKind":"compact"')) continue
        const meta = (JSON.parse(line) as { payload?: { fields?: { compactMetadata?: Boundary } } }).payload?.fields?.compactMetadata
        if (meta !== undefined) found.push({ trigger: meta.trigger, preTokens: meta.preTokens, postTokens: meta.postTokens, recentRounds: meta.recentRounds })
      }
    }
  }
  return found
}

const markText = (label: string): string => {
  const mark = payload?.marks?.find(m => m.label === label)
  return mark === undefined ? '' : gridText(mark.grid)
}
const finalText = payload === null ? '' : gridText(payload.grid)
const painted = [...(payload?.marks ?? []).map(m => gridText(m.grid)), finalText].join('\n')
const tail = (text: string, lines: number): string => text.split('\n').filter(l => l.trim() !== '').slice(-lines).join('\n')
if (FRAMES !== undefined && payload !== null) {
  mkdirSync(FRAMES, { recursive: true })
  for (const mark of payload.marks ?? []) writeFileSync(path.join(FRAMES, `${mark.label}-${COLS}x${ROWS}.txt`), gridText(mark.grid))
  writeFileSync(path.join(FRAMES, `final-${COLS}x${ROWS}.txt`), finalText)
  writeFileSync(path.join(FRAMES, `wire-${COLS}x${ROWS}.jsonl`), wire.map(w => JSON.stringify(w)).join('\n') + '\n')
}

console.log('============================================================')
console.log(' the switch back to a local model — the real binary, a cloud history and a loopback Ollama')
console.log(`   dist: ${DIST}`)
console.log('============================================================')

section(`a ${NOTES}-round cloud history, then /model local/${LOCAL_TAG} (Modelfile num_ctx ${NUM_CTX}) and confirm at the preview`)
const card = markText('card')
const notesWritten = wire.filter(w => w.kind === 'anthropic' && w.note === true)
const summaries = wire.filter(w => w.summary === true)
const localChats = wire.filter(w => w.kind === 'local' && w.pickup === true)
const firstLocal = localChats[0]
const folds = boundaries(RUN_HOME)
const wireWords = wire.filter(w => w.kind === 'anthropic' || w.kind === 'local').map(w => `${w.kind}${w.summary ? '/summary' : w.note ? '/note' : ''}:${w.count ?? '?'}`).join(' → ')
console.log(`  [record] wire: ${wireWords}`)
console.log(`  [record] folds in the session's record: ${JSON.stringify(folds)}`)
console.log(`  [record] vshot rc=${res.status} end=${payload?.endReason ?? '?'}${res.status === 0 ? '' : ` — ${String(res.stderr ?? '').trim().slice(-800)}`}`)
check(`the ${NOTES} notes rode the Anthropic leg`, notesWritten.length === NOTES, wireWords)
check("the preview names Mercury's count, the local model's window and the fold on the cloud model before the first local request", card.includes("by Mercury's count") && card.includes('65,536') && card.includes('folds') && card.includes('Opus'), tail(card, 12))
check('the switch landed and the local reply painted', finalText.includes(`ready · local/${LOCAL_TAG}`) && painted.includes(LOCAL_REPLY) && firstLocal !== undefined, tail(finalText, 12))
check('the first local request carried the Modelfile window as num_ctx', firstLocal?.numCtx === NUM_CTX, JSON.stringify(firstLocal))
const manual = folds.find(f => f.trigger === 'manual')
check(`the fold the preview started lands under the incoming model's window of ${NUM_CTX.toLocaleString('en-US')} (red on the parent: sized for the outgoing model's window it landed above it)`, manual?.postTokens !== undefined && manual.postTokens < NUM_CTX, JSON.stringify(manual))
check('ONE fold serves the switch: one summary request on the cloud wire, and it precedes the first local request (red on the parent: the first local turn folds a second time)', summaries.length === 1 && firstLocal !== undefined && summaries[0]!.at <= firstLocal.at, `${summaries.length} summary request(s): ${JSON.stringify(summaries.map(s => s.count))}`)
check("the session's record holds one fold boundary, the manual one the preview started", folds.length === 1 && folds[0]?.trigger === 'manual', JSON.stringify(folds))
check('the first local request fits the window it names', firstLocal !== undefined && (firstLocal.count ?? Number.POSITIVE_INFINITY) < NUM_CTX, JSON.stringify(firstLocal))
check('no refusal or overflow notice was painted', !painted.includes('cannot fit') && !painted.includes('context overflowed') && !painted.includes('cannot bring the context under'), tail(finalText, 12))

if (failures > 0) console.log(`[forensics] world kept: ${RUN_HOME}`)
else rmSync(RUN_HOME, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
