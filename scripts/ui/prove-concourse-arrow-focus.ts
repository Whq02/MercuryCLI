#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const ordered = (hay: string, a: string, b: string): boolean => {
  const ia = hay.indexOf(a)
  const ib = hay.indexOf(b)
  return ia !== -1 && ib !== -1 && ia < ib
}

console.log('§1 the resolver — the coordinator legend drops the ↑↓ row, every board-side region keeps it')
{
  const { browseKeysFor, regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const keysOf = (rows: ReadonlyArray<{ keys: string; label: string }>): string[] => rows.map(k => k.keys)
  const coordinator = browseKeysFor({ chatPresent: true, region: 'coordinator' })
  check('the coordinator legend prints no ↑↓ row (a printed key that does not fire is a lie)', !keysOf(coordinator).includes('↑↓'), keysOf(coordinator).join(','))
  for (const region of ['list', 'live', 'chat', 'rail'] as const) {
    const rows = browseKeysFor({ chatPresent: true, region })
    check(`the ${region} legend keeps '↑↓ browse' (the key fires there)`, rows.some(k => k.keys === '↑↓' && k.label === 'browse'), keysOf(rows).join(','))
  }
  check(
    'the region-less rows (the atlas) name where the key fires',
    browseKeysFor({ chatPresent: true }).find(k => k.keys === '↑↓')?.label === 'browse (list · live · split)',
  )
  check(
    'the coordinator call keeps every other base row in order, esc still relabelled by chat presence',
    keysOf(coordinator).join(',') === keysOf(browseKeysFor({ chatPresent: true, region: 'list' })).filter(k => k !== '↑↓').join(',') &&
      browseKeysFor({ chatPresent: false, region: 'coordinator' }).find(k => k.keys === 'esc')?.label === 'boot face' &&
      coordinator.find(k => k.keys === 'esc')?.label === 'focused chat',
  )
  const own = regionKeysFor('coordinator', { newSession: true })
  check("the coordinator's own rows never claim a board browse and still teach ↵ send", own.every(k => k.keys !== '↑↓') && own.some(k => k.keys === '↵' && k.label === 'send'))
}

console.log('§2 the screen — the board-browse arm no longer names the coordinator; the board-side arms stand')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'POISON: the pre-fix browse arm that named the coordinator is gone',
    !screen.includes("(region === 'live' || region === 'coordinator') &&") &&
      !screen.includes("(region === 'coordinator' ? draftRef : liveDraftRef).current.text.includes(NL)"),
    'the coordinator panel still browses the board on ↑↓',
  )
  check(
    'the board-browse arm fires from the live panel on a single-line draft (its ↵ enters the same selection)',
    screen.includes("(region === 'live' && (key.upArrow || key.downArrow) && !liveDraftRef.current.text.includes(NL))"),
  )
  check('… and from the split chat pane (split-view D5 stands)', screen.includes("(region === 'chat' && (key.upArrow || key.downArrow))"))
  const listStart = screen.indexOf("if (region === 'list') {")
  const listEnd = screen.indexOf("if (region === 'chat') {", listStart)
  const list = screen.slice(listStart, listEnd)
  check(
    'the rows keep their own ↑↓ browse and their ↵',
    listStart > 0 && list.includes('if (key.upArrow || key.downArrow) {') && list.includes('if (key.return && pastGate()) {') && list.includes('selectSession(row.sessionId)'),
  )
  const enterStart = screen.indexOf('if (key.return && !key.shift) {')
  const enterEnd = screen.indexOf('if (reducedStage) {', enterStart)
  const enter = screen.slice(enterStart, enterEnd)
  check(
    "the coordinator's ↵ is still the pane's own (an empty draft leaves it to the example walk; words send) — never a board enter",
    enterStart > 0 &&
      enter.includes("if (region === 'coordinator') {") &&
      enter.includes('if (draftRef.current.text.trim().length === 0) return') &&
      enter.includes('sendCoordinator()') &&
      !enter.slice(0, enter.indexOf("if (region !== 'live') return")).includes('enterSession('),
  )
  check(
    'the live panel keeps its browse because its ↵ ENTERS the selection on an empty draft (arrows and ↵ agree there)',
    enter.includes("if (region !== 'live') return") && enter.includes('if (sel) enterSession(sel.sessionId)'),
  )
  check('the screen names the law where the arm lives', screen.includes('THE ARROW-FOCUS LAW'))
  const pane = read('src/components/concourse/CoordinatorPane.tsx')
  check(
    'the pane owns its ↑↓ only while focused (the zero-state example walk consumes them before the screen)',
    ordered(pane, 'if (!focused) return', 'if (entries !== null && entries.length === 0 && (key.upArrow || key.downArrow)) {') &&
      ordered(pane, 'if (entries !== null && entries.length === 0 && (key.upArrow || key.downArrow)) {', 'event.stopImmediatePropagation()\n      const n = COORDINATOR_EXAMPLE_PROMPTS.length'),
  )
}

