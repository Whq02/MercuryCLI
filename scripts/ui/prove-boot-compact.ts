#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback,
  printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { BOOT_FACE_READY, paintsBootFaceReady } from '../lib/bootFace.ts'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'

const REFUSAL = /needs \d+ rows|this window is|needs at least|terminal too small|too small for|resize to continue/i
const CONCOURSE_HINT = '⇧→ concourse'
const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
const CONCOURSE_HINT_HOST = keyHintLabel(CONCOURSE_HINT)
const HINT_ROW = '↵ start · ↑↓ choose'
const LIVE_HINT_ROW = '>_ · ↵ · ↑↓'
const CHAT_READY = 'Type a prompt'
const HINT_SEGMENTS = [
  { key: '↵ ', label: 'start', tone: 'ivory' as const },
  { key: '↑↓', label: ' choose', tone: 'faint' as const },
]
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const bottomRight = (frame: string[], cols: number, rows: number, hint: string = CONCOURSE_HINT_HOST): boolean =>
  frame[rows - 1] === ' '.repeat(cols - hint.length - 2) + hint
const inFrameHint = (line: string): boolean => /^\s*│ ↵ start · ↑↓ choose\s*│$/.test(line)
const liveInFrameHint = (line: string): boolean => /^\s*│ >_ · ↵ · ↑↓\s*│$/.test(line)
const topBorder = (cols: number, at: number): string => ' '.repeat(at) + '╭' + '─'.repeat(cols - 2) + '╮'

const APPROVED_80x21 = [
  "",
  "             ██▄██   █▀▀▀▀   █▀▀▀█   █▀▀▀▀   █   █   █▀▀▀█   █   █",
  "             █   █   █▀▀▀    █▀▀█    █       █   █   █▀▀█     ▀█▀",
  "             ▀   ▀   ▀▀▀▀▀   ▀   ▀   ▀▀▀▀▀   ▀▀▀▀▀   ▀   ▀     ▀",
  "                 ──────────────────────────────────────────────",
  "",
  "        ╭──────────────────────────────────────────────────────────────╮",
  "        │ ❯ New Session in City St George's · start fresh here         │",
  "        │   Continue Last Session · City St George's · 12m             │",
  "        │   Boot Menu · configure boot env                             │",
  "        │   MCPs & Skills · what the next session loads                │",
  "        │   Agents · 7 agents                                          │",
  "        │   Health Check · system diagnostics                          │",
  "        │   Saturn Scheduler · sessions born on the clock              │",
  "        │   Logins · 8 of 10 signed in                                 │",
  "        │   Session Concourse · the live board · 1 live                │",
  "        │   Sessions · Projects · 5 repos · pick a session             │",
  "        │ ↵ start · ↑↓ choose                                          │",
  "        ╰──────────────────────────────────────────────────────────────╯",
  "",
  "                                                                  ⇧→ concourse",
]
const APPROVED_80x14 = [
  "        ╭──────────────────────────────────────────────────────────────╮",
  "        │ ❯ New Session in City St George's · start fresh here         │",
  "        │   Continue Last Session · City St George's · 12m             │",
  "        │   Boot Menu · configure boot env                             │",
  "        │   MCPs & Skills · what the next session loads                │",
  "        │   Agents · 7 agents                                          │",
  "        │   Health Check · system diagnostics                          │",
  "        │   Saturn Scheduler · sessions born on the clock              │",
  "        │   Logins · 8 of 10 signed in                                 │",
  "        │   Session Concourse · the live board · 1 live                │",
  "        │   Sessions · Projects · 5 repos · pick a session             │",
  "        │ ↵ start · ↑↓ choose                                          │",
  "        ╰──────────────────────────────────────────────────────────────╯",
  "                                                                  ⇧→ concourse",
]

const MOCK_ROWS = [
  ["New Session in City St George's", 'start fresh here'],
  ['Continue Last Session', "City St George's · 12m"],
  ['Boot Menu', 'configure boot env'],
  ['MCPs & Skills', 'what the next session loads'],
  ['Agents', '7 agents'],
  ['Health Check', 'system diagnostics'],
  ['Saturn Scheduler', 'sessions born on the clock'],
  ['Logins', '8 of 10 signed in'],
  ['Session Concourse', 'the live board · 1 live'],
  ['Sessions · Projects', '5 repos · pick a session'],
].map(([label, ctx]) => ({ label: label!, ctx: ctx! }))

