#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback,
  printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'

const REFUSAL = /needs \d+ rows|this window is|needs at least|terminal too small|too small for|resize to continue/i
const CONCOURSE_HINT = '⇧→ concourse'
const HINT_ROW = '↵ start · ↑↓ choose · m menu'
const CHAT_READY = 'Type a prompt'
const HINT_SEGMENTS = [
  { key: '↵ ', label: 'start', tone: 'ivory' as const },
  { key: '↑↓', label: ' choose', tone: 'faint' as const },
  { key: 'm', label: ' menu', tone: 'faint' as const },
]
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const bottomRight = (frame: string[], cols: number, rows: number): boolean =>
  frame[rows - 1] === ' '.repeat(cols - CONCOURSE_HINT.length - 2) + CONCOURSE_HINT
const inFrameHint = (line: string): boolean => /^\s*│ ↵ start · ↑↓ choose · m menu\s*│$/.test(line)
const topBorder = (cols: number, at: number): string => ' '.repeat(at) + '╭' + '─'.repeat(cols - 2) + '╮'

const APPROVED_80x21 = [
  "",
  "             ██▄██   █▀▀▀▀   █▀▀▀█   █▀▀▀▀   █   █   █▀▀▀█   █   █",
  "             █   █   █▀▀▀    █▀▀█    █       █   █   █▀▀█     ▀█▀",
  "             ▀   ▀   ▀▀▀▀▀   ▀   ▀   ▀▀▀▀▀   ▀▀▀▀▀   ▀   ▀     ▀",
  "                 ■ ───────────────··· (>_) ···─────────────── ■",
  "",
  "        ╭──────────────────────────────────────────────────────────────╮",
  "        │ ❯ New Session in City St George's · start fresh here         │",
  "        │   Continue Last Session · City St George's · 12m             │",
  "        │   Boot Menu · configure boot env                             │",
  "        │   MCPs & Skills · what the next session loads                │",
  "        │   Agents · 7 agents                                          │",
  "        │   Doctor / Health Check · system diagnostics                 │",
  "        │   Saturn Scheduler · sessions born on the clock              │",
  "        │   Logins · 8 of 10 signed in                                 │",
  "        │   Session Concourse · the live board · 1 live                │",
  "        │   Sessions · Projects · 5 repos · pick a session             │",
  "        │ ↵ start · ↑↓ choose · m menu                                 │",
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
  "        │   Doctor / Health Check · system diagnostics                 │",
  "        │   Saturn Scheduler · sessions born on the clock              │",
  "        │   Logins · 8 of 10 signed in                                 │",
  "        │   Session Concourse · the live board · 1 live                │",
  "        │   Sessions · Projects · 5 repos · pick a session             │",
  "        │ ↵ start · ↑↓ choose · m menu                                 │",
  "        ╰──────────────────────────────────────────────────────────────╯",
  "                                                                  ⇧→ concourse",
]

const MOCK_ROWS = [
  ["New Session in City St George's", 'start fresh here'],
  ['Continue Last Session', "City St George's · 12m"],
  ['Boot Menu', 'configure boot env'],
  ['MCPs & Skills', 'what the next session loads'],
  ['Agents', '7 agents'],
  ['Doctor / Health Check', 'system diagnostics'],
  ['Saturn Scheduler', 'sessions born on the clock'],
  ['Logins', '8 of 10 signed in'],
  ['Session Concourse', 'the live board · 1 live'],
  ['Sessions · Projects', '5 repos · pick a session'],
].map(([label, ctx]) => ({ label: label!, ctx: ctx! }))

console.log('§0 the composer against the approved grids')
{
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crab' })
  const compose = (cols: number, rows: number, cardSel = 0) =>
    core.composeCompactFace(cols, rows, { cardRows: MOCK_ROWS, cardSel, hintSegments: HINT_SEGMENTS, keyMap: CONCOURSE_HINT })
  const text = (cols: number, rows: number, cardSel = 0): string[] => compose(cols, rows, cardSel).lines.map(l => strip(l).trimEnd())
  check('80×21 composes the approved grid row for row', text(80, 21).join('\n') === APPROVED_80x21.join('\n'), text(80, 21).join('\n'))
  check('80×14 composes the approved grid row for row', text(80, 14).join('\n') === APPROVED_80x14.join('\n'), text(80, 14).join('\n'))
  const at60 = text(60, 16)
  check('60×16: the banner gives way, the frame narrows to the window and keeps the descriptions', !at60.some(l => l.includes('██▄██')) && at60[1] === topBorder(60, 0) && at60.some(l => l.includes('start fresh here')) && at60.some(inFrameHint) && bottomRight(at60, 60, 16), at60.join('\n'))
  const at40 = text(40, 10)
  check('40×10: the descriptions and the frame give way, the list scrolls with a cut, the hint and the key-map stay', !at40.some(l => l.includes('╭')) && !at40.some(l => l.includes('start fresh here')) && at40.some(l => /↓ \d+ more/.test(l)) && at40.some(l => l.includes('❯ New Session')) && at40.some(l => l.includes(HINT_ROW)) && bottomRight(at40, 40, 10), at40.join('\n'))
  const last = compose(40, 10, MOCK_ROWS.length - 1)
  check('40×10: the last row selected scrolls the window down behind an ↑ cut', last.lines.map(strip).some(l => /↑ \d+ more/.test(l)) && last.actions.some(a => a.index === MOCK_ROWS.length - 1), last.lines.map(strip).join('\n'))
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
  check('every size: exactly the rows asked, never wider, never empty, never a refusal, the selected row on screen, one caret at most', sound)
  const full = compose(80, 21)
  const hero = full.hero.map(l => strip(l).trimEnd())
  const card = full.lines.map(l => strip(l).trimEnd())
  check('80×21: the splash hero keeps the banner, the rule and the blank on the rows the card view paints them', hero.length === 7 && hero.slice(0, 6).join('\n') === card.slice(0, 6).join('\n') && hero[1]!.includes('██▄██'), hero.join('\n'))
  check('80×21: the ready line stands where the frame top composes in beneath the banner', hero[6] === ' '.repeat(30) + '▶_ ready  ·  ↵ start' && card[6] === topBorder(64, 8), `${hero[6]} / ${card[6]}`)
  const asset = readFileSync(join(ROOT, 'assets/splash/mercury-splash.mjs'), 'utf8')
  const { LAYOUT_BREAKPOINTS } = await import('../../src/hooks/useLayoutTier.ts')
  check('the launcher splash mirrors the cockpit gate the size latch reads', asset.includes(`const COMPACT_HOST_COLS = ${LAYOUT_BREAKPOINTS.cockpitMin}\n`) && asset.includes(`const COMPACT_HOST_ROWS = ${LAYOUT_BREAKPOINTS.cockpitMinRows}\n`) && asset.includes('const compactHost = (c, r) => CINEMATIC && !(c >= COMPACT_HOST_COLS && r >= COMPACT_HOST_ROWS)'))
}

