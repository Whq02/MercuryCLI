#!/usr/bin/env bun
// gate-watch: src/components/tasks/BackgroundTasksDialog.tsx src/components/CrewmateTranscript.tsx src/components/tasks/useCrewmateTranscript.ts src/components/CompactIdentityBand.tsx src/components/CrewmateCard.tsx src/utils/cockpit/crewmateWords.ts src/components/mercury-ui/screens/CrewView.tsx
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { LEAD_ASK_SLEEPER, SEAT_NAME, startCrewStopFixture, type Fixture } from '../crew/crew-stop-fixture.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const KEEP = process.argv.includes('--keep')
const SIZES = (argAfter('--sizes') ?? '100x30z,80x24,177x49z,177x49').split(',').map(s => {
  const zen = s.endsWith('z')
  const [cols, rows] = s.replace(/z$/, '').split('x').map(Number) as [number, number]
  return { cols, rows, zen }
})
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const ESC = '\x1b'
const CTRL_T = '\x14'
const LEAD_LINE = 'launching the sleeper'
const CREWMATE_PLATE = `[you → ${SEAT_NAME}]`
const CARD_ROW = `agent › ${SEAT_NAME}`
const ACTIVITY_TITLE = 'Mercury — activity'
const LEAD_ROW = 'Mercury Lead'
const LEAD_ROW_WORDS = "the lead's own chat"
const COMPACT_BACK = 'Mercury Lead in the activity screen goes back'
const RAIL_BACK = 'Mercury Lead in the rail goes back'
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first, or name a bundle with --dist`)
  process.exit(0)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; sends: number; receipts: number; endReason: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'zen-agent-view-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return { text: gridText(payload.grid), marks, sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '' }
}

function seedWorld(zen: boolean): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zen-agent-view-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'zen-agent-view-cwd-')))
  seedFirstRun(home, [cwd])
  if (zen) writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { zen: true } }))
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: './daemon',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    BROWSER: '/usr/bin/true',
  }
  for (const stamp of ['MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'NODE_ENV', 'CI', 'MERCURY_HOME']) delete process.env[stamp]
  return env
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', atTick: 999, awaitText: ask, requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
]

const flat = (s: string): string => s.replace(/\s+/g, ' ')
const rowsOf = (text: string): string[] => text.split('\n')
const has = (text: string, needle: string): boolean => text.includes(needle)
const bandRow = (text: string): string => rowsOf(text).find(row => /✶ Mercury|◉ sleeper|★ sleeper/.test(row)) ?? ''
const composerRow = (text: string): string => rowsOf(text).find(row => /^│[❯›]/.test(row)) ?? ''
const crewmateRowsTakeTheCentre = (text: string): boolean => has(text, CREWMATE_PLATE) && rowsOf(text).some(row => row.includes(`[${SEAT_NAME}]`) && row.includes('Sleep')) && !has(text, LEAD_LINE)
const leadRowsBack = (text: string): boolean => has(text, LEAD_LINE) && !has(text, CREWMATE_PLATE)

function keep(label: string, frame: string | undefined): void {
  if (FRAMES === undefined || frame === undefined) return
  writeFileSync(join(FRAMES, `${label}.txt`), frame + '\n')
}

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

async function compactLeg(cols: number, rows: number, zen: boolean): Promise<void> {
  const tag = `${cols}x${rows}${zen ? ' zen' : ''}`
  console.log(`\n— ${tag}: the strip's activity screen, the lead's row back, /crewmates, esc —`)
  const before = failures
  const fixture: Fixture = await startCrewStopFixture({ seatTool: 'sleep' })
  const { home, cwd } = seedWorld(zen)
  const sends: Array<Record<string, unknown>> = [
    ...bootSends(LEAD_ASK_SLEEPER),
    { data: CTRL_T, atTick: 999, awaitText: LEAD_LINE, requireAwait: true, minTick: 5, awaitSettleTicks: 6, mark: 'launched' },
    { data: '\r', atTick: 999, awaitText: LEAD_LINE, requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
    { data: '\r', atTick: 999, awaitText: ACTIVITY_TITLE, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'activity' },
    { data: CTRL_T, atTick: 999, awaitText: CREWMATE_PLATE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'strip-view' },
    { data: '\r', atTick: 999, awaitText: CREWMATE_PLATE, requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
    { data: '\r', atTick: 999, awaitText: LEAD_ROW_WORDS, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'activity-lead' },
    { data: '/crewmates', atTick: 999, awaitText: LEAD_LINE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'strip-back' },
    { data: '\r', atTick: 999, awaitText: '/crewmates', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
    { data: '\r', atTick: 999, awaitText: '↵ open in the view', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'popup' },
    { data: ESC, atTick: 999, awaitText: CREWMATE_PLATE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'popup-view' },
    { data: ESC, atTick: 999, awaitText: 'the interrupt ended', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'cut' },
    { data: '', atTick: 999, awaitText: LEAD_LINE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'esc-back' },
  ]
  let cap: Capture | null = null
  try {
    cap = await capture({ cols, rows, total: 600, cwd, argv: ['node', DIST], sends, readyText: LEAD_LINE, readySettleTicks: 3, stableTicks: 6 }, driveEnv(home, fixture.base))
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  for (const [label, frame] of Object.entries(marks)) keep(`${cols}x${rows}${zen ? '-zen' : ''}-${label}`, frame)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const launched = marks['launched'] ?? ''
  check(`${tag}: the layout is the compact one (no rail; the band wears the session's own identity; the strip counts the crewmate)`, !has(launched, 'CREW') && bandRow(launched).includes('✶ Mercury') && has(launched, '1 crewmate here'), flat(launched).slice(0, 300))
  const activity = marks['activity'] ?? ''
  check(`${tag}: ctrl+t then ↵ opens the activity screen with the sleeper as its crewmate row`, has(activity, ACTIVITY_TITLE) && rowsOf(activity).some(row => row.includes('❯') && row.includes(SEAT_NAME)), flat(activity).slice(0, 300))
  const view = marks['strip-view'] ?? ''
  check(`${tag}: ↵ on the crewmate row opens it in the view — its rows take the transcript ([you → sleeper] and its Sleep call), the lead's rows are gone, no facts card`, crewmateRowsTakeTheCentre(view) && !has(view, CARD_ROW) && !has(view, ACTIVITY_TITLE), flat(view).slice(0, 400))
  check(`${tag}: the band shows the sleeper's card and the composer routes to it`, bandRow(view).includes(`◉ ${SEAT_NAME}`) && composerRow(view).includes(`message ${SEAT_NAME}`), `${bandRow(view).trim().slice(0, 120)} · ${composerRow(view).trim().slice(0, 60)}`)
  if (cols >= 160) check(`${tag}: the card names the activity screen as the way back (the rail is hidden)`, has(view, COMPACT_BACK) && !has(view, RAIL_BACK), rowsOf(view).filter(row => row.includes('goes back')).map(row => row.trim()).join(' | ').slice(0, 200))
  const activityLead = marks['activity-lead'] ?? ''
  const crewList = rowsOf(activityLead).slice(Math.max(0, rowsOf(activityLead).findIndex(row => row.startsWith('Crewmates ('))))
  check(`${tag}: with the sleeper viewed, the activity screen heads its crewmates with the lead's row, the cursor on it, and its key row (where it fits) says ↵ back to the lead`, crewList.some(row => row.includes('❯') && row.includes(LEAD_ROW) && row.includes(LEAD_ROW_WORDS)) && (crewList.findIndex(row => row.includes(SEAT_NAME)) < 0 || crewList.findIndex(row => row.includes(LEAD_ROW_WORDS)) < crewList.findIndex(row => row.includes(SEAT_NAME))) && (!has(activityLead, '↑/↓ select') || has(activityLead, `↵ back to ${LEAD_ROW}`)), crewList.map(row => row.trim()).filter(Boolean).join(' | ').slice(0, 300))
  const back = marks['strip-back'] ?? ''
  check(`${tag}: ↵ on the lead's row goes back — the lead's rows return, the band is the session's own, the sleeper still runs`, leadRowsBack(back) && bandRow(back).includes('✶ Mercury') && has(back, '1 crewmate here'), flat(back).slice(0, 300))
  const popup = marks['popup'] ?? ''
  check(`${tag}: /crewmates lists the sleeper still sleeping (the way back stopped nothing)`, has(popup, SEAT_NAME) && has(popup, 'Sleeping for'), flat(popup).slice(0, 300))
  const popupView = marks['popup-view'] ?? ''
  check(`${tag}: /crewmates' ↵ opens the sleeper in the view too — its rows take the transcript`, crewmateRowsTakeTheCentre(popupView) && bandRow(popupView).includes(`◉ ${SEAT_NAME}`), flat(popupView).slice(0, 300))
  const cut = marks['cut'] ?? ''
  check(`${tag}: esc interrupts the viewed sleeper — the cut row lands in its transcript, the view stays`, has(cut, 'the interrupt ended') && has(cut, CREWMATE_PLATE) && bandRow(cut).includes(`◉ ${SEAT_NAME}`) && bandRow(cut).includes('interrupted'), flat(cut).slice(0, 300))
  const escBack = marks['esc-back'] ?? ''
  check(`${tag}: esc on the interrupted sleeper goes back to the lead's rows`, leadRowsBack(escBack) && bandRow(escBack).includes('✶ Mercury'), flat(escBack).slice(0, 300))
  if (failures > before || process.env.AGENT_VIEW_KEEP === '1') {
    for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
    dump(`${tag} · final`, cap.text)
    console.log(`  [fixture] ${fixture.hits.map(h => `${h.route}${h.step ? `#${h.step}` : ''}`).join(',')}`)
  }
  if (KEEP) console.log(`  [keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function cockpitLeg(cols: number, rows: number): Promise<void> {
  const tag = `${cols}x${rows} cockpit`
  console.log(`\n— ${tag}: /crewmates' ↵ swaps as before, the rail is the way back —`)
  const before = failures
  const fixture: Fixture = await startCrewStopFixture({ seatTool: 'sleep' })
  const { home, cwd } = seedWorld(false)
  const sends: Array<Record<string, unknown>> = [
    ...bootSends(LEAD_ASK_SLEEPER),
    { data: '/crewmates', atTick: 999, awaitText: LEAD_LINE, requireAwait: true, minTick: 5, awaitSettleTicks: 6, mark: 'launched' },
    { data: '\r', atTick: 999, awaitText: '/crewmates', requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
    { data: '\r', atTick: 999, awaitText: '↵ open in the view', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'popup' },
    { data: ESC, atTick: 999, awaitText: CREWMATE_PLATE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'popup-view' },
    { data: ESC, atTick: 999, awaitText: 'the interrupt ended', requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'cut' },
    { data: '', atTick: 999, awaitText: LEAD_LINE, requireAwait: true, minTick: 2, awaitSettleTicks: 6, mark: 'esc-back' },
  ]
  let cap: Capture | null = null
  try {
    cap = await capture({ cols, rows, total: 520, cwd, argv: ['node', DIST], sends, readyText: LEAD_LINE, readySettleTicks: 3, stableTicks: 6 }, driveEnv(home, fixture.base))
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  for (const [label, frame] of Object.entries(marks)) keep(`${cols}x${rows}-cockpit-${label}`, frame)
  check(`${tag}: every send became due`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const launched = marks['launched'] ?? ''
  check(`${tag}: the rails are shown (the CREW lane lists Mercury Lead and the sleeper)`, has(launched, 'CREW') && has(launched, LEAD_ROW) && has(launched, SEAT_NAME), flat(launched).slice(0, 300))
  const popupView = marks['popup-view'] ?? ''
  check(`${tag}: /crewmates' ↵ opens the sleeper in the view — its rows take the centre, the berth card names it`, crewmateRowsTakeTheCentre(popupView) && has(popupView, `◉ ${SEAT_NAME}`), flat(popupView).slice(0, 300))
  check(`${tag}: the card names the rail as the way back (never the activity screen)`, has(popupView, RAIL_BACK) && !has(popupView, COMPACT_BACK), rowsOf(popupView).filter(row => row.includes('goes back')).map(row => row.trim()).join(' | ').slice(0, 200))
  const cut = marks['cut'] ?? ''
  check(`${tag}: esc interrupts the viewed sleeper, the view stays`, has(cut, 'the interrupt ended') && has(cut, CREWMATE_PLATE), flat(cut).slice(0, 300))
  const escBack = marks['esc-back'] ?? ''
  check(`${tag}: esc on the interrupted sleeper goes back to the lead's rows`, leadRowsBack(escBack), flat(escBack).slice(0, 300))
  if (failures > before || process.env.AGENT_VIEW_KEEP === '1') {
    for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
    dump(`${tag} · final`, cap.text)
    console.log(`  [fixture] ${fixture.hits.map(h => `${h.route}${h.step ? `#${h.step}` : ''}`).join(',')}`)
  }
  if (KEEP) console.log(`  [keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`bundle: ${DIST}`)
for (const { cols, rows, zen } of SIZES) {
  if (!zen && cols >= 100 && rows >= 26) await cockpitLeg(cols, rows)
  else await compactLeg(cols, rows, zen)
}
console.log(failures === 0 ? `\nprove-zen-agent-view-drive: ALL LAWS HOLD (${checks} checks)` : `\nprove-zen-agent-view-drive: ${failures} FAILURE(S) of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
