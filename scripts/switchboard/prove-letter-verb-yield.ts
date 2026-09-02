#!/usr/bin/env bun
// ============================================================================
//  prove-letter-verb-yield — the board's single-letter row verbs yield to
//  type-to-message on an ARMED row or a held draft (letterVerbYield.ts).
//
// THE FIND (driven on the built product):
//  from LIST focus, "is it done" typed one key at a time while the selected
//  session streamed INTERRUPTED the turn on the `i`, tried the split toggle
//  on the `s`, marked the row on the space, and only "t done" reached the
//  composer — the letter verbs and the type-through shared one key stream
//  with the verbs first. The operator's own road to typing (L17: "click
//  Enter once and it selects it, then you can send a message") armed the
//  row and changed nothing about the letters.
//
//  §1 the pure law · §2 the legend follows (no advertised key that no longer
//  fires) · §3 the screen's every list verb carries the yield · §4 the
//  DRIVE on the real bundle: arm, type "is it done" — the turn streams on,
//  the words land whole. POISON: MERCURY_LETTER_VERB_POISON_DIST=<pre-fix
//  bundle> runs §4 against the bundle that lacks the yield and expects the
//  recorded interrupt (the drive's truth before the fix).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const POISON_DIST = process.env.MERCURY_LETTER_VERB_POISON_DIST
const DIST = POISON_DIST ?? join(REPO, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

if (POISON_DIST === undefined) {
  section('§1 the pure law')
  const { letterVerbsYield } = await import('../../src/components/concourse/letterVerbYield.js')
  check('un-armed + empty draft ⇒ the verbs fire (the legend prints them)', letterVerbsYield({ armedSessionId: null, selectedSessionId: 's1', liveDraftLength: 0 }) === false)
  check('the selected row ARMED ⇒ the letters are words', letterVerbsYield({ armedSessionId: 's1', selectedSessionId: 's1', liveDraftLength: 0 }) === true)
  check('a held draft ⇒ the letters are words (one law, every letter — the broadcast space included)', letterVerbsYield({ armedSessionId: null, selectedSessionId: 's1', liveDraftLength: 3 }) === true)
  check('an arm on ANOTHER row never yields (armed ≡ selected by the screen; the law reads both)', letterVerbsYield({ armedSessionId: 's2', selectedSessionId: 's1', liveDraftLength: 0 }) === false)
  check('no selection, no draft ⇒ verbs', letterVerbsYield({ armedSessionId: null, selectedSessionId: null, liveDraftLength: 0 }) === false)

  section('§2 the legend follows the yield')
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.js')
  const armed = regionKeysFor('list', { newSession: true, selection: 'live', armed: true })
  const plain = regionKeysFor('list', { newSession: true, selection: 'live' })
  // x is NOT in this roster (the close chord): the close verb
  // left the printable plane whole — ⌃x ⌃x rides the app leader and its
  // legend row lawfully SURVIVES the armed yield (no letter, never typing).
  const letters = new Set(['m', 'e', 'i', 'p', 'r', 'n', 's', 'space', '/'])
  check('while ARMED the list legend prints no letter verb', armed.every(k => !letters.has(k.keys)), armed.map(k => k.keys).join(','))
  check('while ARMED the legend teaches the armed moves: ↵ enters (armed) · → enter · type to message', armed.some(k => k.keys === '↵' && /armed/.test(k.label)) && armed.some(k => k.keys === '→') && armed.some(k => k.keys === 'type' && k.label === 'to message'))
  check('CONTROL: un-armed the live row keeps i/p/m/e (the verbs are taught where they fire)', ['i', 'p', 'm', 'e'].every(l => plain.some(k => k.keys === l)))
  check('the older drop-down still outranks the arm (one resolver, layered)', regionKeysFor('list', { newSession: true, selection: 'live', armed: true, olderBrowse: true }).every(k => k.label === 'bring it back'))

  section('§3 the screen carries the yield on every list verb')
  const screen = readFileSync(join(REPO, 'src', 'components', 'concourse', 'ConcourseScreen.tsx'), 'utf8')
  const listStart = screen.indexOf("if (region === 'list') {")
  const listEnd = screen.indexOf("if (region === 'chat') {", listStart)
  const list = screen.slice(listStart, listEnd)
  check('the list handler computes the yield from the three refs (armed · selected · live draft)', /const verbsYield = letterVerbsYield\(\{\s*armedSessionId: boardArmedRef\.current,\s*selectedSessionId: boardSelRef\.current,\s*liveDraftLength: liveDraftRef\.current\.text\.length,\s*\}\)/.test(list))
  for (const letter of ['m', 'e', 'i', 'p', 'r', 'n', 's']) {
    const re = new RegExp(`if \\(input === '${letter}' && !key\\.ctrl && !key\\.meta && !verbsYield`)
    check(`the ${letter} verb yields`, re.test(list))
  }
  check('x carries NO verb at all — plain x is typing in every state (the close chord owns the close)', !/input === 'x'/.test(list))
  check('the broadcast space yields (its empty-draft law now rides the one predicate)', /if \(input === ' ' && !key\.ctrl && !key\.meta && !reducedStage && !verbsYield && pastGate\(\)\)/.test(list))
  check('the split nudges [ ] yield', /if \(\(input === '\[' \|\| input === '\]'\) && !key\.ctrl && !key\.meta && !verbsYield/.test(list))
  check('the / filter yields', /if \(input === '\/' && !key\.ctrl && !key\.meta && !verbsYield\)/.test(list))
  const layout = readFileSync(join(REPO, 'src', 'components', 'concourse', 'ConcourseLayout.tsx'), 'utf8')
  check('the layout hands the armed fact to the one legend resolver and relabels esc "disarm" while armed', /armed: armedSelected/.test(layout) && /armedSelected && k\.keys === 'esc'\s*\?\s*\{ keys: k\.keys, label: 'disarm' \}/.test(layout))
}

section(POISON_DIST === undefined ? '§4 the drive: arm, then type "is it done" while the session streams' : '§4 POISON: the pre-fix bundle interrupts on the i')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const home = mkdtempSync(join(tmpdir(), 'letter-verb-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'letter-verb-cwd-')))
const configDir = join(home, '.mercury')
const daemonDir = join(home, 'daemon')
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
  }),
)
const api = await startFixtureApi([
  { kind: 'paced', deltas: Array.from({ length: 24 }, (_, i) => `tick${i + 1} `), gapMs: 600, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const ESC = String.fromCharCode(27)
const N = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sends = [
  after(1200, '\r'), // 0 New Session
  after(3600, 'stream slowly'), // 1
  after(4400, '\r'), // 2 → the paced turn (~14 s)
  after(6500, `${ESC}[1;2D`), // 3 ⇧← the board while it streams
  after(7500, '\t'), // 4 coordinator → LIST
  after(8300, '\r'), // 5 ↵ ARMS the selected row (L17's own road)
  ...[...'is it done'].map((ch, i) => after(9000 + i * 80, ch)), // 6..15 typed one key at a time
]
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', '16', '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      // THE HOSTED CAPTURE PROFILE MUST REACH THE ENGINE: a curated child
      // env drops the job-wide knob and ptydrive falls back to scale 1 -
      // authored-time sends race 3x-slow hosted boots (the undelivered-sends
      // class; gate run 3's arena zero-observation shapes). Forward it.
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: API_KEY,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_TABULA_DIR: join(home, 'tabula'),
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
    },
  },
)
let driverOut = ''
child.stdout.on('data', d => (driverOut += d))
child.stderr.on('data', d => (driverOut += d))
const killer = setTimeout(() => child.kill('SIGKILL'), 16_000 + 22_000)
await new Promise<void>(r => child.on('exit', () => r()))
clearTimeout(killer)
await api.close()
// exact-pid reap: runners from the records file, then the owned daemon.
const reaped: number[] = []
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    const raw = JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, { pid?: number }> }
    for (const rec of Object.values(raw.workers ?? {})) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM'); reaped.push(rec.pid) } catch {} }
  }
  const supFile = join(daemonDir, 'supervisor.json')
  if (existsSync(supFile)) {
    const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM'); reaped.push(pid) } catch {} }
  }
} catch {}
console.log(`  reaped pids: ${reaped.join(',') || 'none live'}`)

