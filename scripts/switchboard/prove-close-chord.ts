#!/usr/bin/env bun
// ============================================================================
//  prove-close-chord — the board's close verb is ⌃x ⌃x, staged, and plain x
//  is typing everywhere (the operator's word).
//
//  THE FIND: on the Session Concourse the close key was the printable
//  letter x — and with a live composer on screen the composer consumed it:
//  the operator pressed x to close a highlighted session and typed x into
//  the live chat instead. No routing cleverness fixes a key that is also
//  legitimate typing, so the close verb left the printable plane whole: it
//  rides the app-wide ctrl+x chord leader as its own completion, staged
//  exactly as the old estate (stop — the row stays, wearing stopped and
//  the next step — then remove on the same gesture again).
//
//  §1 the registry road, pure (the real bindings through the real resolver:
//  the completion resolves, every neighboring completion keeps its meaning)
//  · §2 the seam and the mirror, pure · §3 source pins · §4 the DRIVE on
//  the real bundle: the poison letter types, the ladder arms → stops →
//  removes exactly the highlighted session, the neighbor and the draft
//  survive. POISON: MERCURY_CLOSE_CHORD_POISON_DIST=<pre-fix bundle> runs
//  §4 against the bundle where x was the verb and the chord did not exist,
//  and expects the recorded defect (x stops instead of typing; the chord
//  removes nothing).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const POISON_DIST = process.env.MERCURY_CLOSE_CHORD_POISON_DIST
const DIST = POISON_DIST ?? join(REPO, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

if (POISON_DIST === undefined) {
  section('§1 the registry road (the real bindings through the real resolver)')
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
  const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.js')
  const { parseBindings } = await import('../../src/keybindings/parser.js')
  const { resolveKeyWithChordState } = await import('../../src/keybindings/resolver.js')
  const globalBlock = DEFAULT_BINDINGS.find(b => b.context === 'Global')
  check('the Global block binds ctrl+x ctrl+x to concourse:closeSession', globalBlock?.bindings['ctrl+x ctrl+x'] === 'concourse:closeSession')
  const graphRow = (ACTION_GRAPH as Record<string, { contexts: readonly string[] }>)['concourse:closeSession']
  check('the action graph carries the row with its Global consumer', graphRow !== undefined && graphRow.contexts.length === 1 && graphRow.contexts[0] === 'Global')
  const bindings = parseBindings(DEFAULT_BINDINGS)
  const key = (over: Record<string, boolean>) => ({
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
    home: false, end: false, return: false, escape: false, ctrl: false,
    shift: false, fn: false, tab: false, backspace: false, delete: false,
    meta: false, super: false, isPasted: false, ...over,
  }) as import('../../src/ink/events/input-event.js').Key
  const contexts = ['Chat', 'Global'] // the REPL vantage's shape — Chat registered, Global always added
  const first = resolveKeyWithChordState('x', key({ ctrl: true }), contexts, bindings, null)
  check('a lone ctrl+x opens the chord (the leader unchanged)', first.type === 'chord_started')
  const pending = first.type === 'chord_started' ? first.pending : []
  const complete = resolveKeyWithChordState('x', key({ ctrl: true }), contexts, bindings, pending)
  check('ctrl+x again completes to concourse:closeSession', complete.type === 'match' && complete.action === 'concourse:closeSession')
  const palette = resolveKeyWithChordState('p', key({}), contexts, bindings, pending)
  check('ctrl+x p still opens the palette — every neighboring completion keeps its meaning', palette.type === 'match' && palette.action === 'app:commandPalette')
  const stray = resolveKeyWithChordState('q', key({}), contexts, bindings, pending)
  check('a stray completion cancels the chord (the disarm road — the interceptor consumes the suffix)', stray.type === 'chord_cancelled')
  const esc = resolveKeyWithChordState('', key({ escape: true }), contexts, bindings, pending)
  check('esc cancels the open chord one layer deep', esc.type === 'chord_cancelled')

  section('§2 the one-slot seam and the pending-chord mirror, pure')
  const slot = await import('../../src/services/concourse/closeChordSlot.js')
  slot.resetConcourseCloseChordForTesting()
  check('unclaimed: the completion declines silently and claims read false', (slot.invokeConcourseCloseChord(), !slot.concourseCloseChordClaimed()))
  let hits = 0
  const release = slot.claimConcourseCloseChord(() => { hits++ })
  slot.invokeConcourseCloseChord()
  check('claimed: the completion reaches the claiming board', hits === 1 && slot.concourseCloseChordClaimed())
  let second = 0
  const release2 = slot.claimConcourseCloseChord(() => { second++ })
  slot.invokeConcourseCloseChord()
  check('ONE slot: a later claim owns it whole (no stack)', hits === 1 && second === 1)
  release() // the stale release must not evict the live claim
  slot.invokeConcourseCloseChord()
  check('a stale release cannot evict the live claim', second === 2)
  release2()
  check('the live release empties the slot', !slot.concourseCloseChordClaimed())
  const mirror = await import('../../src/keybindings/pendingChordMirror.js')
  mirror.resetPendingChordMirrorForTesting()
  let pings = 0
  const unsub = mirror.subscribePendingChordMirror(() => { pings++ })
  const stroke = [{ key: 'x', ctrl: true, alt: false, shift: false, meta: false, super: false }]
  mirror.publishPendingChord(stroke as never)
  check('the mirror publishes the arm to its subscribers', pings === 1 && mirror.getPendingChordMirror() === (stroke as never))
  mirror.publishPendingChord(null)
  check('the mirror publishes the clear', pings === 2 && mirror.getPendingChordMirror() === null)
  unsub()
  mirror.resetPendingChordMirrorForTesting()

  section('§3 the wiring, at its source seams')
  const globalHooks = readFileSync(join(REPO, 'src', 'hooks', 'useGlobalKeybindings.tsx'), 'utf8')
  const routeSafeAt = globalHooks.indexOf("'app:openSurfaceSwitcher':")
  const routeSafeEnd = globalHooks.indexOf("{ context: 'Global', routeSafe: true }", routeSafeAt)
  const routeSafeBlock = globalHooks.slice(routeSafeAt, routeSafeEnd)
  check('the completion handler registers in the REPL world beside the ctrl+x c precedent, routeSafe (the covered board is the point)', routeSafeEnd !== -1 && routeSafeBlock.includes("'concourse:closeSession': () => {") && routeSafeBlock.includes('invokeConcourseCloseChord()'))
  const provider = readFileSync(join(REPO, 'src', 'keybindings', 'KeybindingProviderSetup.tsx'), 'utf8')
  check('the provider mirrors EVERY pending transition (the explicit road and the timeout clear)', provider.split('publishPendingChord(').length === 3)
  const screen = readFileSync(join(REPO, 'src', 'components', 'concourse', 'ConcourseScreen.tsx'), 'utf8')
  check('the board claims the slot at mount and releases by unmount cleanup', screen.includes('useEffect(() => claimConcourseCloseChord(() => closeChordRoutineRef.current()), [])'))
  check('the hint reads the MIRROR, never a provider of its own (the covered-provider truth)', screen.includes('useSyncExternalStore(subscribePendingChordMirror, getPendingChordMirror, getPendingChordMirror)'))
  check('the routine dispatches the queued withdraw FIRST (one completed gesture, the landed removeSession door)', /startsWith\('dispatch:'\)\)\s*\{\s*\/\/[^]*?one completed chord withdraws[^]*?callbacks\.removeSession\?\.\(sel\.sessionId\)/.test(screen))
  check('the stage matrix is two-sourced: the fresh window OR the settled stopped class advances to remove', screen.includes("if (staged || sel.state === 'stopped') {"))
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.js')
  const live = regionKeysFor('list', { newSession: true, selection: 'live' })
  check("the live row's legend advertises the chord with the staged truth", live.some(k => k.keys === '⌃x ⌃x' && k.label === 'stop · again removes'))
  const armed = regionKeysFor('list', { newSession: true, selection: 'live', armed: true })
  // Re-trued (the board-letters law): an armed row changes nothing about
  // what the letters and the chord do — the chord row keeps its STAGE-TRUE
  // label while armed (the old armed legend relabelled it 'close').
  check('the ARMED legend keeps the chord row with its stage-true label — no letter, no relabel', armed.some(k => k.keys === '⌃x ⌃x' && k.label === 'stop · again removes'))
  const docs = readFileSync(join(REPO, 'docs', 'SESSIONS.md'), 'utf8')
  check('docs/SESSIONS.md teaches the chord and the typing truth in the same breath', docs.includes('ctrl+x ctrl+x stops the selected') && docs.includes('typing is never a control'))
  check('docs/SESSIONS.md no longer advertises a bare-x board verb', !/`x` on a|`x` stops|second `x`/.test(docs))
}

section(POISON_DIST === undefined ? '§4 the drive: x types · the ladder arms → stops → removes exactly the highlighted row' : '§4 POISON: the pre-fix bundle — x stops instead of typing, the chord removes nothing')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const home = mkdtempSync(join(tmpdir(), 'close-chord-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'close-chord-cwd-')))
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
  { kind: 'paced', deltas: Array.from({ length: 40 }, (_, i) => `tick${i + 1} `), gapMs: 600, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const ESC = String.fromCharCode(27)
const CTRL_X = String.fromCharCode(24)
const BACKSPACE = String.fromCharCode(127)
const N = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
// DETERMINISM (the capsule law): a FRESH board mount always lands region
// 'coordinator' (no capsule) — but a re-entry restores whatever region the
// board was LEFT in, so every mid-scene exit must leave a KNOWN region.
// The scene therefore touches the board ONCE before the birth (entering
// and leaving without a single keystroke — the capsule then holds
// coordinator + the session-1 selection, both known), births session 2
// from the BOOT FACE (its New Session row, the one deterministic birth),
// and does all board work on the second entry: tab lands LIST from the
// known coordinator, ↓ steps from the known session-1 row onto the
// streamer. Every keystroke's region is derivable from the script alone.
const sends = [
  after(1200, '\r'), // 0 New Session — session 1, the NEIGHBOR (never touched)
  after(3400, `${ESC}[1;2D`), // 1 ⇧← the board (fresh mount: coordinator region)
  after(4600, `${ESC}[1;2D`), // 2 ⇧← on to the BOOT FACE (the board leaves wearing known state)
  after(5800, '\r'), // 3 the face's New Session row — session 2 born, its chat focused
  after(8000, 'stream slowly'), // 4 typed into session 2's chat
  after(8800, '\r'), // 5 → the paced turn (~24 s of streaming)
  after(10800, `${ESC}[1;2D`), // 6 ⇧← the board — capsule: coordinator + session 1 selected
  after(11600, '\t'), // 7 tab: coordinator → LIST (deterministic from the capsule)
  after(12400, `${ESC}[B`), // 8 ↓ from the session-1 row onto the WORKING row (the streamer)
  // THE COMPOSER'S OWN FOCUS (the board-letters law): typing reaches the
  // live composer only while it holds focus — the rows carry verbs, never
  // words, and no letter flows through from them. One more tab moves the
  // focus from the rows to the live composer (its own hint: tab to type);
  // the selection stays on the working row, which is the composer's target.
  after(13000, '\t'), // 9 tab: LIST → the LIVE composer (the selection stays on the working row)
  after(13400, 'x'), // 10 THE POISON LETTER — must TYPE into the focused composer (pre-fix: it stopped)
  after(15600, BACKSPACE), // 11 clear the typed x
  ...[...'keep me'].map((ch, i) => after(16200 + i * 80, ch)), // 12..18 the draft that must survive
  after(18000, CTRL_X), // 19 arm — the confirm hint paints
  after(19300, 'q'), // 20 other input disarms (the chord eats the suffix; the draft stays whole)
  after(21000, CTRL_X), // 21 arm again
  after(21450, CTRL_X), // 22 complete — THE STOP STAGE (the row stays, wearing stopped)
  after(25000, CTRL_X), // 23 arm — the hint now speaks the REMOVE stage
  after(25900, CTRL_X), // 24 complete — THE REMOVE STAGE (exactly this row leaves)
]
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', '31', '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
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
const killer = setTimeout(() => child.kill('SIGKILL'), 31_000 + 22_000)
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
check('every send fired (the face, both chats and the board all painted)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${driverOut.slice(-300)}` : ''}`)
if (sendRecs.length === sends.length) {
  // The capture offsets ride the RUNTIME send indices (the focus tab at
  // index 9 shifted every later send by one): x=10, arm=19, disarm=20,
  // stop-complete=22, remove-arm=23, remove-complete=24.
  const times = [at(10) + 1800, at(19) + 500, at(20) + 600, at(22) + 3000, at(23) + 400, at(24) + 2500]
  const res = spawnSync('/usr/bin/python3', [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '120', '40', ...times.map(String), '-1'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
  const [xFrame, armFrame, disarmFrame, stopFrame, removeArmFrame, goneFrame] = screens
  const t = (g: { rows: string[] }): string => g.rows.join('\n')
  // The painted chord is host-spelled (off macOS "ctrl+x"): every frame
  // needle reads through the ONE platform-aware owner.
  const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
  if (POISON_DIST === undefined) {
    check('POISON LETTER: plain x TYPED into the live composer (the defect retired)', xFrame.rows.some(r => /❯\s+x\b/.test(r)), xFrame.rows.find(r => /❯/.test(r))?.trim().slice(0, 90) ?? '(no composer row)')
    check('…and stopped NOTHING (the stream runs on, no stop receipt)', !/STOPPED|stopped —/i.test(t(xFrame)))
    check('ARM: the first ⌃x paints the stage-true confirm on the row', t(armFrame).includes(keyHintLabel('⌃x again stops — esc keeps it')), t(armFrame).match(/⌃x[^\n]*/)?.[0]?.slice(0, 90) ?? '(no hint row)')
    check('DISARM: other input clears the hint, closes nothing, and the draft survives whole', !t(disarmFrame).includes(keyHintLabel('⌃x again stops')) && !/STOPPED/i.test(t(disarmFrame)) && disarmFrame.rows.some(r => /❯\s+keep me(\s|$)/.test(r)), disarmFrame.rows.find(r => /❯/.test(r))?.trim().slice(0, 90) ?? '(no composer row)')
    check('STOP STAGE: the completed chord stopped the highlighted row — it STAYS, wearing stopped', /STOPPED/i.test(t(stopFrame)) && /stream slowly/.test(t(stopFrame)))
    check("…and the standing line advertises the next step in the new key's spelling", t(stopFrame).includes(keyHintLabel('⌃x ⌃x removes it')))
    check('…and the draft still stands', stopFrame.rows.some(r => /❯\s+keep me(\s|$)/.test(r)))
    check('REMOVE ARM: the hint now speaks the remove stage', t(removeArmFrame).includes(keyHintLabel('⌃x again removes it from the board')))
    check('REMOVE: exactly the highlighted session left the board', !/stream slowly/.test(t(goneFrame)))
    check('…the NEIGHBOR survives untouched (its row still stands)', /●\s+new session/.test(t(goneFrame)) && !/no sessions running/.test(t(goneFrame)))
    check('…and the draft survives the whole ladder un-mangled', goneFrame.rows.some(r => /❯\s+keep me(\s|$)/.test(r)))
  } else {
    check(
      'POISON (pre-fix bundle): the bare x was a VERB — it stopped the streaming session instead of typing',
      /STOPPED|stopped — x again/i.test(t(xFrame)) && !xFrame.rows.some(r => /❯\s+x\b/.test(r)),
      `stop-ish: ${xFrame.rows.filter(r => /stop/i.test(r)).map(r => r.trim().slice(0, 80)).join(' | ') || 'none'} · composer: ${xFrame.rows.find(r => /❯/.test(r))?.trim().slice(0, 80) ?? 'none'}`,
    )
    check('POISON: the chord did not exist — the row is STILL on the board after both completed gestures', /stream slowly/.test(t(goneFrame)))
  }
}
if (process.env.MERCURY_CLOSE_CHORD_KEEP === '1') {
  console.log(`  kept for inspection: ${drive}`)
} else {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-close-chord: ALL LAWS HOLD' : `\nprove-close-chord: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
