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
const ARM = argAfter('--arm') ?? 'both'
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]

const LOCAL_TAG = 'qwen3.8-27b-32k:latest'
const NUM_CTX = 65_536
const NOTES = 6
const NOTE_CHARS = 40_000
const NOTE_WORDS = ['one', 'two', 'three', 'four', 'five', 'six']
const PICKUP_ASK = 'carry on from the notes'
const LOCAL_REPLY = 'the local model carries on from the notes'
const HOLD_MS = 20_000

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
type Arm = 'applied' | 'queued'
type Run = { wire: Capture[]; payload: Payload | null; home: string; folds: Boundary[]; foldRows: number[]; seatRows: number[] }
const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function foldRecord(home: string): { folds: Boundary[]; foldRows: number[]; seatRows: number[] } {
  const read = { folds: [] as Boundary[], foldRows: [] as number[], seatRows: [] as number[] }
  const projects = path.join(home, 'projects')
  if (!existsSync(projects)) return read
  for (const project of readdirSync(projects)) {
    const dir = path.join(projects, project)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, row) => {
        if (line.includes('"boundaryKind":"compact"')) {
          const meta = (JSON.parse(line) as { payload?: { fields?: { compactMetadata?: Boundary } } }).payload?.fields?.compactMetadata
          read.folds.push({ trigger: meta?.trigger, preTokens: meta?.preTokens, postTokens: meta?.postTokens, recentRounds: meta?.recentRounds })
          read.foldRows.push(row)
        }
        if (line.includes('<command-name>/model</command-name>')) read.seatRows.push(row)
      })
    }
  }
  return read
}

