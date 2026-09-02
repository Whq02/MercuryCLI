#!/usr/bin/env bun
// ============================================================================
//  prove-board-focus-owns-keys — NO KEY BELONGS TO TWO FOCUS STATES on the
//  Session Concourse board: the rows' declared single letters fire in every
//  list state (armed or not, draft held or not), and words reach a composer
//  only under that composer's own focus (tab or click, as its hint says).
//
// THE FIND (the operator's screenshot): with a session row ARMED, `n` typed
//  an n into the live composer — whose own hint still read "tab or click to
//  type" — instead of starting the session the pane header advertised
//  ("+ new session · n"). The armed state's text capture shadowed the board's
//  declared commands: every letter verb yielded to a type-through that moved
//  the focus by itself, and the armed footer did not even list n.
//
//  §1 the pure legend law — ONE resolver: the same verbs in every list
//     state, no 'type to message' row, the header's n follows the list focus
//     and the filter, the atlas key follows the focused composer's draft;
//  §2 the screen's wiring — no yield, the composer-focus gate between the
//     rows and the type-through, every verb guard plain, no implicit focus
//     move, the armed line says tab (or send, with a draft held);
//  §3 the DRIVE on the real bundle: arm a streaming row, press n — the
//     contract offer opens (the declared verb fired while armed); back on
//     the board, arm, TAB into the live composer, type "is it done" — the
//     words land whole and the streaming turn is never interrupted.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const ordered = (src: string, a: string, b: string): boolean => src.indexOf(a) !== -1 && src.indexOf(b) !== -1 && src.indexOf(a) < src.indexOf(b)

section('§1 the pure legend law — one resolver, every list state')
{
  const { regionKeysFor, newSessionTabLabel, helpKeyFiresFor, CONCOURSE_REGION_KEYS } = await import('../../src/components/concourse/controlManifest.js')
  const classes = ['live', 'paused', 'attached', 'queued', 'parked', 'stopped', 'door', 'none'] as const
  const isLetterVerb = (keys: string): boolean => /^[a-z\/]$/.test(keys) || keys === 'space'
  for (const selection of classes) {
    const plain = regionKeysFor('list', { newSession: true, selection })
    const armed = regionKeysFor('list', { newSession: true, selection, armed: true })
    const plainLetters = plain.map(k => k.keys).filter(isLetterVerb)
    const armedKeys = new Set(armed.map(k => k.keys))
    check(`${selection}: every letter verb the plain legend prints survives the arm (${plainLetters.join(' ')})`, plainLetters.every(l => armedKeys.has(l)), armed.map(k => k.keys).join(','))
    check(`${selection}: no 'type to message' row in any state`, !plain.some(k => k.keys === 'type') && !armed.some(k => k.keys === 'type'))
    const hadEnter = plain.some(k => k.keys === '↵↵')
    check(
      `${selection}: the arm relabels only ↵ ('enters (armed)') and → ('enter')`,
      (!hadEnter || armed.some(k => k.keys === '↵' && k.label === 'enters (armed)')) &&
        armed.every(k => k.keys !== '↵↵') &&
        (!plain.some(k => k.keys === '→') || armed.some(k => k.keys === '→' && k.label === 'enter')),
      armed.map(k => `${k.keys} ${k.label}`).join(' · '),
    )
    if (hadEnter) {
      const held = regionKeysFor('list', { newSession: true, selection, armed: true, liveDraftHeld: true })
      check(`${selection}: a held live draft makes the list's ↵ row 'send' (the draft-aware ↵ outranks the arm)`, held.some(k => k.keys === '↵' && k.label === 'send') && !held.some(k => k.label === 'enters (armed)'))
    }
  }
  check('the plain live-row legend still teaches n, i, p, m, e, r, s, space and /', ['n', 'i', 'p', 'm', 'e', 'r', 's', 'space', '/'].every(l => regionKeysFor('list', { newSession: true, selection: 'live' }).some(k => k.keys === l)))
  check("the list's space row is the mark and nothing else", CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'space' && k.label === 'mark'))
  check('the older drop-down still outranks the arm (one resolver, layered)', regionKeysFor('list', { newSession: true, selection: 'live', armed: true, olderBrowse: true }).every(k => k.label === 'bring it back'))
  check("the header's n prints exactly where the key fires: the rows, no filter typing", newSessionTabLabel({ region: 'list', filtering: false }) === '+ new session · n')
  check('…and not while the / filter captures', newSessionTabLabel({ region: 'list', filtering: true }) === '+ new session')
  check('…nor while a composer, the rail or the split pane holds focus (n is a letter there, or nothing)', ['live', 'coordinator', 'rail', 'chat'].every(r => newSessionTabLabel({ region: r, filtering: false }) === '+ new session'))
  check('the atlas key fires from the rows, the rail and the split pane whatever the drafts hold', ['list', 'rail', 'chat'].every(r => helpKeyFiresFor(r, false) && helpKeyFiresFor(r, true)))
  check('…and from a composer only while its draft is empty', helpKeyFiresFor('live', true) && !helpKeyFiresFor('live', false) && helpKeyFiresFor('coordinator', true) && !helpKeyFiresFor('coordinator', false))
}

