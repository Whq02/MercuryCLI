#!/usr/bin/env bun
// gate-watch: src/components/concourse/ConcourseScreen.tsx src/components/concourse/WorktreeLaunchCard.tsx src/components/concourse/boardModalOwner.ts
// gate-watch: src/daemon/concourseDispatch.ts src/components/concourse/ConcourseRoute.tsx
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 the restored draft\'s label follows the focus, and the launch preview over the daemon records')
{
  const { restoredDraftLine, RESTORED_DRAFT_LINE, RESTORED_DRAFT_ARMED_LINE, RESTORED_DRAFT_AWAY_LINE } = await import('../../src/components/concourse/ConcourseScreen.tsx')
  const PANE_120 = 38
  check('with the composer focused the label says the draft is restored, that ↵↵ sends and ⌃c clears — the keys the focused composer answers to', restoredDraftLine(true, false) === RESTORED_DRAFT_LINE && RESTORED_DRAFT_LINE.includes('restored draft') && RESTORED_DRAFT_LINE.includes('↵↵ sends') && /(?:⌃|ctrl\+)c clears/.test(RESTORED_DRAFT_LINE))
  check('armed, the label says ↵ again sends and esc keeps', restoredDraftLine(true, true) === RESTORED_DRAFT_ARMED_LINE && RESTORED_DRAFT_ARMED_LINE.includes('↵ again sends') && RESTORED_DRAFT_ARMED_LINE.includes('esc keeps'))
  check('with the focus elsewhere the label promises no composer key — it says to tab to the composer first', restoredDraftLine(false, false) === RESTORED_DRAFT_AWAY_LINE && restoredDraftLine(false, true) === RESTORED_DRAFT_AWAY_LINE && RESTORED_DRAFT_AWAY_LINE.includes('restored draft') && RESTORED_DRAFT_AWAY_LINE.includes('tab') && !RESTORED_DRAFT_AWAY_LINE.includes('↵') && !/⌃|ctrl\+/.test(RESTORED_DRAFT_AWAY_LINE))
  check(`every label fits the coordinator pane's hint row at 120×40 whole (${PANE_120} cells)`, [RESTORED_DRAFT_LINE, RESTORED_DRAFT_ARMED_LINE, RESTORED_DRAFT_AWAY_LINE].every(line => [...line].length <= PANE_120), [RESTORED_DRAFT_LINE, RESTORED_DRAFT_ARMED_LINE, RESTORED_DRAFT_AWAY_LINE].map(line => `${[...line].length}: ${line}`).join(' | '))
  const { boardModalOwner } = await import('../../src/components/concourse/boardModalOwner.ts')
  const none = { capacityAsk: false, trustAsk: false, settingsOpen: false, groundPickerOpen: false, rowPick: false, seatAsk: false, gitOffer: false, contractAsk: false, managerSeatAsk: false, managerCardArmed: false, coordinatorFocused: false }
  check('the worktree card owns the keys while it stands, below the seat card and above the git offer', boardModalOwner({ ...none, forkAsk: true }) === 'fork-ask' && boardModalOwner({ ...none, forkAsk: true, seatAsk: true }) === 'seat-ask' && boardModalOwner({ ...none, forkAsk: true, gitOffer: true }) === 'fork-ask')
  const { previewDefaultedLaunch } = await import('../../src/daemon/concourseDispatch.ts')
  const daemonDir = join(tmpdir(), `restored-draft-daemon-${process.pid}`)
  rmSync(daemonDir, { recursive: true, force: true })
  mkdirSync(daemonDir, { recursive: true })
  const repo = join(daemonDir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const plain = join(daemonDir, 'plain')
  mkdirSync(plain, { recursive: true })
  const repoId = realpathSync(repo)
  const record = (short: string, workspaceId: string, title: string, extra: Record<string, unknown> = {}) => ({
    schema: 1, runnerId: short, sessionId: `s-${short}`, workspaceId, isolation: 'exclusive', modelKey: 'claude-opus-5', spawnedAt: 1, lastLiveAt: 1, attachedAt: Date.now(), title, ...extra,
  })
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { w1: record('concourse-w1', repoId, 'Fix the parser') } }))
  const held = previewDefaultedLaunch(repo, daemonDir)
  check('a defaulted launch into a git checkout a live session holds forks a worktree, and the preview names the holder', held.forks && held.mainHolderTitle === 'Fix the parser', JSON.stringify(held))
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { w1: record('concourse-w1', repoId, 'Fix the parser', { endedAt: 2, attachedAt: undefined }) } }))
  check('a checkout whose only holder has ended does not fork', !previewDefaultedLaunch(repo, daemonDir).forks)
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { w1: record('concourse-w1', realpathSync(plain), 'Notes') } }))
  check('a held plain folder never forks (the git offer is that road)', !previewDefaultedLaunch(plain, daemonDir).forks)
  check('an empty roster never forks', !previewDefaultedLaunch(repo, join(daemonDir, 'nowhere')).forks)
  rmSync(daemonDir, { recursive: true, force: true })
}

