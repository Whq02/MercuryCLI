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
const ARM = argAfter('--arm') ?? 'all'
const runs = (arm: string): boolean => ARM === 'all' || ARM === 'both' && arm !== 'queued' || ARM === arm
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]

const BIG_ASK = 'write the long design note'
const BIG_REPLY_TAIL = 'the long design note ends here'
const PICKUP_ASK = 'carry on from the note'
const GPT_REPLY = 'sol carries on from the note'
const OPUS_SUMMARY_HEAD = 'SUMMARY BY OPUS'
const WINDOW = 40_000
const CEILING = 400_000
const REPLY_CHARS = 120_000
const HELD_ASK = 'think about the note for a while'
const HELD_OPENING = 'the held reply begins here'
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

type Capture = { kind: string; n?: number; url?: string; at: number; model?: unknown; count?: number; summary?: boolean; refused?: boolean; big?: boolean; held?: boolean; ask?: string }
type Grid = Array<Array<{ c: string }>>
type Payload = { grid: Grid; marks?: Array<{ label: string; atTick: number; grid: Grid }>; sendReceipts?: Array<{ atTick?: number; ts?: number }>; endReason?: string }
const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

async function runArm(arm: 'flat' | 'ceiling' | 'queued'): Promise<{ wire: Capture[]; payload: Payload | null; status: number | null; home: string }> {
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-switchwindow-${arm}-${process.pid}`)
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
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# switch window drive fixture\n')

  const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn(
    'node',
    [path.join(import.meta.dir, 'switch-window-fixture-server.ts'), captureFile, String(WINDOW), String(arm === 'ceiling' ? CEILING : 0), String(REPLY_CHARS), '4', ...(arm === 'queued' ? [HELD_ASK, String(HOLD_MS)] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
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

  const out = path.join(RUN_HOME, `grid-${arm}.json`)
  const cardSends =
    arm === 'flat'
      ? [{ atTick: 260, minTick: 8, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'card' }]
      : []
  const queuedSends = [
    { atTick: 40, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 80, minTick: 20, requireAwait: true, awaitText: '? for shortcuts', data: `${BIG_ASK}\r` },
    { atTick: 220, minTick: 10, requireAwait: true, awaitText: BIG_REPLY_TAIL, awaitSettleTicks: 3, data: `${HELD_ASK}\r`, mark: 'held-sent' },
    { atTick: 260, minTick: 10, requireAwait: true, awaitText: HELD_OPENING, awaitSettleTicks: 3, data: '/model gpt-5.6-sol\r', mark: 'switch-sent' },
    { atTick: 300, minTick: 8, requireAwait: true, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'card' },
    { atTick: 340, minTick: 8, requireAwait: true, awaitText: 'Model switch queued', awaitSettleTicks: 1, data: '', mark: 'queued' },
    { atTick: 520, minTick: 10, requireAwait: true, awaitText: 'Compacted —', awaitStableTicks: 15, data: `${PICKUP_ASK}\r`, mark: 'pickup-sent' },
  ]
  const cfg = {
    argv: ['node', DIST, '--model', 'claude-opus-4-8'],
    cwd: FIXTURE_CWD,
    sends: arm === 'queued' ? queuedSends : [
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 80, minTick: 20, awaitText: '? for shortcuts', data: `${BIG_ASK}\r` },
      { atTick: 220, minTick: 10, awaitText: BIG_REPLY_TAIL, awaitSettleTicks: 3, data: '/model gpt-5.6-sol\r', mark: 'switch-sent' },
      ...cardSends,
      { atTick: 420, minTick: 10, awaitText: 'GPT-5.6 Sol · ●', awaitSettleTicks: 3, data: `${PICKUP_ASK}\r`, mark: 'pickup-sent' },
      { atTick: 560, minTick: 5, awaitText: 'context overflowed', awaitSettleTicks: 2, data: '', mark: 'notice' },
    ],
    readyText: [GPT_REPLY],
    readySettleTicks: 4,
    stableTicks: 4,
    total: arm === 'queued' ? 900 + Math.ceil(HOLD_MS / 200) : 900,
    cols: COLS,
    rows: ROWS,
    out,
  }
  const cfgPath = path.join(RUN_HOME, `cfg-${arm}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: 'sk-test-switchwindow-openai',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
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

  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(arm === 'queued' ? 240_000 + HOLD_MS : 240_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  try {
    fixture.kill('SIGTERM')
  } catch {
  }
  let payload: Payload | null = null
  if (existsSync(out)) payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
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
  return { wire, payload, status: res.status, home: RUN_HOME }
}

function recordLines(home: string, needle: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (name.endsWith('.jsonl')) {
          for (const line of readFileSync(p, 'utf8').split('\n')) if (line.includes(needle)) out.push(line)
        }
      } catch {
      }
    }
  }
  walk(path.join(home, 'projects'))
  return out
}