section('§2 the screen carries the law — no yield, one gate, no implicit focus move')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  const GATE = "if (region !== 'coordinator' && region !== 'live') {"
  check('the letter-verb yield is gone from the screen (no module, no predicate)', !screen.includes('letterVerbsYield') && !screen.includes('verbsYield') && !existsSync(join(REPO, 'src', 'components', 'concourse', 'letterVerbYield.ts')))
  const listStart = screen.indexOf("if (region === 'list') {")
  const listEnd = screen.indexOf("if (region === 'chat') {", listStart)
  const list = screen.slice(listStart, listEnd)
  for (const letter of ['m', 'e', 'i', 'p', 'r', 'n', 's']) {
    check(`the ${letter} verb guard is plain (fires in every list state)`, new RegExp(`if \\(input === '${letter}' && !key\\.ctrl && !key\\.meta && (?!!verbsYield)`).test(list))
  }
  check('the / filter, the split nudges and the mark are plain too', list.includes("if (input === '/' && !key.ctrl && !key.meta) {") && list.includes("if ((input === '[' || input === ']') && !key.ctrl && !key.meta && splitActive && pastGate())") && list.includes("if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {"))
  check('the composer-focus gate stands between the rows and the type-through (after the chat pane block, before the composer side is chosen)', ordered(screen, "if (region === 'chat') {", GATE) && ordered(screen, GATE, 'const side =') && ordered(screen, GATE, 'side.edit(d => insertAt(d, payload))'))
  check('no keystroke moves the focus by itself (the type-through never re-targets the region)', !screen.includes('if (region !== side.focus) setRegion(side.focus)'))
  check("the atlas key decides with the one resolver the legend prints with", screen.includes("helpKeyFiresFor(region, (region === 'coordinator' ? draftRef : liveDraftRef).current.text.length === 0)") && layout.includes("helpKeyFiresFor(region, region === 'coordinator' ? coordinatorDraftEmpty : liveDraftEmpty)"))
  check('the armed line says tab (the words road) and, with a draft held, send', screen.includes("'armed — ↵ again enters'") && screen.includes("' · tab to message'") && screen.includes("'armed — ↵ sends the draft · → enters'") && !screen.includes('type to message'))
  check('the layout hands the arm and the held draft to the one resolver and relabels esc "disarm" while armed', layout.includes('armed: armedSelected, liveDraftHeld: !liveDraftEmpty') && /armedSelected && k\.keys === 'esc'\s*\?\s*\{ keys: k\.keys, label: 'disarm' \}/.test(layout) && !layout.includes("label: 'enters (armed)' }\n                                : k"))
  check("the header's tab label rides the one resolver", layout.includes('{newSessionTabLabel({ region, filtering })}') && !layout.includes('+ new session · n\n'))
  const strip = read('src/components/concourse/ConcourseStrips.tsx')
  check("the live composer's own hint still names the road the law honors", strip.includes("'tab or click to type'"))
}