if (process.env.PROVE_RESTORED_DRAFT_STATIC === '1') {
  console.log('§2–§4 skipped (PROVE_RESTORED_DRAFT_STATIC=1)')
  process.exit(failures === 0 ? 0 : 1)
}

const POISON_DIST = process.env.MERCURY_RESTORED_DRAFT_POISON_DIST
const BIN = POISON_DIST ?? join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
console.log(POISON_DIST === undefined ? '§2 the drive — a restored draft on arrival (120×40)' : '§2 POISON — the pre-fix bundle: one ↵ on the restored draft launches')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const framesArg = process.argv.indexOf('--frames')
const OUT_DIR = (framesArg !== -1 ? process.argv[framesArg + 1] : undefined) ?? process.env.RESTORED_DRAFT_CAPTURE_DIR ?? join(tmpdir(), `restored-draft-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  requireAwait?: boolean
  data: string
  awaitText?: string
  awaitPattern?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
const ESC = '\x1b'
const FOREIGN = 'change the greeting text from "Hello, " to "Hi there, " and then run python3 hello.py. Do both now.'

function newScratch(tag: string, opts: { draft: boolean; heldRepo?: boolean }): { scratch: string; cwd: string } {
  const scratch = join(tmpdir(), `restored-draft-${tag}-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  const repo = join(scratch, 'held-repo')
  let cwd = REPO
  if (opts.heldRepo === true) {
    mkdirSync(repo, { recursive: true })
    spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
    writeFileSync(join(repo, 'README.md'), 'held\n')
    spawnSync('git', ['-C', repo, '-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', 'add', '.'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repo, '-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', 'commit', '-q', '-m', 'held'], { encoding: 'utf8' })
    cwd = repo
  }
  seedFirstRun(scratch, [REPO, ...(opts.heldRepo === true ? [repo] : [])])
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['concourseCoordinator'] = { mode: 'off' }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  if (opts.draft) {
    writeFileSync(join(scratch, 'concourse-draft.json'), JSON.stringify({ _v: 1, draft: '', updatedAtMs: 1754000000000, coordinatorDraft: FOREIGN, coordinatorDraftCaret: FOREIGN.length }))
  }
  if (opts.heldRepo === true) {
    mkdirSync(join(scratch, 'daemon'), { recursive: true })
    writeFileSync(
      join(scratch, 'daemon', 'concourse-workers.json'),
      JSON.stringify({
        version: 1,
        workers: {
          w1: { schema: 1, runnerId: 'concourse-w1', sessionId: 's-held', workspaceId: realpathSync(repo), isolation: 'exclusive', modelKey: 'claude-opus-5', spawnedAt: 1, lastLiveAt: 1, attachedAt: Date.now(), title: 'Fix the parser' },
        },
      }),
    )
  }
  const fixture = referenceFixtureSnapshot() as Record<string, unknown> & { groups: { rows: { workspaceDir?: string }[] }[]; needsYou: unknown[]; coordinator: unknown; counts: { live: number } }
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  fixture.coordinator = { mode: 'off' }
  fixture.counts.live = 2
  writeFileSync(join(scratch, 'concourse-fixture.json'), JSON.stringify(fixture))
  return { scratch, cwd }
}