type Fold = { trigger?: string; preTokens?: number; postTokens?: number }
function foldRecord(home: string): { folds: Fold[]; foldRow: number; seatRows: number[] } {
  const read = { folds: [] as Fold[], foldRow: -1, seatRows: [] as number[] }
  const projects = path.join(home, 'projects')
  if (!existsSync(projects)) return read
  for (const project of readdirSync(projects)) {
    const dir = path.join(projects, project)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, row) => {
        if (line.includes('"boundaryKind":"compact"')) {
          const meta = (JSON.parse(line) as { payload?: { fields?: { compactMetadata?: Fold } } }).payload?.fields?.compactMetadata
          read.folds.push({ trigger: meta?.trigger, preTokens: meta?.preTokens, postTokens: meta?.postTokens })
          if (read.foldRow < 0) read.foldRow = row
        }
        if (line.includes('<command-name>/model</command-name>')) read.seatRows.push(row)
      })
    }
  }
  return read
}

const markText = (payload: Payload | null, label: string): string => {
  const mark = payload?.marks?.find(m => m.label === label)
  return mark === undefined ? '' : gridText(mark.grid)
}
const finalText = (payload: Payload | null): string => (payload === null ? '' : gridText(payload.grid))
const anyText = (payload: Payload | null): string => [...(payload?.marks ?? []).map(m => gridText(m.grid)), finalText(payload)].join('\n')
const tail = (text: string, lines: number): string => text.split('\n').filter(l => l.trim() !== '').slice(-lines).join('\n')

console.log('============================================================')
console.log(' the model switch and the window — the real binary, both loopback families')
console.log(`   dist: ${DIST}`)
console.log('============================================================')

const kept: string[] = []