type Rec = { sent?: number; ts?: number }
const recs: Rec[] = existsSync(drive) ? readFileSync(drive, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
const at = (i: number): number => Math.round((sendRecs[i]?.sent ?? firstOut) - firstOut)
check('every send fired (the face, the chat, the board and the list all painted)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${driverOut.slice(-300)}` : ''}`)
if (sendRecs.length === sends.length) {
  const res = spawnSync('/usr/bin/python3', [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '120', '40', String(at(5) + 400), String(at(15) + 700), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(120_000), maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
  const [armedFrame, typedFrame, finalFrame] = screens
  const t = (g: { rows: string[] }): string => g.rows.join('\n')
  const legendRow = armedFrame.rows.find(r => /enters \(armed\)/.test(r)) ?? ''
  if (POISON_DIST === undefined) {
    check('↵ armed the row and the legend teaches the armed moves (type to message · esc disarm), no letter verb printed', /type to message/.test(legendRow) && /esc disarm/.test(legendRow) && !/i interrupt|p pause|m model/.test(legendRow), legendRow.trim().slice(0, 118))
    check('the words landed whole in the live composer', typedFrame.rows.some(r => /❯\s+is it done/.test(r)), typedFrame.rows.find(r => /❯/.test(r) && /done|it/.test(r))?.trim().slice(0, 100) ?? '(no draft row)')
    check('the streaming turn was NOT interrupted (no ⨯ Interrupted, no interrupted state on the row)', !/Interrupted|interrupted/.test(t(typedFrame)) && !/Interrupted|interrupted/.test(t(finalFrame)))
    check('split did not toggle (no width note from the s)', !/split needs/.test(t(typedFrame)))
  } else {
    check('POISON (pre-fix bundle): the i INTERRUPTED the streaming turn and the words did not land whole', /Interrupted|interrupted/.test(t(typedFrame) + t(finalFrame)) && !typedFrame.rows.some(r => /❯\s+is it done/.test(r)))
  }
}
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-letter-verb-yield: ALL LAWS HOLD' : `\nprove-letter-verb-yield: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