section('§3 the drive: arm a streaming row, n opens the contract offer; arm, tab, type — the words land whole')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`✗ the PTY drive needs the POSIX capture engine — ${driver.kind === 'unavailable' ? driver.reason : `driver ${driver.kind}`}`)
  process.exit(1)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const home = mkdtempSync(join(tmpdir(), 'board-focus-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'board-focus-cwd-')))
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
// The first session streams slowly for ~19 s so every later keystroke lands
// while a turn is live — the one state the old type-through interrupted.
const api = await startFixtureApi([
  { kind: 'paced', deltas: Array.from({ length: 32 }, (_, i) => `tick${i + 1} `), gapMs: 600, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const ESC = String.fromCharCode(27)
const N = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sends = [
  after(1200, '\r'), // 0 New Session
  after(3600, 'stream slowly'), // 1
  after(4400, '\r'), // 2 → the paced turn (~19 s)
  after(6500, `${ESC}[1;2D`), // 3 ⇧← the board while it streams
  after(7500, '\t'), // 4 coordinator → LIST
  after(8300, '\r'), // 5 ↵ ARMS the selected row
  after(9100, 'n'), // 6 the declared verb fires WHILE ARMED → the contract offer card
  after(10600, ESC), // 7 esc = "No, start it plain" → the second birth (its chat opens)
  after(14000, `${ESC}[1;2D`), // 8 ⇧← the board again
  after(15000, '\t'), // 9 coordinator → LIST
  after(15800, '\r'), // 10 ↵ ARMS the selected row
  after(16600, '\t'), // 11 TAB → the live composer (the explicit focus the hint names)
  ...[...'is it done'].map((ch, i) => after(17300 + i * 80, ch)), // 12..21 typed one key at a time
]
const TYPED_LAST = sends.length - 1
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  driver.python,
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', '21', '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      // The hosted capture profile must reach the engine: a curated child
      // env drops the job-wide knob and ptydrive falls back to scale 1.
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
const killer = setTimeout(() => child.kill('SIGKILL'), 21_000 + 22_000)
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
check('every send fired (the face, the chat, the board, the card and the composer all painted)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${driverOut.slice(-300)}` : ''}`)
if (sendRecs.length === sends.length) {
  const res = spawnSync(driver.python, [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '120', '40', String(at(5) + 400), String(at(6) + 800), String(at(TYPED_LAST) + 700), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(120_000), maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
  const [armedFrame, cardFrame, typedFrame, finalFrame] = screens
  const t = (g: { rows: string[] }): string => g.rows.join('\n')
  const legendRow = armedFrame.rows.find(r => /enters \(armed\)/.test(r)) ?? ''
  const headerOf = (g: { rows: string[] }): string => g.rows.find(r => /\+ new session/.test(r)) ?? ''
  check('↵ armed the row and the legend still teaches the letter verbs (i interrupt leads) — no typing row', /i interrupt/.test(legendRow) && /esc disarm/.test(legendRow) && !/type to message/.test(t(armedFrame)), legendRow.trim().slice(0, 118))
  check("the pane header advertises n while the rows hold focus (armed)", /\+ new session · n/.test(headerOf(armedFrame)), headerOf(armedFrame).trim().slice(0, 100))
  check('n fired WHILE ARMED: the contract offer card opened (the declared verb, not a typed letter)', /Start with a contract\?/.test(t(cardFrame)), cardFrame.rows.find(r => /contract/i.test(r))?.trim().slice(0, 110) ?? '(no card)')
  check('after tab the words landed whole in the live composer', typedFrame.rows.some(r => /❯\s+is it done/.test(r)), typedFrame.rows.find(r => /❯/.test(r) && /done|it/.test(r))?.trim().slice(0, 100) ?? '(no draft row)')
  check("the header stops advertising n while the composer holds focus (n is a letter there)", /\+ new session/.test(headerOf(typedFrame)) && !/\+ new session · n/.test(headerOf(typedFrame)), headerOf(typedFrame).trim().slice(0, 100))
  check('the streaming turn was NOT interrupted (no ⨯ Interrupted, no interrupted state on the row)', !/Interrupted|interrupted/.test(t(typedFrame)) && !/Interrupted|interrupted/.test(t(finalFrame)))
  check('split did not toggle (no width note from the s)', !/split needs/.test(t(typedFrame)))
}
rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-board-focus-owns-keys: ALL LAWS HOLD' : `\nprove-board-focus-owns-keys: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