const sizes: Array<[number, number]> = process.argv.includes('--size')
  ? [process.argv[process.argv.indexOf('--size') + 1]!.split('x').map(Number) as [number, number]]
  : [[80, 21], [80, 14], [60, 16], [40, 10], [120, 40]]
const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1]! : DIST
const tree = dist === DIST ? ROOT : dirname(dirname(dist))
const driver = requireCaptureDriver('boot-compact')
console.log(`boot compact artifacts: ${scratch} (dist ${dist})`)
for (const [cols, rows] of sizes) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('size must be positive columns x rows')
  const tag = `boot-compact-${cols}x${rows}`
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const out = join(scratch, `${tag}-grid.json`)
    const cfgPath = join(scratch, `${tag}-vshot.json`)
    const sends = [
      { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
      { atTick: 120, awaitText: CHAT_READY, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'chat' },
    ]
    writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), dist], cwd: tree, cols, rows, sends, resizes: [], readyText: CHAT_READY, readySettleTicks: 2, total: 220, out }))
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
    check(`${cols}x${rows}: the drive completed and the face painted its ready hint`, status === 0 && joined(boot).includes(FACE_READY), stderr.slice(-600))
    check(`${cols}x${rows}: no refusal words on the face`, boot.length > 0 && !REFUSAL.test(joined(boot)))
    const carets = boot.filter(l => l.includes('❯'))
    check(`${cols}x${rows}: one row carries the caret and it is New Session`, carets.length === 1 && carets[0]!.includes('New Session'), carets.join(' | '))
    check(`${cols}x${rows}: ↵ started a session`, joined(chat).includes(CHAT_READY))
    check(`${cols}x${rows}: the grid has the exact physical dimensions`, payload !== null && payload.grid.length === rows && payload.grid.every(line => line.length === cols))
    check(`${cols}x${rows}: the cursor stays in bounds`, payload?.cursor !== undefined && payload.cursor.x >= 0 && payload.cursor.x < cols && payload.cursor.y >= 0 && payload.cursor.y < rows)
    check(`${cols}x${rows}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
    const compact = cols < 100 || rows < 26
    if (compact) {
      check(`${cols}x${rows}: the concourse key-map sits bottom-right`, bottomRight(boot, cols, rows), boot[rows - 1] ?? '')
      check(`${cols}x${rows}: the ready hint row is on the face`, boot.some(l => l.includes(HINT_ROW)))
    }
    if (cols === 80 && rows === 21) {
      check('80x21: the banner rides row 2 and the rule beneath it', boot[1]?.includes('██▄██') === true && boot[4]?.includes('(>_)') === true && boot[4]?.includes('■') === true)
      check('80x21: the framed card is 64 wide, centred, with the hint as its last inner row', boot.some(l => l === topBorder(64, 8)) && boot.some(l => l.trim().startsWith('╰')) && boot.some(inFrameHint))
    }
    if (cols === 80 && rows === 14) {
      check('80x14: the banner gives way and the frame starts on row 1', !boot.some(l => l.includes('██▄██')) && boot[0] === topBorder(64, 8) && boot.some(inFrameHint))
    }
    if (cols === 60 && rows === 16) {
      check('60x16: no banner, the frame narrows to the window and keeps the descriptions', !boot.some(l => l.includes('██▄██')) && boot.some(l => l === topBorder(60, 0)) && boot.some(l => l.includes('start fresh here')) && boot.some(inFrameHint))
    }
    if (cols === 40 && rows === 10) {
      check('40x10: no banner, no frame, no descriptions, the list scrolls behind a cut with the caret on screen', !boot.some(l => l.includes('██▄██')) && !boot.some(l => l.includes('╭')) && !boot.some(l => l.includes('start fresh here')) && boot.some(l => /[↑↓] \d+ more/.test(l)) && boot.some(l => l.includes('❯ New Session')))
    }
    if (!compact) {
      check(`${cols}x${rows}: the full-size face is untouched (its own ready line, its key-map at the left, no compact frame)`, joined(boot).includes('>_ ready') && (boot[rows - 1] ?? '').startsWith('  ' + CONCOURSE_HINT) && !boot.some(inFrameHint))
    }
  } finally {
    await endLeg(leg)
  }
}
finish('boot-compact')