const composerFix = 'change composeCompactFace in assets/splash/splash-core.mjs (the card, banner and hint layout), or update the approved grid in this file if the new layout is intended. Composed: '
console.log('§0 the composer against the approved grids')
{
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crab' })
  const compose = (cols: number, rows: number, cardSel = 0) =>
    core.composeCompactFace(cols, rows, { cardRows: MOCK_ROWS, cardSel, hintSegments: HINT_SEGMENTS, keyMap: CONCOURSE_HINT })
  const text = (cols: number, rows: number, cardSel = 0): string[] => compose(cols, rows, cardSel).lines.map(l => strip(l).trimEnd())
  check('80×21 composes the approved grid row for row', text(80, 21).join('\n') === APPROVED_80x21.join('\n'), composerFix + text(80, 21).join('\n'))
  check('80×14 composes the approved grid row for row', text(80, 14).join('\n') === APPROVED_80x14.join('\n'), composerFix + text(80, 14).join('\n'))
  const at60 = text(60, 16)
  check('60×16: the banner gives way, the frame narrows to the window and keeps the descriptions', !at60.some(l => l.includes('██▄██')) && at60[1] === topBorder(60, 0) && at60.some(l => l.includes('start fresh here')) && at60.some(inFrameHint) && bottomRight(at60, 60, 16, CONCOURSE_HINT), composerFix + at60.join('\n'))
  const at40 = text(40, 10)
  check('40×10: the descriptions and the frame give way, the list scrolls with a cut, the hint and the key-map stay', !at40.some(l => l.includes('╭')) && !at40.some(l => l.includes('start fresh here')) && at40.some(l => /↓ \d+ more/.test(l)) && at40.some(l => l.includes('❯ New Session')) && at40.some(l => l.includes(HINT_ROW)) && bottomRight(at40, 40, 10, CONCOURSE_HINT), composerFix + at40.join('\n'))
  const last = compose(40, 10, MOCK_ROWS.length - 1)
  check('40×10: the last row selected scrolls the window down behind an ↑ cut', last.lines.map(strip).some(l => /↑ \d+ more/.test(l)) && last.actions.some(a => a.index === MOCK_ROWS.length - 1), composerFix + last.lines.map(strip).join('\n'))
  let sound = true
  const sweep: Array<[number, number]> = [[1, 1], [2, 2], [3, 3], [8, 3], [24, 3], [40, 8], [64, 12], [64, 13], [80, 24], [99, 26], [100, 25], [120, 25], [200, 60]]
  for (const [cols, rows] of sweep) {
    for (let sel = 0; sel < MOCK_ROWS.length; sel += 3) {
      const c = compose(cols, rows, sel)
      const lines = c.lines.map(strip)
      if (lines.length !== rows) sound = false
      if (lines.some(l => core.vis(l) > cols)) sound = false
      if (!lines.some(l => l.trim() !== '')) sound = false
      if (REFUSAL.test(lines.join(' '))) sound = false
      if (!c.actions.some(a => a.index === sel)) sound = false
      if (lines.filter(l => l.includes('❯')).length > 1) sound = false
    }
  }
  check('every size: exactly the rows asked, never wider, never empty, never a refusal, the selected row on screen, one caret at most', sound, 'composeCompactFace in assets/splash/splash-core.mjs breaks one of these at one of the swept sizes (see the sweep list above this check): fix its row count, width clamp, selected-row scrolling or caret rule')
  const full = compose(80, 21)
  const hero = full.hero.map(l => strip(l).trimEnd())
  const card = full.lines.map(l => strip(l).trimEnd())
  check('80×21: the splash hero keeps the banner, the rule and the blank on the rows the card view paints them', hero.length === 7 && hero.slice(0, 6).join('\n') === card.slice(0, 6).join('\n') && hero[1]!.includes('██▄██'), composerFix + hero.join('\n'))
  check('80×21: the ready line stands where the frame top composes in beneath the banner', hero[6] === ' '.repeat(36) + '>_  ·  ↵' && card[6] === topBorder(64, 8), `${composerFix}${hero[6]} / ${card[6]}`)
  const asset = readFileSync(join(ROOT, 'assets/splash/mercury-splash.mjs'), 'utf8')
  const { LAYOUT_BREAKPOINTS } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
  check('the launcher splash mirrors the cockpit gate the size latch reads', asset.includes(`const COMPACT_HOST_COLS = ${LAYOUT_BREAKPOINTS.cockpitMin}\n`) && asset.includes(`const COMPACT_HOST_ROWS = ${LAYOUT_BREAKPOINTS.cockpitMinRows}\n`) && asset.includes('const compactHost = (c, r) => CINEMATIC && !(c >= COMPACT_HOST_COLS && r >= COMPACT_HOST_ROWS)'), 'set COMPACT_HOST_COLS and COMPACT_HOST_ROWS and compactHost in assets/splash/mercury-splash.mjs to match LAYOUT_BREAKPOINTS.cockpitMin and cockpitMinRows in src/screen/fullscreen-layout/useLayoutTier.ts')
}