async function runArm(arm: Arm): Promise<Run> {
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-switchback-${arm}-${process.pid}`)
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
      ...(arm === 'queued' ? { autoCompactEnabled: false } : {}),
      projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# switch back drive fixture\n')

  const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn('node', [path.join(import.meta.dir, 'switch-back-local-fixture-server.ts'), captureFile, String(NUM_CTX), String(NOTE_CHARS), String(arm === 'queued' ? NOTES : 0), String(arm === 'queued' ? HOLD_MS : 0)], { stdio: ['ignore', 'pipe', 'pipe'] })
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
  const switchNeedle = arm === 'queued' ? `design note ${NOTES} begins here` : `design note ${NOTES} ends here`
  const cfg = {
    argv: ['node', DIST, '--model', 'claude-opus-4-8'],
    cwd: FIXTURE_CWD,
    sends: [
      { atTick: 40, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 80, minTick: 20, requireAwait: true, awaitText: '? for shortcuts', data: `write design note ${NOTE_WORDS[0]}\r` },
      ...noteSends,
      { atTick: 140 + NOTES * 60, minTick: 10, requireAwait: true, awaitText: switchNeedle, awaitSettleTicks: 3, data: `/model local/${LOCAL_TAG}\r`, mark: 'switch-sent' },
      { atTick: 200 + NOTES * 60, minTick: 8, requireAwait: true, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'card' },
      ...(arm === 'queued' ? [{ atTick: 260 + NOTES * 60, minTick: 8, requireAwait: true, awaitText: 'Model switch queued', awaitSettleTicks: 1, data: '', mark: 'queued' }] : []),
      { atTick: 420 + NOTES * 60, minTick: 10, requireAwait: true, awaitText: 'Compacted —', awaitStableTicks: 15, data: `${PICKUP_ASK}\r`, mark: 'pickup-sent' },
    ],
    readyText: [LOCAL_REPLY],
    readySettleTicks: 6,
    stableTicks: 4,
    total: 1100 + NOTES * 60 + (arm === 'queued' ? Math.ceil(HOLD_MS / 200) : 0),
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
  delete childEnv.MERCURY_AUTO_COMPACT
  delete childEnv.MERCURY_COMPACT

  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(360_000 + (arm === 'queued' ? HOLD_MS : 0)), cwd: FIXTURE_CWD, env: childEnv })
  try {
    fixture.kill('SIGTERM')
  } catch {
  }
  const payload: Payload | null = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
  console.log(`  [record] vshot rc=${res.status} end=${payload?.endReason ?? '?'}${res.status === 0 ? '' : ` — ${String(res.stderr ?? '').trim().slice(-800)}`}`)
  const wire: Capture[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
  if (FRAMES !== undefined && payload !== null) {
    mkdirSync(FRAMES, { recursive: true })
    for (const mark of payload.marks ?? []) writeFileSync(path.join(FRAMES, `${arm}-${mark.label}-${COLS}x${ROWS}.txt`), gridText(mark.grid))
    writeFileSync(path.join(FRAMES, `${arm}-final-${COLS}x${ROWS}.txt`), gridText(payload.grid))
    writeFileSync(path.join(FRAMES, `${arm}-wire-${COLS}x${ROWS}.jsonl`), wire.map(w => JSON.stringify(w)).join('\n') + '\n')
  }
  return { wire, payload, home: RUN_HOME, ...foldRecord(RUN_HOME) }
}

const tail = (text: string, lines: number): string => text.split('\n').filter(l => l.trim() !== '').slice(-lines).join('\n')
const kept: string[] = []

console.log('============================================================')
console.log(' the switch back to a local model — the real binary, a cloud history and a loopback Ollama')
console.log(`   dist: ${DIST}`)
console.log('============================================================')

for (const arm of (['applied', 'queued'] as const).filter(name => ARM === 'both' || ARM === name)) {
  section(arm === 'applied'
    ? `a ${NOTES}-round cloud history, then /model local/${LOCAL_TAG} (Modelfile num_ctx ${NUM_CTX}) and confirm at the preview`
    : 'the same switch confirmed while the sixth reply is still streaming, auto-compact off: the seat is queued behind the turn and the fold follows it')
  const before = failures
  const r = await runArm(arm)
  const markText = (label: string): string => {
    const mark = r.payload?.marks?.find(m => m.label === label)
    return mark === undefined ? '' : gridText(mark.grid)
  }
  const finalText = r.payload === null ? '' : gridText(r.payload.grid)
  const painted = [...(r.payload?.marks ?? []).map(m => gridText(m.grid)), finalText].join('\n')
  const card = markText('card')
  const notesWritten = r.wire.filter(w => w.kind === 'anthropic' && w.note === true)
  const summaries = r.wire.filter(w => w.summary === true)
  const localChats = r.wire.filter(w => w.kind === 'local' && w.pickup === true)
  const firstLocal = localChats[0]
  const released = r.wire.find(w => w.kind === 'released')
  const wireWords = r.wire.filter(w => w.kind === 'anthropic' || w.kind === 'local' || w.kind === 'released').map(w => (w.kind === 'released' ? 'released' : `${w.kind}${w.summary ? '/summary' : w.note ? '/note' : ''}:${w.count ?? '?'}`)).join(' → ')
  console.log(`  [record] wire: ${wireWords}`)
  console.log(`  [record] folds in the session's record: ${JSON.stringify(r.folds)} · record rows: the seat's /model row ${JSON.stringify(r.seatRows)}, the fold ${JSON.stringify(r.foldRows)}`)
  check(`the ${NOTES} notes rode the Anthropic leg`, notesWritten.length === NOTES, wireWords)
  check("the preview names Mercury's count, the local model's window and the fold on the cloud model before the first local request", card.includes("by Mercury's count") && card.includes('65,536') && card.includes('folds') && card.includes('Opus'), tail(card, 12))
  if (arm === 'queued') {
    const queuedFrame = markText('queued')
    check('the confirm came while the sixth reply was still open: the seat answered queued, and nothing was folded before that reply ended', queuedFrame.includes('Model switch queued') && !card.includes(`design note ${NOTES} ends here`) && released !== undefined && summaries.every(s => s.at >= released.at), `released=${JSON.stringify(released)} summaries=${JSON.stringify(summaries.map(s => s.at))} · ${tail(queuedFrame, 8)}`)
  }
  check('the switch landed and the local reply painted', finalText.includes(`ready · local/${LOCAL_TAG}`) && painted.includes(LOCAL_REPLY) && firstLocal !== undefined, tail(finalText, 12))
  check('the first local request carried the Modelfile window as num_ctx', firstLocal?.numCtx === NUM_CTX, JSON.stringify(firstLocal))
  const manual = r.folds.find(f => f.trigger === 'manual')
  check(`the fold the preview started is sized by the incoming model: it lands under half its window of ${NUM_CTX.toLocaleString('en-US')} (red on the parent's applied road: sized for the outgoing model it landed above the whole window)`, manual?.postTokens !== undefined && manual.postTokens < NUM_CTX / 2, JSON.stringify(manual))
  check("ONE fold serves the switch: one summary request, written on the cloud wire, and it precedes the first local request (red on the parent's applied road: the first local turn folds a second time)", summaries.length === 1 && summaries[0]!.kind === 'anthropic' && firstLocal !== undefined && summaries[0]!.at <= firstLocal.at, `${summaries.length} summary request(s): ${JSON.stringify(summaries.map(s => [s.kind, s.count]))}`)
  check("the session's record holds one fold boundary, the manual one the preview started, and the seat's own /model row stands before it: the conversation was folded on the incoming model (red on the parent's applied road: the fold stands first)", r.folds.length === 1 && r.folds[0]?.trigger === 'manual' && r.seatRows.length === 1 && r.seatRows[0]! < r.foldRows[0]!, JSON.stringify({ folds: r.folds, seatRows: r.seatRows, foldRows: r.foldRows }))
  check('the first local request fits the window it names', firstLocal !== undefined && (firstLocal.count ?? Number.POSITIVE_INFINITY) < NUM_CTX, JSON.stringify(firstLocal))
  check('no refusal or overflow notice was painted', !painted.includes('cannot fit') && !painted.includes('context overflowed') && !painted.includes('cannot bring the context under') && !painted.includes('Error during compaction'), tail(finalText, 12))
  if (failures > before) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

for (const home of kept) console.log(`[forensics] world kept: ${home}`)
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