console.log('§3 the legend — the footer hands its region to the resolver; the atlas reads the region-less rows')
{
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the footer legend hands the focused region to the one resolver', layout.includes('const browseKeys = browseKeysFor({ chatPresent: chat, region })'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the atlas reads the region-less rows (the row names where it fires)', screen.includes('keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY]'))
  const manifest = read('src/components/concourse/controlManifest.ts')
  check(
    'the manifest states the law at the resolver',
    manifest.includes('THE ARROW-FOCUS LAW') && manifest.includes("opts.region === 'coordinator' ? CONCOURSE_BROWSE_KEYS.filter(k => k.keys !== '↑↓')"),
  )
}

if (process.env.PROVE_ARROW_FOCUS_STATIC === '1') {
  console.log('§4 skipped (PROVE_ARROW_FOCUS_STATIC=1)')
  process.exit(failures === 0 ? 0 : 1)
}
const POISON_DIST = process.env.MERCURY_ARROW_FOCUS_POISON_DIST
const BIN = POISON_DIST ?? join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
console.log(POISON_DIST === undefined ? '§4 the drive — the built bundle at 120×40' : '§4 POISON — the pre-fix bundle: the selection moves from the coordinator')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const { COORDINATOR_EXAMPLE_PROMPTS } = await import('../../src/components/concourse/CoordinatorPane.tsx')
const OUT_DIR = process.env.ARROW_FOCUS_CAPTURE_DIR ?? join(tmpdir(), `arrow-focus-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
const ESC = '\x1b'
const DOWN = `${ESC}[B`

function newScratch(tag: string, seedConversation: boolean): string {
  const scratch = join(tmpdir(), `arrow-focus-${tag}-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  seedFirstRun(scratch, [REPO])
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  if (seedConversation) {
    const ts = 1754000000000
    writeFileSync(
      join(scratch, 'coordinator-conversation.json'),
      JSON.stringify(
        {
          entries: [
            { id: 'op:1', role: 'operator', text: 'what model are you running on?', ts },
            { id: 'co:1', role: 'coordinator', text: 'Mercury, running on `claude-opus-5` (Opus 5) — that is the engine this seat dispatches on.', ts: ts + 1000 },
          ],
          _v: 1,
        },
        null,
        2,
      ) + '\n',
    )
  }
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
  writeFileSync(join(scratch, 'concourse-fixture.json'), JSON.stringify(fixture))
  return scratch
}

const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function capture(tag: string, scratch: string, sends: Send[], total: number): string[] {
  const cols = 120
  const rows = 40
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total, cols, rows, out }))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: scratch,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: join(scratch, 'concourse-fixture.json'),
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${(res.stderr ?? '').slice(-600)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    markedFrames.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return lines
}
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
const hasWrapped = (lines: string[], needle: string): boolean =>
  lines
    .map(l => (l.split('│')[1] ?? '').trim())
    .join(' ')
    .includes(needle)
const selRow = (lines: string[]): number => lines.findIndex(l => /▸ /.test(l) && /Audit|Fix OAuth|Refactor|Update/.test(l))
const titleOf = (line: string | undefined): string => (line ?? '').match(/(?:Audit|Fix OAuth|Refactor|Update)(?: \S+)*/)?.[0] ?? ''
const sameTitle = (a: string, b: string): boolean => {
  const x = a.split('…')[0] ?? ''
  const y = b.split('…')[0] ?? ''
  return x.length >= 8 && (x.startsWith(y) || y.startsWith(x))
}
const settle = { atTick: 999, awaitText: 'Fix OAuth', minTick: 5, awaitSettleTicks: 2 }
const scratches: string[] = []

