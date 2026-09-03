#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { driveWallSeconds, driverClosed, unfiredDetail } from '../lib/ptydriveReport.ts'

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
  const contexts = ['Chat', 'Global']
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
  release()
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
  const parkedArm = screen.indexOf("if (sel.state === 'parked') {")
  const stoppedArm = screen.indexOf("if (sel.state === 'stopped') {")
  const parkedBlock = parkedArm !== -1 && stoppedArm !== -1 ? screen.slice(parkedArm, stoppedArm) : ''
  const stoppedBlock = stoppedArm !== -1 ? screen.slice(stoppedArm, screen.indexOf('if (staged) {', stoppedArm)) : ''
  const stagedArm = screen.indexOf('if (staged) {', stoppedArm)
  const stopStage = screen.indexOf('lastStopRef.current = { sessionId: sel.sessionId, at: Date.now() }', stagedArm)
  const stagedBlock = stagedArm !== -1 && stopStage !== -1 ? screen.slice(stagedArm, stopStage) : ''
  check('the stage matrix is the ladder: stopped ARCHIVES (the record stands), parked inside the window DELETES (the record ends), a row still going down gets its stop re-sent and never ends', stoppedBlock.includes('callbacks.archiveSession?.(sel.sessionId)') && !stoppedBlock.includes('removeSession') && parkedBlock.includes('callbacks.removeSession?.(sel.sessionId)') && stagedBlock.includes('callbacks.stopSession?.(sel.sessionId)') && !stagedBlock.includes('removeSession'))
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.js')
  const live = regionKeysFor('list', { newSession: true, selection: 'live' })
  check("the live row's legend advertises the chord with the staged truth", live.some(k => k.keys === '⌃x ⌃x' && k.label === 'stop · archive · delete'))
  const armed = regionKeysFor('list', { newSession: true, selection: 'live', armed: true })
  check('the ARMED legend keeps the chord row with its stage-true label — no letter, no relabel', armed.some(k => k.keys === '⌃x ⌃x' && k.label === 'stop · archive · delete'))
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
const sends = [
  after(1200, '\r'),
  after(3400, `${ESC}[1;2D`),
  after(4600, `${ESC}[1;2D`),
  after(5800, '\r'),
  after(8000, 'stream slowly'),
  after(8800, '\r'),
  after(10800, `${ESC}[1;2D`),
  after(11600, '\t'),
  after(12400, `${ESC}[B`),
  after(13000, '\t'),
  after(13400, 'x'),
  after(15600, BACKSPACE),
  ...[...'keep me'].map((ch, i) => after(16200 + i * 80, ch)),
  after(18000, CTRL_X),
  after(19300, 'q'),
  after(21000, CTRL_X),
  after(21450, CTRL_X),
  after(25000, CTRL_X),
  after(25900, CTRL_X),
  after(28400, CTRL_X),
  after(28850, CTRL_X),
]
const WALL_S = driveWallSeconds(sends, { tailMs: 2500 })
const drive = join(home, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  '/usr/bin/python3',
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', String(WALL_S), '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'xterm-256color',
      MERCURY_SPLASH: 'off',
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
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(WALL_S * 1000) + 22_000)
await driverClosed(child)
clearTimeout(killer)
await api.close()
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
check('every send fired (the face, both chats and the board all painted)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${unfiredDetail(driverOut)}` : ''}`)
if (sendRecs.length === sends.length) {
  const stopAt = at(22)
  const receiptAt = [1000, 2000, 3000].map(o => stopAt + o)
  const times = [at(10) + 1800, at(19) + 500, at(20) + 600, ...receiptAt, at(23) + 400, at(24) + 2500, at(25) + 400, at(26) + 2500]
  const res = spawnSync('/usr/bin/python3', [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '120', '40', ...times.map(String), '-1'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
  const frameAt = (ms: number): { atMs: number; rows: string[] } => screens.find(g => g.atMs === ms) ?? { atMs: ms, rows: [] }
  const xFrame = frameAt(at(10) + 1800)
  const armFrame = frameAt(at(19) + 500)
  const disarmFrame = frameAt(at(20) + 600)
  const receiptFrames = receiptAt.map(frameAt)
  const stopFrame = frameAt(stopAt + 3000)
  const archiveArmFrame = frameAt(at(23) + 400)
  const parkedFrame = frameAt(at(24) + 2500)
  const deleteArmFrame = frameAt(at(25) + 400)
  const goneFrame = frameAt(at(26) + 2500)
  const t = (g: { rows: string[] }): string => g.rows.join('\n')
  const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
  if (POISON_DIST === undefined) {
    check('POISON LETTER: plain x TYPED into the live composer (the defect retired)', xFrame.rows.some(r => /❯\s+x\b/.test(r)), xFrame.rows.find(r => /❯/.test(r))?.trim().slice(0, 90) ?? '(no composer row)')
    check('…and stopped NOTHING (the stream runs on, no stop receipt)', !/STOPPED|stopped —/i.test(t(xFrame)))
    check('ARM: the first ⌃x paints the stage-true confirm on the row', t(armFrame).includes(keyHintLabel('⌃x again stops — esc keeps it')), t(armFrame).match(/⌃x[^\n]*/)?.[0]?.slice(0, 90) ?? '(no hint row)')
    check('DISARM: other input clears the hint, closes nothing, and the draft survives whole', !t(disarmFrame).includes(keyHintLabel('⌃x again stops')) && !/STOPPED/i.test(t(disarmFrame)) && disarmFrame.rows.some(r => /❯\s+keep me(\s|▌|$)/.test(r)), disarmFrame.rows.find(r => /❯/.test(r))?.trim().slice(0, 90) ?? '(no composer row)')
    const stopWords = (g: { rows: string[] }): string => g.rows.filter(r => /stopp|park|⌃x|ctrl\+x|stream slowly/i.test(r)).map(r => r.trim().slice(0, 150)).join(' | ')
    check('STOP STAGE: the completed chord stopped the highlighted row — it STAYS, wearing stopped', /\bstopped\s+stream slowly/.test(t(stopFrame)), stopWords(stopFrame))
    const receiptWords = (g: { rows: string[] }): boolean => t(g).includes('applied — stop sent — ') || t(g).includes(keyHintLabel('stopped — ⌃x ⌃x archives it'))
    check("…and the composer's receipt spoke the stop verb's detail inside its beat", receiptFrames.some(receiptWords), receiptFrames.map(g => `+${g.atMs - stopAt}ms: ${g.rows.find(r => /applied|refused|failed/.test(r))?.trim().slice(0, 110) ?? '(no receipt row)'}`).join(' | '))
    const receiptRows = receiptFrames.map(g => `+${g.atMs - stopAt}ms: ${g.rows.find(r => /applied|refused|failed/.test(r))?.trim().slice(0, 110) ?? '(no receipt row)'}`).join(' | ')
    check('…and once the row reads stopped the receipt advances to the removal hint', receiptFrames.some(g => t(g).includes(keyHintLabel('stopped — ⌃x ⌃x archives it')) && /\bstopped\s+stream slowly/.test(t(g))), receiptRows)
    const draftRows = (g: { rows: string[] }): string => g.rows.filter(r => /❯|keep me|tab or click/.test(r)).map(r => r.trim().slice(0, 120)).join(' | ')
    check('…and the draft still stands', stopFrame.rows.some(r => /❯\s+keep me(\s|▌|$)/.test(r)), draftRows(stopFrame))
    check('ARCHIVE ARM: the hint now speaks the archive rung', t(archiveArmFrame).includes(keyHintLabel('⌃x again archives it (the chat stands parked)')), stopWords(archiveArmFrame))
    check('ARCHIVE: the row STAYS on the board, parked — the record stands', /stream slowly/.test(t(parkedFrame)) && /parked/i.test(t(parkedFrame)), stopWords(parkedFrame))
    check('DELETE ARM: the hint now speaks the delete rung', t(deleteArmFrame).includes(keyHintLabel('⌃x again deletes it (the record ends)')), stopWords(deleteArmFrame))
    check('DELETE: exactly the highlighted session left the board', !/stream slowly/.test(t(goneFrame)))
    check('…the NEIGHBOR survives untouched (its row still stands)', /●\s+new session/.test(t(goneFrame)) && !/no sessions running/.test(t(goneFrame)))
    check('…and the draft survives the whole ladder un-mangled', goneFrame.rows.some(r => /❯\s+keep me(\s|▌|$)/.test(r)), draftRows(goneFrame))
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
