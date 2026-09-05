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

  section('§2b the stage window — one owner, one clock')
  const { createCloseChordStage, CLOSE_CHORD_STAGE_WINDOW_MS } = await import('../../src/services/concourse/closeChordStage.js')
  check('the product window is the ruled 5 s (generous for the full ⌃x ⌃x repeat)', CLOSE_CHORD_STAGE_WINDOW_MS === 5000)
  {
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    const stage = createCloseChordStage(80)
    let pings = 0
    const off = stage.subscribe(() => { pings++ })
    check('nothing stands before an arm', stage.read() === null && !stage.standsFor('a'))
    stage.arm('a')
    check('an arm stands for its row and no other, and tells the subscriber', stage.standsFor('a') && !stage.standsFor('b') && !stage.standsFor(null) && !stage.standsFor(undefined) && pings === 1)
    const first = stage.read()
    check('the snapshot is one stable reference between changes', stage.read() === first && first?.sessionId === 'a')
    await sleep(40)
    check('inside the window it still stands, unchanged', stage.standsFor('a') && stage.read() === first)
    stage.arm('a')
    check('a re-arm restarts the window (a fresh snapshot, another ping)', stage.read() !== first && pings === 2)
    await sleep(60)
    check('…so 100 ms after the first arm and 60 after the second it still stands', stage.standsFor('a'))
    await sleep(45)
    check('THE WINDOW ENDS BY ITSELF: past its length the stage is gone and the subscriber was told — no clock is read at read time', !stage.standsFor('a') && stage.read() === null && pings === 3)
    stage.arm('a')
    stage.clear()
    check('a clear ends it at once and pings', stage.read() === null && pings === 5)
    stage.clear()
    check('a clear on nothing is silent', pings === 5)
    stage.arm('b')
    stage.dispose()
    await sleep(100)
    check('dispose drops the stage, its timer and every listener', stage.read() === null && pings === 6)
    off()
  }

  section('§2c the ladder — one owner for the act and the words')
  const m = await import('../../src/components/concourse/controlManifest.js')
  const { keyHintLabel: hostLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
  type Cls = Parameters<typeof m.closeChordRungOf>[0]
  check('the ladder from a running row: stop, then archive, then delete — one rung per settled class', m.closeChordRungOf('live', false) === 'stop' && m.closeChordRungOf('paused', false) === 'stop' && m.closeChordRungOf('attached', false) === 'stop' && m.closeChordRungOf('stopped', false) === 'archive' && m.closeChordRungOf('parked', true) === 'delete')
  check('the stage decides only where the row has not settled: a fresh chord on a long-parked row ARMS; a staged press over a live runner re-sends the stop; a stopped row archives either way', m.closeChordRungOf('parked', false) === 'arm-delete' && m.closeChordRungOf('live', true) === 'resend-stop' && m.closeChordRungOf('stopped', true) === 'archive')
  check('a queued reservation withdraws on one chord; doors and no selection close nothing', m.closeChordRungOf('queued', false) === 'withdraw' && m.closeChordRungOf('queued', true) === 'withdraw' && m.closeChordRungOf('door', true) === 'none' && m.closeChordRungOf('none', false) === 'none')
  const rungs = ['withdraw', 'stop', 'resend-stop', 'archive', 'arm-delete', 'delete'] as const
  check('every rung has a leader hint that starts with the completion and a legend label; none has neither', rungs.every(r => (m.closeChordHintOf(r) ?? '').startsWith('⌃x again ') && m.closeChordLegendOf(r) !== null) && m.closeChordHintOf('none') === null && m.closeChordLegendOf('none') === null)
  check('the hint names the rung the press takes: stops · re-sends the stop · archives · arms the delete · deletes · withdraws', /stops/.test(m.closeChordHintOf('stop') ?? '') && /re-sends the stop/.test(m.closeChordHintOf('resend-stop') ?? '') && /archives it/.test(m.closeChordHintOf('archive') ?? '') && /arms the delete/.test(m.closeChordHintOf('arm-delete') ?? '') && /deletes it/.test(m.closeChordHintOf('delete') ?? '') && /withdraws/.test(m.closeChordHintOf('withdraw') ?? ''))
  check('the arm hint and its receipt name the window in seconds and what remains (one more chord ends the record), short enough for the row line on every host', m.closeChordHintOf('arm-delete') === '⌃x again arms the delete · ⌃x ⌃x in 5 s ends it' && m.closeChordReceiptOf('arm-delete') === '⌃x ⌃x within 5 s deletes it' && hostLabel(m.closeChordHintOf('arm-delete') ?? '', 'windows').length <= 60)
  check('the only other board-side receipt is the re-sent stop; every verb rung leaves its receipt to the daemon\'s answer', /stop is on its way/.test(m.closeChordReceiptOf('resend-stop') ?? '') && m.closeChordReceiptOf('stop') === null && m.closeChordReceiptOf('archive') === null && m.closeChordReceiptOf('delete') === null && m.closeChordReceiptOf('withdraw') === null)
  check('the legend is the ladder\'s remainder: live "stop · archive · delete" · stopped "archive · delete" · parked fresh "arm · delete" · parked staged "delete" · queued "withdraw"', m.closeChordLegendOf('stop') === 'stop · archive · delete' && m.closeChordLegendOf('resend-stop') === 'stop · archive · delete' && m.closeChordLegendOf('archive') === 'archive · delete' && m.closeChordLegendOf('arm-delete') === 'arm · delete' && m.closeChordLegendOf('delete') === 'delete' && m.closeChordLegendOf('withdraw') === 'withdraw')
  const chordOf = (selection: Cls, chordStaged?: boolean): string | undefined =>
    m.regionKeysFor('list', { newSession: true, selection, ...(chordStaged === undefined ? {} : { chordStaged }) }).find(k => k.keys === '⌃x ⌃x')?.label
  check('the list legend reads the same owner per class and stage (no label authored beside it)', chordOf('live') === 'stop · archive · delete' && chordOf('paused') === 'stop · archive · delete' && chordOf('attached') === 'stop · archive · delete' && chordOf('stopped') === 'archive · delete' && chordOf('parked') === 'arm · delete' && chordOf('parked', false) === 'arm · delete' && chordOf('parked', true) === 'delete' && chordOf('queued') === 'withdraw' && chordOf('door') === undefined && chordOf('none') === undefined)
  check('the parked legend still leads with its one move — "parked · ↵ brings it back" — one press', m.regionKeysFor('list', { newSession: true, selection: 'parked' }).some(k => `${k.keys} ${k.label}` === 'parked · ↵ brings it back'))

  section('§2d a stopped record STANDS — the quit sweep never parks it')
  {
    const sup = await import('../../src/daemon/concourseSupervisor.js')
    const dir = mkdtempSync(join(tmpdir(), 'close-chord-records-'))
    const now = Date.now()
    sup.updateConcourseWorkers(w => {
      w['concourse-w1'] = { schema: 1, runnerId: 'concourse-w1', sessionId: 'sess-stopped', workspaceId: dir, isolation: 'shared', modelKey: 'm', spawnedAt: now - 60_000, lastDeliveryAt: now - 50_000, stoppedAt: now - 30_000, stoppedBy: 'operator' } as never
    }, dir)
    const receipt = sup.parkAllConcourseSessions('operator:probe', undefined, dir)
    const rec = sup.readSessionWorkers(dir)['concourse-w1']
    check('C4 park-all (the quit sweep, the orphan reap) SKIPS a stopped record: it stands stopped, never parked, never ended', receipt.skipped.includes('concourse-w1') && receipt.parked.length === 0 && rec?.parkedAt === undefined && rec?.endedAt === undefined && rec?.stoppedAt !== undefined, JSON.stringify(receipt))
    rmSync(dir, { recursive: true, force: true })
  }

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
  check('the hint reads the STAGE through its own subscription (the window\'s end repaints it) and spells the rung from the one owner', screen.includes('useSyncExternalStore(closeChordStage.subscribe, closeChordStage.read, closeChordStage.read)') && screen.includes('closeChordHintOf(closeChordRungOf(boardSelectionClassOf(peekSelRow), closeChordStaged))'))
  const gestureAt = screen.indexOf('const closeChordGesture = (): void => {')
  const gesture = gestureAt !== -1 ? screen.slice(gestureAt, screen.indexOf('const closeChordRoutineRef', gestureAt)) : ''
  const rungBlock = (rung: string): string => {
    const at = gesture.indexOf(`case '${rung}':`)
    if (at === -1) return ''
    const next = gesture.indexOf('case ', at + 6)
    return gesture.slice(at, next === -1 ? undefined : next)
  }
  check('the routine reads the rung from the one owner: the row\'s class and the stage', gesture.includes('closeChordRungOf(boardSelectionClassOf(sel), closeChordStage.standsFor(sel.sessionId))'))
  check('withdraw: one completed gesture, the landed removeSession door', rungBlock('withdraw').includes('callbacks.removeSession?.(sel.sessionId)'))
  check('stop: arms the window and dispatches the stop — nothing else', rungBlock('stop').includes('closeChordStage.arm(sel.sessionId)') && rungBlock('stop').includes('callbacks.stopSession?.(sel.sessionId)') && !rungBlock('stop').includes('removeSession') && !rungBlock('stop').includes('archiveSession'))
  check('re-sent stop: says where the stop stands and re-sends it; never removes', rungBlock('resend-stop').includes('callbacks.stopSession?.(sel.sessionId)') && !rungBlock('resend-stop').includes('removeSession'))
  check('archive: arms the window and parks the stopped row — the record stands', rungBlock('archive').includes('closeChordStage.arm(sel.sessionId)') && rungBlock('archive').includes('callbacks.archiveSession?.(sel.sessionId)') && !rungBlock('archive').includes('removeSession'))
  check('arm-delete: arms the window and speaks its receipt — no daemon verb', rungBlock('arm-delete').includes('closeChordStage.arm(sel.sessionId)') && !rungBlock('arm-delete').includes('callbacks.'))
  check('delete: closes the stage, drops the arm\'s note with the row, ends the record', rungBlock('delete').includes('closeChordStage.clear()') && rungBlock('delete').includes('setNote(prev => (prev?.row === sel.sessionId ? null : prev))') && rungBlock('delete').includes('callbacks.removeSession?.(sel.sessionId)'))
  check('no stage lives outside its owner: the screen keeps no clock of its own', !screen.includes('lastStopRef') && !screen.includes('CLOSE_CHORD_STAGE_WINDOW_MS'))
  check('C3 a row-keyed note clears when the selection leaves it or the row leaves the board', screen.includes('if (boardSel !== note.row || !sessionRows.some(r => r.sessionId === note.row)) setNote(null)') && /setNote\(\{ tone: 'muted', text: keyHintLabel\(receipt\), row: sel\.sessionId \}\)/.test(gesture))
  check('C1 a PARKED row enters on ONE ↵ (no composer target to arm) — the screen agrees with its hints', screen.includes("const parked = sessionRows.find(r => r.sessionId === sessionId)?.state === 'parked'") && screen.includes('if (!reducedStage && !parked && opts.pointer !== true && boardArmedRef.current !== sessionId) {'))
  check('C1 the composer gate says one ↵ on a parked row; no hint on the board says ↵↵ for it', screen.includes("'parked — ↵ brings it back; a sleeping chat takes no queue'") && !screen.includes('↵↵ brings it back'))
  const layout = readFileSync(join(REPO, 'src', 'components', 'concourse', 'ConcourseLayout.tsx'), 'utf8')
  check('C1 the live composer\'s ↵ label follows the selected row\'s class: one press brings a parked row back', layout.includes("{ keys: '↵', label: 'brings it back' }") && layout.includes("? { keys: '↵', label: 'open' }") && layout.includes('chordStaged: closeChordStaged'))
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.js')
  const live = regionKeysFor('list', { newSession: true, selection: 'live' })
  check("the live row's legend advertises the chord with the staged truth", live.some(k => k.keys === '⌃x ⌃x' && k.label === 'stop · archive · delete'))
  const armed = regionKeysFor('list', { newSession: true, selection: 'live', armed: true })
  check('the ARMED legend keeps the chord row with its stage-true label — no letter, no relabel', armed.some(k => k.keys === '⌃x ⌃x' && k.label === 'stop · archive · delete'))
  const docs = readFileSync(join(REPO, 'docs', 'SESSIONS.md'), 'utf8')
  check('docs/SESSIONS.md teaches the chord and the typing truth in the same breath', docs.includes('ctrl+x ctrl+x stops the selected') && docs.includes('typing is never a control'))
  check('docs/SESSIONS.md no longer advertises a bare-x board verb', !/`x` on a|`x` stops|second `x`/.test(docs))
  const driveMembers = readFileSync(join(REPO, 'scripts', 'switchboard-drives', 'members.txt'), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#') && l !== 'prove-close-chord.ts')
  const retiredRungWords = [/same chord again removes/, /chord again removes it/, /REMOVE stage/, /remove-arm/, /remove-complete/, /stop, then remove/, /the same chord again \(/]
  const offenders = driveMembers.filter(name => existsSync(join(REPO, 'scripts', 'switchboard', name)) && retiredRungWords.some(rx => rx.test(readFileSync(join(REPO, 'scripts', 'switchboard', name), 'utf8'))))
  check('C5 no real-terminal drive still spells the retired two-rung chord (stop, then remove)', offenders.length === 0, offenders.join(', ') || 'none')
  const reap = readFileSync(join(REPO, 'scripts', 'switchboard', 'prove-reap-focus-drive.ts'), 'utf8')
  check('C5 the reap drive walks the three rungs — stop, archive, delete — each its own completed chord', reap.includes('THE STOP RUNG') && reap.includes('THE ARCHIVE RUNG') && reap.includes('THE DELETE RUNG') && reap.split('data: CTRL_X').length === 7)
}

section(POISON_DIST === undefined ? '§4 the drive: x types · the ladder stops → archives → deletes exactly the highlighted row · the window, the note, the parked row\'s one ↵' : '§4 POISON: the pre-fix bundle — x stops instead of typing, the chord removes nothing')
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
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
  { kind: 'paced', deltas: Array.from({ length: 40 }, (_, i) => `tick${i + 1} `), gapMs: 600, whenModel: 'opus' },
  { kind: 'text', text: 'Spare.', whenModel: 'opus' },
])
const ESC = String.fromCharCode(27)
const CTRL_X = String.fromCharCode(24)
const BACKSPACE = String.fromCharCode(127)
const N = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sendList: string[] = []
const mark: Record<string, number> = {}
const send = (name: string | undefined, ms: number, payload: string): void => {
  if (name !== undefined) mark[name] = sendList.length
  sendList.push(after(ms, payload))
}
send(undefined, 1200, '\r')
;[...'neighbour ready'].forEach((ch, i) => send(undefined, 3400 + i * 60, ch))
send(undefined, 4600, '\r')
send(undefined, 6000, `${ESC}[1;2D`)
send(undefined, 7200, `${ESC}[1;2D`)
send(undefined, 8400, '\r')
send(undefined, 10600, 'stream slowly')
send(undefined, 11400, '\r')
send(undefined, 13400, `${ESC}[1;2D`)
send(undefined, 14200, '\t')
send(undefined, 15000, `${ESC}[B`)
send(undefined, 15600, '\t')
send('x', 16000, 'x')
send(undefined, 18200, BACKSPACE)
;[...'keep me'].forEach((ch, i) => send(undefined, 18800 + i * 80, ch))
send('arm', 20600, CTRL_X)
send('disarm', 21900, 'q')
send(undefined, 23600, CTRL_X)
send('stop', 24050, CTRL_X)
send('archiveArm', 35100, CTRL_X)
send('archive', 36000, CTRL_X)
send('flipLeader', 39800, CTRL_X)
send('lateLeader', 45200, CTRL_X)
send('lateArm', 46100, CTRL_X)
send('deleteLeader', 47700, CTRL_X)
send('delete', 48600, CTRL_X)
;[...Array(7)].forEach((_, i) => send(undefined, 51800 + i * 80, BACKSPACE))
send(undefined, 52800, `${ESC}[A`)
send(undefined, 53700, CTRL_X)
send('nStop', 54100, CTRL_X)
send(undefined, 57100, CTRL_X)
send('nArchive', 57500, CTRL_X)
send('enter', 60700, '\r')
const sends = sendList
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
const at = (name: string): number => Math.round((sendRecs[mark[name] ?? -1]?.sent ?? firstOut) - firstOut)
check('every send fired (the face, both chats and the board all painted)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${unfiredDetail(driverOut)}` : ''}`)
if (sendRecs.length === sends.length) {
  const stopAt = at('stop')
  const receiptAt = [1000, 2000, 3000, 4500, 6000].map(o => stopAt + o)
  const grabs = {
    x: at('x') + 1800,
    disarm: at('disarm') + 600,
    stand: stopAt + 10_000,
    parked: at('archive') + 2500,
    flipOut: at('flipLeader') + 1700,
    lateArm: at('lateArm') + 700,
    gone: at('delete') + 2500,
    nParked: at('nArchive') + 2500,
    entered: at('enter') + 2500,
  }
  const LEADER_OFFSETS = [300, 500, 700]
  const leaderSeries = {
    arm: LEADER_OFFSETS.map(o => at('arm') + o),
    archiveArm: LEADER_OFFSETS.map(o => at('archiveArm') + o),
    flipIn: LEADER_OFFSETS.map(o => at('flipLeader') + o),
    lateLeader: LEADER_OFFSETS.map(o => at('lateLeader') + o),
    deleteArm: LEADER_OFFSETS.map(o => at('deleteLeader') + o),
  }
  const times = [...receiptAt, ...Object.values(grabs), ...Object.values(leaderSeries).flat()]
  const res = spawnSync('/usr/bin/python3', [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '120', '40', ...times.map(String), '-1'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
  const frameAt = (ms: number): { atMs: number; rows: string[] } => screens.find(g => g.atMs === ms) ?? { atMs: ms, rows: [] }
  const f = (name: keyof typeof grabs): { atMs: number; rows: string[] } => frameAt(grabs[name])
  const receiptFrames = receiptAt.map(frameAt)
  const t = (g: { rows: string[] }): string => g.rows.join('\n')
  const hintSeen = (name: keyof typeof leaderSeries, needle: string): { frame: { atMs: number; rows: string[] }; detail: string } => {
    const frames = leaderSeries[name].map(frameAt)
    const hit = frames.find(g => t(g).includes(needle))
    const frame = hit ?? frames[frames.length - 1]!
    const lead = frame.atMs - leaderSeries[name][0]! + LEADER_OFFSETS[0]!
    return { frame, detail: hit !== undefined ? `painted by +${lead}ms` : `never in ${LEADER_OFFSETS.map(o => `+${o}`).join('/')}ms` }
  }
  const stopFrame = receiptFrames.find(g => /\bstopped\s+stream slowly/.test(t(g))) ?? receiptFrames[receiptFrames.length - 1]!
  if (process.env.MERCURY_CLOSE_CHORD_KEEP === '1') {
    const dir = join(home, 'frames')
    mkdirSync(dir, { recursive: true })
    for (const [name, ms] of Object.entries(grabs)) writeFileSync(join(dir, `${name}-${ms}.txt`), t(frameAt(ms)) + '\n')
    for (const [name, series] of Object.entries(leaderSeries)) for (const ms of series) writeFileSync(join(dir, `${name}-${ms}.txt`), t(frameAt(ms)) + '\n')
    for (const g of receiptFrames) writeFileSync(join(dir, `receipt-${g.atMs}.txt`), t(g) + '\n')
  }
  const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
  const stopWords = (g: { rows: string[] }): string => g.rows.filter(r => /stopp|park|⌃x|ctrl\+x|stream slowly|neighbour ready|deletes|arms/i.test(r)).map(r => r.trim().slice(0, 150)).join(' | ')
  const draftRows = (g: { rows: string[] }): string => g.rows.filter(r => /❯|keep me|tab or click/.test(r)).map(r => r.trim().slice(0, 120)).join(' | ')
  if (POISON_DIST === undefined) {
    check('POISON LETTER: plain x TYPED into the live composer (the defect retired)', f('x').rows.some(r => /❯\s+x\b/.test(r)), f('x').rows.find(r => /❯/.test(r))?.trim().slice(0, 90) ?? '(no composer row)')
    check('…and stopped NOTHING (the stream runs on, no stop receipt)', !/STOPPED|stopped —/i.test(t(f('x'))))
    const armSeen = hintSeen('arm', keyHintLabel('⌃x again stops — esc keeps it'))
    check('ARM: the first ⌃x paints the stage-true confirm on the row', t(armSeen.frame).includes(keyHintLabel('⌃x again stops — esc keeps it')), `${armSeen.detail} · ${t(armSeen.frame).match(/⌃x[^\n]*/)?.[0]?.slice(0, 90) ?? '(no hint row)'}`)
    check('DISARM: other input clears the hint, closes nothing, and the draft survives whole', !t(f('disarm')).includes(keyHintLabel('⌃x again stops')) && !/STOPPED/i.test(t(f('disarm'))) && f('disarm').rows.some(r => /❯\s+keep me(\s|▌|$)/.test(r)), f('disarm').rows.find(r => /❯/.test(r))?.trim().slice(0, 90) ?? '(no composer row)')
    check('STOP RUNG: the completed chord stopped the highlighted row — it STAYS, wearing stopped (inside 6 s)', /\bstopped\s+stream slowly/.test(t(stopFrame)), `+${stopFrame.atMs - stopAt}ms: ${stopWords(stopFrame)}`)
    const receiptWords = (g: { rows: string[] }): boolean => t(g).includes('applied — stop sent — ') || t(g).includes(keyHintLabel('stopped — ⌃x ⌃x archives it'))
    const receiptRows = receiptFrames.map(g => `+${g.atMs - stopAt}ms: ${g.rows.find(r => /applied|refused|failed/.test(r))?.trim().slice(0, 110) ?? '(no receipt row)'}`).join(' | ')
    check("…and the composer's receipt spoke the stop verb's detail inside its beat", receiptFrames.some(receiptWords), receiptRows)
    check('…and once the row reads stopped the receipt advances to the archive hint', receiptFrames.some(g => t(g).includes(keyHintLabel('stopped — ⌃x ⌃x archives it')) && /\bstopped\s+stream slowly/.test(t(g))), receiptRows)
    check('…and the draft still stands', stopFrame.rows.some(r => /❯\s+keep me(\s|▌|$)/.test(r)), draftRows(stopFrame))
    check('C4 STANDS: 10 s after the stop the row still reads stopped, never parked (no timer or sweep archived it)', /\bstopped\s+stream slowly/.test(t(f('stand'))) && !/\bparked\s+stream slowly/.test(t(f('stand'))), stopWords(f('stand')))
    const archiveSeen = hintSeen('archiveArm', keyHintLabel('⌃x again archives it (the chat stands parked)'))
    check('ARCHIVE ARM: the hint speaks the archive rung before the completion lands', t(archiveSeen.frame).includes(keyHintLabel('⌃x again archives it (the chat stands parked)')), `${archiveSeen.detail} · ${stopWords(archiveSeen.frame)}`)
    check('ARCHIVE: the row STAYS on the board, parked — the record stands', /stream slowly/.test(t(f('parked'))) && /\bparked\s+stream slowly/.test(t(f('parked'))), stopWords(f('parked')))
    const flipSeen = hintSeen('flipIn', keyHintLabel('⌃x again deletes it (the record ends)'))
    check('C2 INSIDE: 4 s after the archive the pending leader reads the DELETE rung', t(flipSeen.frame).includes(keyHintLabel('⌃x again deletes it (the record ends)')), `${flipSeen.detail} · ${stopWords(flipSeen.frame)}`)
    check('C2 THE WINDOW ENDS: at 5.5 s, the leader still pending, the hint flipped by itself to the fresh-start words (a press now arms; no stale "deletes")', t(f('flipOut')).includes(keyHintLabel('⌃x again arms the delete')) && !t(f('flipOut')).includes('again deletes it'), stopWords(f('flipOut')))
    const lateSeen = hintSeen('lateLeader', keyHintLabel('⌃x again arms the delete'))
    check('C2 OUTSIDE: a fresh leader 9 s after the archive says the press ARMS the delete and names the window', t(lateSeen.frame).includes(keyHintLabel('⌃x again arms the delete')) && /in 5 s ends it/.test(t(lateSeen.frame)), `${lateSeen.detail} · ${stopWords(lateSeen.frame)}`)
    check('C2 THE ARM: the completed chord outside the window ARMED (the row stays parked) and its note names the window', /\bparked\s+stream slowly/.test(t(f('lateArm'))) && t(f('lateArm')).includes(keyHintLabel('⌃x ⌃x within 5 s deletes it')), stopWords(f('lateArm')))
    const deleteSeen = hintSeen('deleteArm', keyHintLabel('⌃x again deletes it (the record ends)'))
    check('DELETE ARM: inside the arm\'s window the hint speaks the delete rung', t(deleteSeen.frame).includes(keyHintLabel('⌃x again deletes it (the record ends)')), `${deleteSeen.detail} · ${stopWords(deleteSeen.frame)}`)
    check('DELETE: exactly the highlighted session left the board', !/stream slowly/.test(t(f('gone'))))
    check('…the NEIGHBOUR survives untouched (its row still stands)', /neighbour rea/.test(t(f('gone'))) && !/no sessions running/.test(t(f('gone'))))
    check('…and the draft survives the whole ladder un-mangled', f('gone').rows.some(r => /❯\s+keep me(\s|▌|$)/.test(r)), draftRows(f('gone')))
    check('C3 NO STALE NOTE: after the delete no line still carries the arm\'s note (it left with its row)', !/archived — |within 5 s deletes it/.test(t(f('gone'))), f('gone').rows.filter(r => /deletes it|archived/.test(r)).map(r => r.trim().slice(0, 120)).join(' | ') || '(no chord note)')
    check('C1 the neighbour parked on its own two rungs (stop, archive) — the board still the frame', /\bparked\s+neighbour rea/.test(t(f('nParked'))) && /SESSIONS/.test(t(f('nParked'))), stopWords(f('nParked')))
    const enteredWords = f('entered').rows.filter(r => /⇧← back|shift\+← back|SESSIONS|armed|neighbour rea|bringing/.test(r)).map(r => r.trim().slice(0, 120)).join(' | ')
    check('C1 ONE ↵ on the parked row brings it back: the chat is the frame (its tag bar stands, the board is gone), never an "armed — ↵ again" stall', t(f('entered')).includes(keyHintLabel('⇧← back')) && !/STATUS & TITLE/.test(t(f('entered'))) && !/armed — ↵ again enters/.test(t(f('entered'))), enteredWords)
  } else {
    check(
      'POISON (pre-fix bundle): the bare x was a VERB — it stopped the streaming session instead of typing',
      /STOPPED|stopped — x again/i.test(t(f('x'))) && !f('x').rows.some(r => /❯\s+x\b/.test(r)),
      `stop-ish: ${f('x').rows.filter(r => /stop/i.test(r)).map(r => r.trim().slice(0, 80)).join(' | ') || 'none'} · composer: ${f('x').rows.find(r => /❯/.test(r))?.trim().slice(0, 80) ?? 'none'}`,
    )
    check('POISON: the chord did not exist — the row is STILL on the board after every completed gesture', /stream slowly/.test(t(f('gone'))))
  }
}
if (process.env.MERCURY_CLOSE_CHORD_KEEP === '1') {
  console.log(`  kept for inspection: ${drive} (frames beside it under frames/)`)
} else {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-close-chord: ALL LAWS HOLD' : `\nprove-close-chord: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