const sizes: Array<[number, number]> = process.argv.includes('--size')
  ? [process.argv[process.argv.indexOf('--size') + 1]!.split('x').map(Number) as [number, number]]
  : [[80, 21], [80, 14], [60, 16], [40, 10], [120, 40]]
const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1]! : DIST
const tree = dist === DIST ? ROOT : dirname(dirname(dist))
const driver = requireCaptureDriver('boot-compact')
const fixtureCwd = join(scratch, 'boot-compact-cwd')
mkdirSync(fixtureCwd, { recursive: true })
console.log(`boot compact artifacts: ${scratch} (dist ${dist})`)
for (const [cols, rows] of sizes) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('size must be positive columns x rows')
  const tag = `boot-compact-${cols}x${rows}`
  seedFirstRun(join(scratch, `home-${tag}`), [tree, fixtureCwd, realpathSync(fixtureCwd)])
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const out = join(scratch, `${tag}-grid.json`)
    const cfgPath = join(scratch, `${tag}-vshot.json`)
    const sends = [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, requireAwait: true, data: '' },
      { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, awaitSettleTicks: 3, awaitStableTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 120, awaitText: CHAT_READY, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'chat' },
    ]
    writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), dist], cwd: fixtureCwd, cols, rows, sends, resizes: [], readyText: CHAT_READY, readySettleTicks: 2, total: 220, out }))
    const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: tree, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off' }), stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', chunk => { stderr += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const status = await new Promise<number | null>(resolve => {
      const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(220 * 200 + 60_000))
      child.once('error', () => { clearTimeout(wall); resolve(null) })
      child.once('exit', code => { clearTimeout(wall); resolve(code) })
    })
    const payload = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; cursor?: { x: number; y: number }; marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> } : null
    const rowsOf = (g: Array<Array<{ c: string }>>): string[] => g.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
    const marks = new Map((payload?.marks ?? []).map(m => [m.label, rowsOf(m.grid)]))
    const boot = marks.get('boot') ?? []
    const chat = payload === null ? [] : rowsOf(payload.grid)
    writeFileSync(join(scratch, `${tag}-boot.txt`), boot.join('\n') + '\n')
    printFrame(`${cols}x${rows} Boot`, boot)
    printFrame(`${cols}x${rows} settled after ↵`, chat)
    check(`${cols}x${rows}: the drive completed and the face painted its ready hint`, status === 0 && joined(boot).includes(FACE_READY), `the capture drive of the built bundle did not reach the Boot face ready line (rebuild dist with bun run build.ts; the face is src/screen/boot-face/splash/face.tsx); drive output tail: ${stderr.slice(-600)}`)
    check(`${cols}x${rows}: no refusal words on the face`, boot.length > 0 && !REFUSAL.test(joined(boot)), 'the Boot face printed a too-small refusal or nothing at this size; the compact face is src/screen/boot-face/splash/face.tsx calling composeCompactFace in assets/splash/splash-core.mjs; see the printed Boot frame above')
    const carets = boot.filter(l => l.includes('❯'))
    check(`${cols}x${rows}: one row carries the caret and it is New Session`, carets.length === 1 && carets[0]!.includes('New Session'), `the Boot face must show one caret row on New Session (src/screen/boot-face/splash/face.tsx, composeCompactFace in assets/splash/splash-core.mjs); caret rows: ${carets.join(' | ')}`)
    check(`${cols}x${rows}: ↵ started a session`, joined(chat).includes(CHAT_READY), 'pressing Enter on the Boot face did not open a session showing the prompt line; see the printed settled frame above and the Boot face in src/screen/boot-face/splash/face.tsx')
    check(`${cols}x${rows}: the grid has the exact physical dimensions`, payload !== null && payload.grid.length === rows && payload.grid.every(line => line.length === cols), 'the capture grid file was missing or its size differs from the asked size; the drive did not finish, see the stderr tail printed by the first check of this size')
    check(`${cols}x${rows}: the cursor stays in bounds`, payload?.cursor !== undefined && payload.cursor.x >= 0 && payload.cursor.x < cols && payload.cursor.y >= 0 && payload.cursor.y < rows, 'the final cursor was missing or outside the window; the Boot or chat view parked the cursor off screen, or the drive did not finish')
    check(`${cols}x${rows}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0, 'the drive reached a non-loopback host; keep the session on the mock server of startLeg. Hosts: ' + nonLoopback(netlines(leg.netlog)).join(' | '))
    const compact = cols < 100 || rows < 26
    if (compact) {
      check(`${cols}x${rows}: the concourse key-map sits bottom-right`, bottomRight(boot, cols, rows), `the last row must hold the concourse key-map flush right (composeCompactFace in assets/splash/splash-core.mjs); last row: ${boot[rows - 1] ?? ''}`)
      check(`${cols}x${rows}: the ready hint row is on the face`, boot.some(l => l.includes(LIVE_HINT_ROW)), 'the compact Boot face lost its ready hint row; check the hint segments src/screen/boot-face/splash/face.tsx passes to composeCompactFace in assets/splash/splash-core.mjs')
    }
    if (cols === 80 && rows === 21) {
      check('80x21: the banner and rule stand above the centred card', boot.some(l => l.includes('██▄██')) && boot.some(l => l.includes('─'.repeat(40))), 'the 80x21 compact face should show the banner and rule above the card (composeCompactFace in assets/splash/splash-core.mjs); top rows: ' + boot.slice(0, 8).join(' | '))
      check('80x21: the framed card is 37 wide, centred, with the hint as its last inner row', boot.some(l => l === topBorder(37, 21)) && boot.some(l => l.trim().startsWith('╰')) && boot.some(liveInFrameHint), 'the 80x21 card frame is wrong in the live face; fix the card width, centring or hint row in composeCompactFace in assets/splash/splash-core.mjs. Boot frame is printed above')
    }
    if (cols === 80 && rows === 14) {
      check('80x14: the banner gives way and the centred 37-wide frame holds the hint', !boot.some(l => l.includes('██▄██')) && boot.some(l => l === topBorder(37, 21)) && boot.some(liveInFrameHint), 'the 80x14 compact frame is wrong in the live face; fix composeCompactFace in assets/splash/splash-core.mjs. Boot frame is printed above')
    }
    if (cols === 60 && rows === 16) {
      check('60x16: the five-row card fits with the banner and 37-wide centred frame', boot.some(l => l.includes('██▄██')) && boot.some(l => l === topBorder(37, 11)) && boot.some(liveInFrameHint), 'the 60x16 compact frame is wrong in the live face; fix composeCompactFace in assets/splash/splash-core.mjs. Boot frame is printed above')
    }
    if (cols === 40 && rows === 10) {
      check('40x10: the banner gives way and the 37-wide frame keeps all rows and the caret on screen', !boot.some(l => l.includes('██▄██')) && boot[0] === topBorder(37, 1) && boot.some(liveInFrameHint) && boot.some(l => l.includes('❯ New Session')), 'the 40x10 compact frame is wrong in the live face; fix composeCompactFace in assets/splash/splash-core.mjs. Boot frame is printed above')
    }
    if (!compact) {
      check(`${cols}x${rows}: the full-size face is untouched (its own ready line, its key-map at the left, no compact frame)`, paintsBootFaceReady(joined(boot)) && (boot[rows - 1] ?? '').startsWith('  ' + CONCOURSE_HINT_HOST) && !boot.some(liveInFrameHint), 'the full-size Boot face (100x26 and up) must not use the compact frame or lose its left-aligned key-map; check the size gate in src/screen/boot-face/splash/face.tsx. Boot frame is printed above')
    }
  } finally {
    await endLeg(leg)
  }
}
finish('boot-compact')
