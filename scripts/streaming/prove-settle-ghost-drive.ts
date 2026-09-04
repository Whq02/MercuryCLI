#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const FIXTURE = path.join(import.meta.dir, 'turn-end-fixture-server.ts')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')
const BUDGET_MS = 8_000

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
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

const FIRST_WORDS = 'the first slow reply'
const FIRST_FULL = 'the first slow reply arrives a piece at a time'
const SECOND_FULL = 'the second slow reply follows the queued words'
const MARKS = 14

type Cell = { c: string; fg?: string; bg?: string }
type Mark = { label: string; atTick: number; grid: Cell[][] }
type Wire = { kind: string; n?: number; ask?: string; arm?: string; at: number }
const rowText = (row: Cell[]): string => row.map(c => c.c || ' ').join('').replace(/\s+$/, '')
const gridText = (grid: Cell[][]): string => grid.map(rowText).join('\n')
const TIMESTAMPED = /\d\d:\d\d:\d\d \[Mercury\] /
function fgOfNeedle(grid: Cell[][], needle: string, timestamped: boolean): string | null {
  for (const row of grid) {
    const text = rowText(row)
    const at = text.indexOf(needle)
    if (at < 0 || TIMESTAMPED.test(text) !== timestamped) continue
    return String(row[at]?.fg ?? '')
  }
  return null
}