const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function capture(tag: string, scratch: string, cwd: string, sends: Send[], total: number, readyText: string): string[] {
  const cols = 120
  const rows = 40
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd, sends, total, progressBudgetTicks: total, readyText, cols, rows, out }))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: scratch,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: join(scratch, 'concourse-fixture.json'),
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    BROWSER: '/usr/bin/true',
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
const paneText = (lines: string[]): string => lines.map(l => (l.split('│')[1] ?? '').trim()).join(' ')
const composerRow = (lines: string[]): string => lines.find(l => /│ │ ❯ /.test(l)) ?? ''
const legendOf = (lines: string[]): string => [...lines].reverse().find(l => l.trim().length > 0) ?? ''
const operatorEntries = (scratch: string): number => {
  const path = join(scratch, 'coordinator-conversation.json')
  if (!existsSync(path)) return 0
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Array<{ role?: string }> }
  return (parsed.entries ?? []).filter(e => e.role === 'operator').length
}
const storedDraft = (scratch: string): string => (JSON.parse(readFileSync(join(scratch, 'concourse-draft.json'), 'utf8')) as { coordinatorDraft?: string }).coordinatorDraft ?? ''
const onArrival = { requireAwait: true, atTick: 999, awaitText: '↵↵ enter session', awaitPattern: 'change the greeting', minTick: 5, awaitSettleTicks: 3 }
const ARMED_LABEL = '↵ again sends'
const scratches: string[] = []

{
  const { scratch, cwd } = newScratch('enter', { draft: true })
  scratches.push(scratch)
  const afterEnter = POISON_DIST === undefined ? 'enters (armed)' : 'coordinator is off —'
  capture('enter', scratch, cwd, [
    { ...onArrival, data: '\r', mark: 'arrival' },
    { requireAwait: true, awaitText: afterEnter, awaitSettleTicks: 3, data: '', mark: 'after-enter' },
  ], 60, afterEnter)
  const arrival = markOf('enter', 'arrival')
  const after = markOf('enter', 'after-enter')
  check('arrival: the stored draft is restored into the coordinator composer', composerRow(arrival).includes('change the greeting') || composerRow(arrival).includes('Do both now.'), composerRow(arrival).trim().slice(0, 100))
  if (POISON_DIST === undefined) {
    check('arrival: the composer carries the restored label — the words came from another window or an earlier visit', has(arrival, 'restored draft'), arrival.filter(l => l.includes('COORDINATOR') || l.includes('❯')).map(l => l.trim().slice(0, 60)).join(' | '))
    check('arrival: the restored draft never takes the focus — the rows have it (the legend is the rows’ own: ↵↵ enter session, no ↵ send)', legendOf(arrival).includes('↵↵ enter session') && !legendOf(arrival).includes('↵ send'), legendOf(arrival).trim().slice(0, 118))
    check('one ↵ launches nothing: no harness line, the draft still stored, no operator entry', !has(after, 'coordinator is off —') && !has(after, 'the daemon that hosts background sessions') && storedDraft(scratch) === FOREIGN && operatorEntries(scratch) === 0, paneText(after).slice(0, 200))
    check('one ↵ did what the rows advertise: it armed the selected session (↵ again enters)', has(after, 'enters (armed)'), legendOf(after).trim().slice(0, 118))
  } else {
    check('POISON (pre-fix bundle): one ↵ on the restored draft LAUNCHED — the harness line painted, the draft was consumed, an operator entry was journaled', has(after, 'coordinator is off —') && storedDraft(scratch) !== FOREIGN && operatorEntries(scratch) === 1, paneText(after).slice(0, 200))
  }
}