if (runs('flat')) {
  section('the flat window: the switch checks the history against the target window before its first request')
  const r = await runArm('flat')
  const card = markText(r.payload, 'card')
  const painted = anyText(r.payload)
  const summaries = r.wire.filter(w => w.summary === true)
  const firstOpenai = r.wire.find(w => w.kind === 'openai')
  const refusedOpenai = r.wire.filter(w => w.kind === 'openai' && w.refused === true)
  check('the big reply rode the Anthropic leg', r.wire.some(w => w.kind === 'anthropic' && w.big === true), `wire=${r.wire.map(w => `${w.kind}${w.summary ? '/summary' : ''}${w.refused ? '/refused' : ''}`).join('→')} vshot=${r.status} end=${r.payload?.endReason ?? '?'}`)
  check("the switch preview names Mercury's count of the history and the target's window", card.includes("by Mercury's count") && card.includes('40,000'), tail(card, 14))
  check('the preview says confirm folds the conversation on the source model first', card.includes('folds') && card.includes('Opus'), tail(card, 14))
  check('the fold ran on the SOURCE model before any request on the target (an Anthropic summary call precedes every OpenAI request)', summaries.length >= 1 && summaries[0]!.kind === 'anthropic' && (firstOpenai === undefined || summaries[0]!.at <= firstOpenai.at), `summaries=${JSON.stringify(summaries.map(s => [s.kind, s.count]))} firstOpenai=${JSON.stringify(firstOpenai)}`)
  check('no request on the target was refused for its size', refusedOpenai.length === 0, JSON.stringify(refusedOpenai.map(w => w.count)))
  check("the first request on the target rode the folded history (the source's summary) under the window", firstOpenai !== undefined && firstOpenai.refused !== true && (firstOpenai.count ?? Number.POSITIVE_INFINITY) <= WINDOW, JSON.stringify(firstOpenai))
  check('the switched reply painted', painted.includes(GPT_REPLY), tail(finalText(r.payload), 12))
  check('no overflow notice was needed', !painted.includes('context overflowed'), tail(finalText(r.payload), 12))
  const record = foldRecord(r.home)
  const fold = record.folds[0]
  const previewCount = Number((/about ([\d,]+) tokens by Mercury's count/.exec(card.replace(/[│\s]+/g, ' ')) ?? [])[1]?.replace(/,/g, ''))
  console.log(`  [record] the session's record: ${JSON.stringify(record)} · the preview counted ${previewCount} · summary requests ${JSON.stringify(summaries.map(s => [s.kind, s.model, s.count]))}`)
  check("the session's record holds ONE fold, the manual one the preview started, and it stands before the seat's own /model row: the conversation was folded while the session was still on the source model", record.folds.length === 1 && fold?.trigger === 'manual' && record.seatRows.length === 1 && record.foldRow >= 0 && record.foldRow < record.seatRows[0]!, JSON.stringify(record))
  check(`that fold measured the history the preview counted, nothing added to it — its count before is the preview's own figure, above the target's ${WINDOW.toLocaleString('en-US')} — and it lands under that window`, fold?.preTokens !== undefined && fold.preTokens === previewCount && previewCount > WINDOW && fold.postTokens !== undefined && fold.postTokens < WINDOW, `fold ${JSON.stringify(fold)} · preview ${previewCount}`)
  check("the one summary request went to the source model at a size the target's window could not have held", summaries.length === 1 && summaries[0]!.kind === 'anthropic' && summaries[0]!.model === 'claude-opus-4-8' && (summaries[0]!.count ?? 0) > WINDOW, JSON.stringify(summaries.map(s => [s.kind, s.model, s.count])))
  if (failures > 0) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

if (runs('ceiling')) {
  section('the declared ceiling above the served default: the request goes out, the notice carries Mercury\'s count and window, the fold runs on the source model')
  const before = failures
  const r = await runArm('ceiling')
  const painted = anyText(r.payload)
  const noticeRows = recordLines(r.home, 'context overflowed')
  if (FRAMES !== undefined) writeFileSync(path.join(FRAMES, `ceiling-notice-record-${COLS}x${ROWS}.jsonl`), noticeRows.join('\n') + '\n')
  const summaries = r.wire.filter(w => w.summary === true)
  const refusedOpenai = r.wire.filter(w => w.kind === 'openai' && w.refused === true)
  check('the big reply rode the Anthropic leg', r.wire.some(w => w.kind === 'anthropic' && w.big === true), `wire=${r.wire.map(w => `${w.kind}${w.summary ? '/summary' : ''}${w.refused ? '/refused' : ''}`).join('→')} vshot=${r.status} end=${r.payload?.endReason ?? '?'}`)
  check('the switch applied without a window warning (the declared ceiling holds the history by Mercury\'s budget)', !painted.includes('Model switch preview'), tail(markText(r.payload, 'pickup-sent'), 10))
  check('the first request on the target went out and the provider refused it (the ladder\'s road)', refusedOpenai.length >= 1, JSON.stringify(r.wire.map(w => [w.kind, w.count, w.refused ?? false])))
  check("the overflow notice in the session's record names Mercury's count and the window it measured against", noticeRows.some(line => /context overflowed \(OpenAI; about [\d,]+ tokens by Mercury's count against the 400,000-token window\) — folding the conversation and retrying/.test(line)), noticeRows.map(l => l.slice(0, 200)).join('\n') || 'no notice row in the record')
  check("the glass carries the numbers too — the notice row while the fold runs, the fold's own row once it lands", painted.includes("by Mercury's count") && painted.includes('400,000'), tail(finalText(r.payload), 12))
  check('the fold that answered the overflow ran on the SOURCE model (the summary call is Anthropic, never the refused target)', summaries.length >= 1 && summaries.every(s => s.kind === 'anthropic'), JSON.stringify(summaries.map(s => [s.kind, s.count, s.refused ?? false])))
  check('the retried request fitted and the reply painted', painted.includes(GPT_REPLY) && refusedOpenai.length === 1, tail(finalText(r.payload), 12))
  if (failures > before) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

if (runs('queued')) {
  section('the same switch confirmed while a reply is still streaming: the seat is queued behind the turn, and the fold that follows it is still written by the source model')
  const before = failures
  const r = await runArm('queued')
  const card = markText(r.payload, 'card')
  const queuedFrame = markText(r.payload, 'queued')
  const painted = anyText(r.payload)
  const summaries = r.wire.filter(w => w.summary === true)
  const held = r.wire.find(w => w.held === true)
  const released = r.wire.find(w => w.kind === 'released')
  const openai = r.wire.filter(w => w.kind === 'openai')
  const pickup = openai.find(w => w.summary !== true)
  const record = foldRecord(r.home)
  const fold = record.folds[0]
  console.log(`  [record] wire: ${r.wire.filter(w => w.kind !== 'models' && w.kind !== 'hit').map(w => (w.kind === 'released' ? 'released' : `${w.kind}${w.summary ? '/summary' : w.held ? '/held' : w.big ? '/big' : ''}${w.refused ? '/refused' : ''}:${w.count ?? '?'}`)).join(' → ')}`)
  console.log(`  [record] the session's record: ${JSON.stringify(record)} · vshot=${r.status} end=${r.payload?.endReason ?? '?'}`)
  check('the big reply rode the Anthropic leg and the next reply was held open', r.wire.some(w => w.kind === 'anthropic' && w.big === true) && held !== undefined, JSON.stringify(r.wire.map(w => [w.kind, w.count])))
  check("the preview names Mercury's count, the target's window and the fold on the source model", card.includes("by Mercury's count") && card.includes('40,000') && card.includes('folds') && card.includes('Opus'), tail(card, 14))
  check('the confirm came while that reply was still open: the seat answered queued, and nothing was folded before the reply ended', queuedFrame.includes('Model switch queued') && released !== undefined && summaries.length >= 1 && summaries.every(s => s.at >= released.at), `released=${JSON.stringify(released)} summaries=${JSON.stringify(summaries.map(s => [s.kind, s.at]))} · ${tail(queuedFrame, 8)}`)
  check("the session's record holds ONE fold, the manual one the preview started, behind the switch's own /model row: asked while the reply was open, it ran when the reply had ended", record.folds.length === 1 && fold?.trigger === 'manual' && record.seatRows.length === 1 && record.foldRow > record.seatRows[0]!, JSON.stringify(record))
  check("the summary was written by the SOURCE model, as the preview says: one summary request, on the Anthropic wire, the whole history in it — a size the target's window could not have held", summaries.length === 1 && summaries[0]!.kind === 'anthropic' && summaries[0]!.model === 'claude-opus-4-8' && (summaries[0]!.count ?? 0) > WINDOW, JSON.stringify(summaries.map(s => [s.kind, s.model, s.count, s.refused ?? false])))
  check('no request on the target was refused for its size', openai.every(w => w.refused !== true), JSON.stringify(openai.map(w => [w.count, w.summary ?? false, w.refused ?? false])))
  check(`the fold lands under the ${WINDOW.toLocaleString('en-US')} tokens the target's account serves`, fold?.postTokens !== undefined && fold.postTokens < WINDOW, JSON.stringify(fold))
  check('the first request on the target rode the folded history under the window, and its reply painted', pickup !== undefined && (pickup.count ?? Number.POSITIVE_INFINITY) <= WINDOW && painted.includes(GPT_REPLY), `${JSON.stringify(pickup)} · ${tail(finalText(r.payload), 10)}`)
  check('no overflow notice and no fold error was painted', !painted.includes('context overflowed') && !painted.includes('Error during compaction'), tail(finalText(r.payload), 12))
  if (failures > before) kept.push(r.home)
  else rmSync(r.home, { recursive: true, force: true })
}

for (const home of kept) console.log(`[forensics] world kept: ${home}`)
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