{
  const scratch = newScratch('coord', true)
  scratches.push(scratch)
  const lines = capture('coord', scratch, [
    { ...settle, data: DOWN, mark: 'before' },
    { afterPrevTicks: 3, data: '\r', mark: 'after-down' },
    { afterPrevTicks: 3, data: '', mark: 'after-enter' },
  ], 70)
  const before = markOf('coord', 'before')
  const afterDown = markOf('coord', 'after-down')
  const afterEnter = markOf('coord', 'after-enter')
  const rowBefore = selRow(before)
  const rowAfter = selRow(afterDown)
  const nextRow = before.findIndex((l, i) => i > rowBefore && titleOf(l) !== '')
  check(
    'coord: the pane is OUT of its zero state (conversation painted or opening — the example walk is not in play)',
    (hasWrapped(before, 'what model are you running on?') || has(before, 'opening the conversation')) && !has(before, COORDINATOR_EXAMPLE_PROMPTS[0]),
    before.find(l => l.includes('COORDINATOR'))?.trim().slice(0, 80) ?? '(no coordinator pane)',
  )
  check('coord: before any key the ▸ selection sits on the first session row', rowBefore >= 0 && titleOf(before[rowBefore]) !== '' && nextRow > rowBefore, `row=${rowBefore} title=${JSON.stringify(titleOf(before[rowBefore]))}`)
  if (POISON_DIST === undefined) {
    check(
      'coord: ↓ with the coordinator focused leaves the ▸ selection EXACTLY where it was',
      rowAfter === rowBefore && sameTitle(titleOf(afterDown[rowAfter]), titleOf(before[rowBefore])),
      `before=${rowBefore}:${JSON.stringify(titleOf(before[rowBefore]))} after=${rowAfter}:${JSON.stringify(titleOf(afterDown[rowAfter]))}`,
    )
    check('coord: ↵ with the coordinator focused does not arm the row (the legend never says enters (armed)) and the board stays', !has(afterEnter, 'enters (armed)') && has(afterEnter, 'SESSIONS') && has(lines, 'SESSIONS'))
    const legend = afterEnter.find(l => l.includes('tab panes')) ?? ''
    check("coord: the coordinator-focused footer prints no '↑↓ browse' and still prints '↵ send'", legend !== '' && !legend.includes('↑↓ browse') && legend.includes('↵ send'), legend.trim().slice(0, 118))
  } else {
    check(
      'POISON (pre-fix bundle): ↓ from the coordinator MOVED the ▸ selection onto the second row while ↵ still did not enter',
      rowAfter > rowBefore && sameTitle(titleOf(afterDown[rowAfter]), titleOf(before[nextRow])) && !has(afterEnter, 'enters (armed)') && has(afterEnter, 'SESSIONS'),
      `before=${rowBefore} after=${rowAfter}`,
    )
  }
}

{
  const scratch = newScratch('zero', false)
  scratches.push(scratch)
  capture('zero', scratch, [
    { ...settle, data: DOWN, mark: 'before' },
    { afterPrevTicks: 3, data: '', mark: 'after' },
  ], 60)
  const before = markOf('zero', 'before')
  const after = markOf('zero', 'after')
  const first = COORDINATOR_EXAMPLE_PROMPTS[0]
  const second = COORDINATOR_EXAMPLE_PROMPTS[1]
  const marked = (lines: string[], prompt: string): boolean => lines.some(l => l.includes(prompt) && l.includes('· ↵'))
  check('zero: the pane paints its example prompts with the first highlighted (· ↵ fills the box)', marked(before, first) && !marked(before, second), before.find(l => l.includes(first))?.trim().slice(0, 100) ?? '(no example row)')
  check('zero: ↓ walked the highlight to the second example — the pane received the key and spent it on its own meaning', marked(after, second) && !marked(after, first), after.find(l => l.includes(second))?.trim().slice(0, 100) ?? '(no example row)')
  check('zero: the ▸ selection stayed on the first session row', selRow(after) === selRow(before) && selRow(before) >= 0, `before=${selRow(before)} after=${selRow(after)}`)
}

{
  const scratch = newScratch('list', true)
  scratches.push(scratch)
  capture('list', scratch, [
    { ...settle, data: '\t', mark: 'before' },
    { afterPrevTicks: 3, data: DOWN },
    { afterPrevTicks: 3, data: '\r', mark: 'after-down' },
    { afterPrevTicks: 3, data: '', mark: 'after-enter' },
  ], 80)
  const before = markOf('list', 'before')
  const afterDown = markOf('list', 'after-down')
  const afterEnter = markOf('list', 'after-enter')
  const rowBefore = selRow(before)
  const rowAfter = selRow(afterDown)
  const nextRow = before.findIndex((l, i) => i > rowBefore && titleOf(l) !== '')
  check(
    'list: after tab → the rows, ONE ↓ moved the ▸ selection onto the second row',
    rowBefore >= 0 && rowAfter > rowBefore && sameTitle(titleOf(afterDown[rowAfter]), titleOf(before[nextRow])),
    `before=${rowBefore}:${JSON.stringify(titleOf(before[rowBefore]))} after=${rowAfter}:${JSON.stringify(titleOf(afterDown[rowAfter]))} expected=${JSON.stringify(titleOf(before[nextRow]))}`,
  )
  const legend = afterEnter.find(l => /enters \(armed\)/.test(l)) ?? ''
  check('list: ↵ on the rows ARMS the selected row (the legend says enters (armed) — the second ↵ enters)', legend !== '', afterEnter.find(l => l.includes('tab panes'))?.trim().slice(0, 118) ?? '(no legend row)')
}

for (const s of scratches) rmSync(s, { recursive: true, force: true })
console.log(`  captures: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-arrow-focus: ALL LAWS HOLD' : `\nprove-concourse-arrow-focus: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