async function driveScene(route: 'openai' | 'anthropic', arm: 'plain' | 'note'): Promise<{ tailFg: string | null; rowFg: string | null }> {
  const ASK = arm === 'note' ? 'stream a note slowly' : 'stream slowly'
  const QUEUED = `${ASK} please`
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-ghost-${route}-${arm}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-ghost-probe-key'
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
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# fixture\n')

  const captureFile = path.join(RUN_HOME, 'wire.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn(BUN, ['run', FIXTURE, captureFile, FIXTURE_CWD], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    let buffer = ''
    fixture.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const m = /PORT (\d+)/.exec(buffer)
      if (m) {
        clearTimeout(killer)
        resolve(Number(m[1]))
      }
    })
    fixture.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
  }).catch(err => {
    console.log(`FAIL ${String(err)}`)
    process.exit(1)
  })
  const base = `http://127.0.0.1:${port}`
  const reap = (): void => {
    try {
      fixture.kill('SIGTERM')
    } catch {
    }
  }

  const model = route === 'openai' ? 'gpt-5.6-sol' : 'claude-opus-4-8'
  const out = path.join(RUN_HOME, 'grid.json')
  const sends: Array<Record<string, unknown>> = [
    { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${ASK}\r` },
    { requireAwait: true, minTick: 5, awaitText: FIRST_WORDS, awaitSettleTicks: 1, data: `${QUEUED}\r`, mark: 'first-delta' },
  ]
  for (let n = 1; n <= MARKS; n++) sends.push({ afterPrevTicks: 5, data: '', mark: `t+${n}` })
  const cfg = { argv: ['node', DIST, '--model', model], cwd: FIXTURE_CWD, sends, total: 160, cols: 120, rows: 40, out }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: 'sk-test-ghost-openai',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: String(BUDGET_MS),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
  }
  delete childEnv.NODE_ENV
  delete childEnv.ANTHROPIC_AUTH_TOKEN

  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(90_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  reap()
  const marks: Mark[] = []
  let fin: Cell[][] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Cell[][]; marks?: Mark[] }
    marks.push(...(payload.marks ?? []))
    fin = payload.grid
  }
  const wire: Wire[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Wire)
  const label = `${route === 'openai' ? 'OpenAI' : 'Anthropic'} · ${arm}`
  const frames = marks.map(m => ({ label: m.label, text: gridText(m.grid), grid: m.grid }))
  const tail = (s: string): string => s.split('\n').slice(-14).join('\n')
  const linesWith = (text: string, needle: string): string[] => text.split('\n').filter(l => l.includes(needle))

  section(`${label} — G1: the typed row paints QUEUED under the streaming reply`)
  check(`${label}: vshot ran the journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
  const early = frames.find(f => f.label === 't+1') ?? frames[0]
  check(`${label}: the first delta streamed in the tail before the ask was typed into it`, frames.some(f => f.label === 'first-delta' && f.text.includes(FIRST_WORDS)), tail(frames[0]?.text ?? ''))
  check(`${label}: the typed row paints QUEUED while the first reply streams`, early !== undefined && new RegExp(`queued\\s+\\[sam\\] ❯ ${QUEUED}`).test(early.text), tail(early?.text ?? ''))

  section(`${label} — G2/G3: the movie — the tail, then its row, never both`)
  const doubled = frames.filter(f => linesWith(f.text, FIRST_WORDS).length > 1)
  check(`${label}: no frame ever holds two lines of the first reply (print-once, growth in place)`, doubled.length === 0, doubled.map(f => `${f.label}: ${linesWith(f.text, FIRST_WORDS).map(l => l.trim()).join(' || ')}`).join('\n      '))
  const landedAt = frames.findIndex(f => linesWith(f.text, FIRST_WORDS).some(l => TIMESTAMPED.test(l)))
  check(`${label}: the first reply's row landed with its timestamp`, landedAt >= 0, tail(frames[frames.length - 1]?.text ?? ''))
  const ghosts = landedAt >= 0 ? frames.slice(landedAt).filter(f => linesWith(f.text, FIRST_WORDS).some(l => !TIMESTAMPED.test(l))) : []
  check(`${label}: once the row has landed no frame holds an untimestamped copy (the ghost is gone within one frame of the row)`, landedAt >= 0 && ghosts.length === 0, ghosts.map(f => `${f.label}: ${linesWith(f.text, FIRST_WORDS).map(l => l.trim()).join(' || ')}`).join('\n      '))

  section(`${label} — G4: the end`)
  const last = frames[frames.length - 1]?.text ?? gridText(fin)
  check(`${label}: both replies stand once each with their timestamps`, linesWith(last, FIRST_FULL).length === 1 && linesWith(last, SECOND_FULL).length === 1 && linesWith(last, FIRST_FULL).every(l => TIMESTAMPED.test(l)) && linesWith(last, SECOND_FULL).every(l => TIMESTAMPED.test(l)), tail(last))
  check(`${label}: the drained words wear a sent clock and no queued row survives`, new RegExp(`\\d\\d:\\d\\d:\\d\\d \\[sam\\] ❯ ${QUEUED}`).test(last) && !/queued\s+\[sam\]/.test(last), tail(last))
  check(`${label}: the strip is back at ready`, /· ready/.test(last), tail(last))

  section(`${label} — G5: the wire`)
  const slow = wire.filter(c => c.kind === route && (c.arm === 'slow' || c.arm === 'slow-note'))
  check(`${label}: two slow calls, the second carrying the queued words — never a reissue`, slow.length === 2 && (slow[1]?.ask ?? '').includes('please') && !wire.some(c => /dropped mid-response|Pick up exactly/.test(c.ask ?? '')), JSON.stringify(slow.map(c => [c.n, c.arm, c.ask?.slice(0, 40)])))

  const firstFrame = frames.find(f => f.label === 'first-delta') ?? frames[0]
  const tailFg = firstFrame ? fgOfNeedle(firstFrame.grid, FIRST_WORDS, false) : null
  const rowFrame = landedAt >= 0 ? frames[landedAt] : undefined
  const rowFg = rowFrame ? fgOfNeedle(rowFrame.grid, FIRST_WORDS, true) : null

  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${RUN_HOME}`)
  return { tailFg, rowFg }
}

console.log('============================================================')
console.log(' the settle ghost retires on its row, under a queued turn — the built bundle')
console.log('============================================================')
const only = (process.env.GHOST_SCENES ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
const wants = (scene: string): boolean => only.length === 0 || only.includes(scene)
let plainInk: { tailFg: string | null; rowFg: string | null } | null = null
if (wants('openai')) plainInk = await driveScene('openai', 'plain')
if (wants('anthropic')) await driveScene('anthropic', 'plain')
if (wants('note')) {
  const note = await driveScene('openai', 'note')
  section('OpenAI · note — G6: the block\'s ink from the first byte')
  check('the streaming tail\'s words wear the settled row\'s own ink in the first frame that shows them', note.tailFg !== null && note.tailFg === note.rowFg, `tail=${JSON.stringify(note.tailFg)} row=${JSON.stringify(note.rowFg)}`)
  if (plainInk !== null) {
    check('…and that ink is the working note\'s, not the plain reply\'s primary ink', note.tailFg !== null && plainInk.tailFg !== null && note.tailFg !== plainInk.tailFg, `note=${JSON.stringify(note.tailFg)} plain=${JSON.stringify(plainInk.tailFg)}`)
  }
}
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