if (POISON_DIST !== undefined) {
  for (const s of scratches) rmSync(s, { recursive: true, force: true })
  console.log(failures === 0 ? '\nprove-concourse-restored-draft: POISON SHAPE HOLDS' : `\nprove-concourse-restored-draft: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('§3 the drive — the restored draft in the focused composer: ↵ arms, esc keeps it, ↵↵ sends')
{
  const { scratch, cwd } = newScratch('arm', { draft: true })
  scratches.push(scratch)
  const LAUNCH_RECEIPT = 'applied — started in'
  capture('arm', scratch, cwd, [
    { ...onArrival, data: '\t' },
    { requireAwait: true, awaitText: 'tab panes', awaitSettleTicks: 3, data: '\t', mark: 'before-focus' },
    { requireAwait: true, awaitText: '↵ send', awaitSettleTicks: 3, data: '\r', mark: 'focused' },
    { requireAwait: true, awaitText: ARMED_LABEL, awaitSettleTicks: 3, data: ESC, mark: 'armed' },
    { requireAwait: true, awaitText: 'restored draft · ↵↵ sends', awaitSettleTicks: 3, data: '\r', mark: 'disarmed' },
    { requireAwait: true, awaitText: ARMED_LABEL, awaitSettleTicks: 3, data: '\r', mark: 'armed-again' },
    { requireAwait: true, awaitText: LAUNCH_RECEIPT, awaitSettleTicks: 3, data: '', mark: 'sent' },
  ], 90, LAUNCH_RECEIPT)
  const focused = markOf('arm', 'focused')
  const armed = markOf('arm', 'armed')
  const disarmed = markOf('arm', 'disarmed')
  const sent = markOf('arm', 'sent')
  check('two tabs put the focus on the coordinator composer (the legend says ↵ send)', legendOf(focused).includes('↵ send'), legendOf(focused).trim().slice(0, 118))
  check('the first ↵ in the composer ARMS: the label says ↵ again sends, nothing launched', has(armed, '↵ again sends') && !has(armed, 'coordinator is off —') && composerRow(armed).includes('Do both now.'), paneText(armed).slice(0, 200))
  check('esc disarms — the draft and its restored label stay', has(disarmed, 'restored draft') && !has(disarmed, '↵ again sends') && composerRow(disarmed).includes('Do both now.'), paneText(disarmed).slice(0, 200))
  check('↵↵ sends: the harness line paints, the operator entry is journaled once, the draft is consumed', has(sent, 'coordinator is off —') && operatorEntries(scratch) === 1 && storedDraft(scratch) === '', paneText(sent).slice(0, 240))
}

console.log('§4 the drive — the held checkout: the launch asks before it forks a worktree')
{
  const { scratch, cwd } = newScratch('fork', { draft: true, heldRepo: true })
  scratches.push(scratch)
  const CARD_TITLE = 'A worktree for this session'
  const DRAFT_TAIL = 'Do both now.'
  capture('fork', scratch, cwd, [
    { ...onArrival, data: '\t' },
    { requireAwait: true, awaitText: 'tab panes', awaitSettleTicks: 3, data: '\t' },
    { requireAwait: true, awaitText: '↵ send', awaitSettleTicks: 3, data: '\r' },
    { requireAwait: true, awaitText: ARMED_LABEL, awaitSettleTicks: 3, data: '\r', mark: 'armed' },
    { requireAwait: true, awaitText: CARD_TITLE, awaitSettleTicks: 3, data: ESC, mark: 'card' },
    { requireAwait: true, awaitText: DRAFT_TAIL, awaitPattern: `\\A(?![\\s\\S]*${CARD_TITLE})`, awaitSettleTicks: 3, data: '', mark: 'declined' },
  ], 90, DRAFT_TAIL)
  const card = markOf('fork', 'card')
  const declined = markOf('fork', 'declined')
  check('the confirmed send meets the worktree card before anything starts — it names the folder and the holder', has(card, 'A worktree for this session') && has(card, 'held-repo') && has(card, 'Fix the parser') && !has(card, 'coordinator is off —') && operatorEntries(scratch) === 0, card.filter(l => l.includes('⦿') || l.includes('held by')).map(l => l.trim().slice(0, 100)).join(' | '))
  check('the card offers the fork or nothing', has(card, 'Yes — start it on a worktree') && has(card, 'No, start nothing'), card.filter(l => l.includes('1.') || l.includes('2.')).map(l => l.trim().slice(0, 80)).join(' | '))
  check('esc on the card starts nothing — the card is gone, the draft and its armed label stay, nothing journaled', !has(declined, 'A worktree for this session') && composerRow(declined).includes('Do both now.') && has(declined, ARMED_LABEL) && !has(declined, 'coordinator is off —') && storedDraft(scratch) === FOREIGN && operatorEntries(scratch) === 0, paneText(declined).slice(0, 240))
}

console.log('§5 the drive — the same window: a draft typed here, the screen left and re-entered, comes back labelled and armed; ⌃c clears it where the label says so')
{
  const { scratch, cwd } = newScratch('same', { draft: false })
  scratches.push(scratch)
  const TYPED = 'draft test line, do not send'
  const SHIFT_RIGHT = `${ESC}[1;2C`
  const SHIFT_TAB = `${ESC}[Z`
  const CTRL_C = '\x03'
  const AWAY_LABEL = 'tab here first'
  const EMPTY_COMPOSER = 'describe a task'
  try {
    capture('same', scratch, cwd, [
      { requireAwait: true, atTick: 999, awaitText: 'coordinator model', minTick: 5, awaitSettleTicks: 3, data: TYPED },
      { requireAwait: true, awaitText: 'do not send', awaitSettleTicks: 3, data: ESC, mark: 'typed' },
      { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 3, data: SHIFT_RIGHT, mark: 'away' },
      { requireAwait: true, awaitText: 'do not send', awaitSettleTicks: 3, data: '\r', mark: 'returned' },
      { requireAwait: true, awaitText: 'enters (armed)', awaitSettleTicks: 3, data: SHIFT_TAB, mark: 'after-enter' },
      { requireAwait: true, awaitText: 'restored draft · ↵↵ sends', awaitSettleTicks: 3, data: '\r', mark: 'focused' },
      { requireAwait: true, awaitText: ARMED_LABEL, awaitSettleTicks: 3, data: '\t', mark: 'armed' },
      { requireAwait: true, awaitText: AWAY_LABEL, awaitSettleTicks: 3, data: SHIFT_TAB, mark: 'tabbed-away' },
      { requireAwait: true, awaitText: 'restored draft · ↵↵ sends', awaitSettleTicks: 3, data: CTRL_C, mark: 'back' },
      { requireAwait: true, awaitText: EMPTY_COMPOSER, awaitSettleTicks: 3, data: '', mark: 'cleared' },
    ], 150, EMPTY_COMPOSER)
  } catch (error) {
    check('the same-window drive reached its end (every send fired on its needle; the composer emptied)', false, String(error).slice(-400))
  }
  const typed = markOf('same', 'typed')
  const away = markOf('same', 'away')
  const returned = markOf('same', 'returned')
  const afterEnter = markOf('same', 'after-enter')
  const focused = markOf('same', 'focused')
  const armed = markOf('same', 'armed')
  const tabbedAway = markOf('same', 'tabbed-away')
  const cleared = markOf('same', 'cleared')
  check('the words typed in this window sit in the focused composer with no restored label (they were just typed)', composerRow(typed).includes('do not send') && !has(typed, 'restored draft') && legendOf(typed).includes('↵ send'), `${composerRow(typed).trim().slice(0, 80)} / ${legendOf(typed).trim().slice(0, 80)}`)
  check('esc leaves the screen (the boot face stands) with the words off it', has(away, '↑↓ choose') && !has(away, 'do not send'), legendOf(away).trim().slice(0, 80))
  check('back in the same window the draft is restored from the store WITH the label and the focus on the rows — the label names tab, not ↵ or ⌃c', composerRow(returned).includes('do not send') && has(returned, AWAY_LABEL) && !has(returned, '↵↵ sends') && legendOf(returned).includes('↵↵ enter session') && !legendOf(returned).includes('↵ send'), `${composerRow(returned).trim().slice(0, 80)} / ${returned.filter(l => l.includes('restored')).map(l => l.trim().slice(0, 60)).join(' | ')} / ${legendOf(returned).trim().slice(0, 100)}`)
  check('one ↵ sends nothing: no harness line, no operator entry, the words still in the composer; the rows armed as they advertise', !has(afterEnter, 'coordinator is off —') && operatorEntries(scratch) === 0 && composerRow(afterEnter).includes('do not send') && has(afterEnter, 'enters (armed)'), paneText(afterEnter).slice(0, 200))
  check('⇧tab onto the composer: the label now names the composer keys (↵↵ sends · ⌃c clears)', has(focused, 'restored draft · ↵↵ sends') && legendOf(focused).includes('↵ send'), focused.filter(l => l.includes('restored')).map(l => l.trim().slice(0, 60)).join(' | '))
  check('the first ↵ in the composer arms (↵ again sends), nothing launched', has(armed, '↵ again sends') && !has(armed, 'coordinator is off —') && operatorEntries(scratch) === 0, paneText(armed).slice(0, 200))
  check('tab away from the armed composer disarms it — the label falls back to the away words, so no ↵ elsewhere can send', has(tabbedAway, AWAY_LABEL) && !has(tabbedAway, '↵ again sends') && composerRow(tabbedAway).includes('do not send'), tabbedAway.filter(l => l.includes('restored')).map(l => l.trim().slice(0, 60)).join(' | '))
  check('⌃c in the focused composer clears the draft, as the label said: the composer is empty, the label gone, the store empty, nothing sent', has(cleared, EMPTY_COMPOSER) && !has(cleared, 'do not send') && !has(cleared, 'restored draft') && storedDraft(scratch) === '' && operatorEntries(scratch) === 0, `${composerRow(cleared).trim().slice(0, 80)} / stored ${JSON.stringify(storedDraft(scratch))}`)
}

for (const s of scratches) rmSync(s, { recursive: true, force: true })
console.log(`  captures: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-restored-draft: ALL LAWS HOLD' : `\nprove-concourse-restored-draft: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
