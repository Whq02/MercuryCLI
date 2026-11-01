#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { untilAsync } from '../lib/untilAsync.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, type AvailableCaptureDriver } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { distBuildTree } from '../lib/refDist.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { resolveMercuryTokens } from '../../src/utils/mercuryTokens.ts'
import { TERRA } from '../../src/components/mercuryPalette.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const KEEP = process.argv.includes('--keep')
const DIST = argAfter('--dist') ?? process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('§0 the reader law: system rows recorded one after another after the last reply all survive a cold load')
{
  const { transcriptRows } = await import('../../src/utils/sessionStorage/rowGraph.ts')
  const base = (uuid: string, parentUuid: string | null, timestamp: string) => ({ uuid, parentUuid, timestamp, isSidechain: false, sessionId: 's', cwd: '/', version: '0', entrypoint: 'cli' })
  const user = (uuid: string, parent: string | null, text: string, t: string) => ({ ...base(uuid, parent, t), type: 'user', message: { role: 'user', content: text } })
  const assistant = (uuid: string, parent: string | null, id: string, text: string, t: string) => ({ ...base(uuid, parent, t), type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] }, requestId: id })
  const system = (uuid: string, parent: string | null, subtype: string, content: string, t: string) => ({ ...base(uuid, parent, t), type: 'system', subtype, content, level: 'info' })
  const painted = (rows: unknown[]): string => {
    const map = new Map(rows.map(row => [(row as { uuid: string }).uuid, row])) as never
    const graph = transcriptRows(map)
    const leaves = [...graph.resumeLeaves()]
    return graph.chain((map as Map<string, never>).get(leaves[leaves.length - 1]!)!).map((row: { uuid: string }) => row.uuid).join(' ')
  }
  check('two board rows after the last reply both paint', painted([user('u1', null, 'hi', '1'), assistant('a1', 'u1', 'm1', 'hello', '2'), system('c1', 'a1', 'crew_chat', 'one', '3'), system('c2', 'c1', 'crew_chat', 'two', '4')]) === 'u1 a1 c1 c2')
  check('three board rows after the last reply all paint, in file order', painted([user('u1', null, 'hi', '1'), assistant('a1', 'u1', 'm1', 'hello', '2'), system('c1', 'a1', 'crew_chat', 'one', '3'), system('c2', 'c1', 'crew_chat', 'two', '4'), system('c3', 'c2', 'crew_chat', 'three', '5')]) === 'u1 a1 c1 c2 c3')
  check('two local command rows after the last reply both paint', painted([user('u1', null, 'hi', '1'), assistant('a1', 'u1', 'm1', 'hello', '2'), system('l1', 'a1', 'local_command', '/usage', '3'), system('l2', 'l1', 'local_command', '/help', '4')]) === 'u1 a1 l1 l2')
  const attachment = (uuid: string, parent: string | null, t: string) => ({ ...base(uuid, parent, t), type: 'attachment', attachment: { type: 'usage' } })
  check('board rows under the attachment that closed the last turn both paint', painted([user('u1', null, 'hi', '1'), assistant('a1', 'u1', 'm1', 'hello', '2'), attachment('t1', 'a1', '3'), system('c1', 't1', 'crew_chat', 'one', '4'), system('c2', 'c1', 'crew_chat', 'two', '5')]) === 'u1 a1 c1 c2')
  check('board rows followed by a prompt and its reply paint whole', painted([user('u1', null, 'hi', '1'), assistant('a1', 'u1', 'm1', 'hello', '2'), system('c1', 'a1', 'crew_chat', 'one', '3'), system('c2', 'c1', 'crew_chat', 'two', '4'), user('u2', 'c2', 'next', '5'), assistant('a2', 'u2', 'm2', 'reply', '6')]) === 'u1 a1 c1 c2 u2 a2')
}

const resolved = resolveCaptureDriver()
if (resolved.kind !== 'posix-pty') {
  console.log(`__SUITE_SKIPPED swarm-party-rows: ${resolved.kind === 'unavailable' ? `${resolved.reason} (${resolved.remedy})` : `the ${resolved.kind} capture driver is not driven by this proof`}`)
  process.exit(failures === 0 ? 0 : 1)
}
const driver: AvailableCaptureDriver = resolved
const nodeBeside = (dist: string): string => {
  const vendored = join(dirname(dist), 'vendor', 'node', 'bin', 'node')
  return existsSync(vendored) ? vendored : 'node'
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-party-rows-')))
const home = join(SCRATCH, 'home')
const work = join(SCRATCH, 'work')
const daemonDir = join(home, 'daemon')
const FRAMES = argAfter('--frames') ?? join(SCRATCH, 'frames')
for (const dir of [home, work, FRAMES]) mkdirSync(dir, { recursive: true })
writeFileSync(join(work, 'README.md'), '# the swarm-party-rows fixture\n')
seedFirstRun(home, [work])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true }, activity: { tips: { enabled: false } }, swarm: { enabled: true } }))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const turns: ScriptedTurn[] = Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'Lead is waiting.' }))
const api = await startFixtureApi(turns)
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_HOME: join(home, 'proof-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_UPDATE_NOTICE: '0',
  MERCURY_OPERATOR: 'sam',
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  BROWSER: '/usr/bin/true',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  COLORTERM: 'truecolor',
}
for (const key of ['NODE_ENV', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL', 'MERCURY_CRITTER', 'CI']) delete childEnv[key]

type Cell = { c: string; fg: string }
type Grid = { grid: Cell[][] }
type Payload = Grid & { marks?: ({ label: string; atTick: number } & Grid)[]; endReason?: string; sendReceipts?: unknown[] }
type Send = Record<string, unknown>
type Frame = { lines: string[]; grid: Cell[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
type Capture = { frames: Map<string, Frame>; endReason: string; receipts: number; status: number | null }
async function capture(tag: string, cols: number, rows: number, argv: string[], sends: Send[], readyText: string, total: number): Promise<Capture> {
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  const outPath = join(SCRATCH, `${tag}-grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [nodeBeside(DIST), DIST, ...argv], cwd: work, cols, rows, total, sends, readyText: [readyText], stableTicks: 6, out: outPath }))
  const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: work, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => { output += String(c) })
  child.stderr.on('data', c => { output += String(c) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(total * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(join(SCRATCH, `${tag}-vshot.log`), output)
  const frames = new Map<string, Frame>()
  let endReason = 'no capture'
  let receipts = 0
  if (existsSync(outPath)) {
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as Payload
    endReason = payload.endReason ?? 'unknown'
    receipts = payload.sendReceipts?.length ?? 0
    for (const m of payload.marks ?? []) {
      frames.set(m.label, { lines: linesOf(m), grid: m.grid })
      writeFileSync(join(FRAMES, `${tag}-${m.label}.txt`), linesOf(m).join('\n') + '\n')
    }
    frames.set('final', { lines: linesOf(payload), grid: payload.grid })
    writeFileSync(join(FRAMES, `${tag}-final.txt`), linesOf(payload).join('\n') + '\n')
  }
  return { frames, endReason, receipts, status }
}

function newestTranscript(): string | null {
  const projects = join(home, 'projects')
  const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [])
  const found = walk(projects).filter(p => /\/[0-9a-f-]{36}\.jsonl$/.test(p) && !p.includes('/lineage/')).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return found[0] ?? null
}
type Painted = { id: string; text: string; at: string; fields: Record<string, unknown> }
function paintedRows(transcript: string): Painted[] {
  const out: Painted[] = []
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.includes('"crew_chat"')) continue
    let entry: { recordId: string; updates?: string; occurredAt?: string; payload?: { kind?: string; noticeKind?: string; content?: unknown; fields?: Record<string, unknown> } }
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.updates !== undefined || entry.payload?.kind !== 'notice' || entry.payload.noticeKind !== 'crew_chat') continue
    out.push({ id: entry.recordId, text: String(entry.payload.content ?? ''), at: String(entry.occurredAt ?? ''), fields: entry.payload.fields ?? {} })
  }
  return out
}
const sqlite = await import('bun:sqlite')
const mainExecutionOf = (path: string): string => {
  const db = new sqlite.Database(path, { readonly: true })
  try { return String((db.prepare("SELECT execution FROM members WHERE agent = 'main'").get() as { execution: string }).execution) } finally { db.close() }
}

const FACE = { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 }
const BACK = '← back'
const after = (awaitText: string, mark: string, settle = 6): Send => ({ data: '', atTick: 999, awaitText, requireAwait: true, minTick: 2, awaitSettleTicks: settle, mark })
const type = (data: string, awaitBefore: string): Send => ({ data, atTick: 999, awaitText: awaitBefore, requireAwait: true, minTick: 2, awaitSettleTicks: 2 })

const MULTI = 'first line of one post ROW-MULTI\nsecond line of the same post stays its body\nthird line closes it ROW-MULTI-END'
const LONG = 'The long post keeps going well past the width of a narrow terminal so that it has to wrap onto several lines, and every one of its words must still be on the screen in order, without an ellipsis and without a second clock or name on the continuation lines. ROW-LONG-END'
const NARROW = 'A second long post for the narrow window, posted live after the resume, wraps the same way and keeps every word on the screen without any shortening. ROW-NARROW-END'

type Seat = { author: { sessionId: string; agentId: string; executionId: string }; name: string; team?: string }
let transcript: string | null = null
let sessionId: string | null = null
let boardPath: string | null = null
let clock = Date.now()
async function director(): Promise<string[]> {
  const notes: string[] = []
  await untilAsync(() => { transcript = newestTranscript(); return transcript !== null }, vshotBudgetMs(90_000), 200)
  sessionId = (JSON.parse(readFileSync(transcript!, 'utf8').split('\n')[0]!) as { sessionId: string }).sessionId
  boardPath = join(dirname(transcript!), sessionId, 'boards', 'wave', 'board.sqlite')
  await untilAsync(() => existsSync(boardPath!) && paintedRows(transcript!).some(row => row.text === 'Swarm launched'), vshotBudgetMs(90_000), 200)
  const { open } = await import('../../src/services/crewBoard/store.ts')
  const board = open(boardPath!, sessionId!, undefined, () => (clock += 20_000))
  const mainExecution = (): string => mainExecutionOf(boardPath!)
  const main = (): Seat => ({ author: { sessionId: sessionId!, agentId: 'main', executionId: mainExecution() }, name: 'main' })
  const judge: Seat = { author: { sessionId: sessionId!, agentId: 'a-judge', executionId: 'e-judge' }, name: 'lists-judge', team: 'lists' }
  const writer: Seat = { author: { sessionId: sessionId!, agentId: 'a-writer', executionId: 'e-writer' }, name: 'lists-writer', team: 'lists' }
  const solo: Seat = { author: { sessionId: sessionId!, agentId: 'a-solo', executionId: 'e-solo' }, name: 'solo' }
  const landed = (marker: string): Promise<boolean> => untilAsync(() => paintedRows(transcript!).some(row => row.text.includes(marker)), vshotBudgetMs(60_000), 100)
  const repliesRecorded = (): number => new Set(readFileSync(transcript!, 'utf8').split('\n').filter(line => line.includes('"kind":"output"')).map(line => { try { return String((JSON.parse(line) as { recordId: string }).recordId) } catch { return line } })).size
  const wakes = async (label: string, act: () => Promise<unknown>): Promise<void> => {
    const before = repliesRecorded()
    await act()
    const woke = await untilAsync(() => repliesRecorded() > before, vshotBudgetMs(60_000), 100)
    await new Promise(tick => setTimeout(tick, 600))
    leadWakes.push(woke)
    notes.push(`${label}: the lead ${woke ? 'woke, replied and closed its turn' : 'did not wake within the budget'} (${repliesRecorded()} replies recorded)`)
  }
  const post = async (who: Seat, clientOpId: string, text: string, extra: Record<string, unknown> = {}, marker = text.split(' ').at(-1)!): Promise<string> => {
    const receipt = board.post(who, { clientOpId, kind: 'result', text, ...extra } as never)
    if (!receipt.ok) { notes.push(`${clientOpId} refused: ${receipt.reason}`); return '' }
    if (marker !== '') await landed(marker)
    return receipt.eventId
  }
  try {
    board.enroll(judge)
    board.enroll(writer)
    board.enroll(solo)
    await untilAsync(() => paintedRows(transcript!).filter(row => row.text === 'Joined').length >= 3, vshotBudgetMs(60_000), 100)
    const ask = await post(judge, 'row-ask', '@lists-writer is the list ready? ROW-ASK', { kind: 'ask' })
    await post(writer, 'row-answer', 'nearly, two rows left ROW-ANSWER', { kind: 'answer', replyTo: ask })
    const result = await post(writer, 'row-multi', MULTI, {}, 'ROW-MULTI-END')
    await wakes('the @all blocker', () => post(solo, 'row-blocker', '@all the disk is full ROW-BLOCKER', { kind: 'blocker' }))
    await post(writer, 'row-correction', 'six rows, not five ROW-CORRECTION', { kind: 'correction', corrects: result })
    await post(main(), 'row-lead', 'the lead notes it ROW-LEAD')
    await wakes("the owner's whisper", async () => {
      const whisper = board.postOwner(main(), { clientOpId: 'row-owner', text: 'ship it ROW-OWNER', channel: 'whisper', target: 'solo' })
      if (!whisper.ok) notes.push(`owner whisper refused: ${whisper.reason}`)
      await landed('ROW-OWNER')
    })
    const captain = board.assignCaptain(main(), 'lists', 'lists-judge')
    if (!captain.ok) notes.push(`captain refused: ${captain.reason}`)
    await post(judge, 'row-long', LONG, {}, 'ROW-LONG-END')
    const judgeResumed: Seat = { ...judge, author: { ...judge.author, executionId: 'e-judge-resumed' } }
    board.enroll(judgeResumed)
    const message = board.post(writer, { clientOpId: 'row-message', kind: 'message', text: 'a shared message, not a post ROW-MESSAGE', to: ['lists-judge'] }, 'body')
    if (!message.ok) notes.push(`message refused: ${message.reason}`)
    const notice = board.post(solo, { clientOpId: 'row-notice', kind: 'notice', text: 'a plain mirrored notice ROW-NOTICE' }, 'mirror')
    if (!notice.ok) notes.push(`notice refused: ${notice.reason}`)
    const done = board.post(solo, { clientOpId: 'row-done', kind: 'notice', text: 'Crewmate "solo" completed', lifecycle: { kind: 'done' } }, 'mirror')
    if (!done.ok) notes.push(`done refused: ${done.reason}`)
    await post(writer, 'row-last', 'closing the wide leg ROW-LAST')
    notes.push(`wide leg posted; the board holds ${board.view().snapshot} events`)
    await untilAsync(() => narrowPhase, vshotBudgetMs(240_000), 200)
    await untilAsync(() => mainExecution() !== firstExecution, vshotBudgetMs(120_000), 200)
    await new Promise(tick => setTimeout(tick, 1500))
    await post(judgeResumed, 'row-narrow', NARROW, {}, 'ROW-NARROW-END')
    notes.push('narrow leg posted')
  } catch (error) {
    notes.push(`director stopped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    board.close()
  }
  return notes
}
let narrowPhase = false
let firstExecution = ''
const leadWakes: boolean[] = []

const THEME = ((JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as { theme?: string }).theme ?? 'dark') as Parameters<typeof resolveMercuryTokens>[0]
const palette = resolveMercuryTokens(THEME, TERRA)
const hex = (color: string): string => {
  const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (rgb) return rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')
  return color.replace('#', '').toLowerCase()
}
const seatInk = (slot: number): string => hex(palette.agentAccents[slot]!.color)
const fgOf = (frame: Frame, marker: string, part: 'clock' | 'name' | 'body'): string | null => {
  const y = frame.lines.findIndex(line => line.includes(marker))
  if (y < 0) return null
  const line = frame.lines[y]!
  const clockAt = line.search(/\d\d:\d\d:\d\d \[/)
  if (clockAt < 0) return null
  const open = line.indexOf('[', clockAt), close = line.indexOf(']', open)
  const range: [number, number] = part === 'clock' ? [clockAt, clockAt + 8] : part === 'name' ? [open + 1, close] : [close + 2, line.indexOf(marker) + marker.length]
  const colors = new Set<string>()
  for (let x = range[0]; x < range[1]; x++) { const cell = frame.grid[y]?.[x]; if (cell && cell.c !== ' ') colors.add(cell.fg) }
  return colors.size === 1 ? [...colors][0]! : `mixed:${[...colors].join('/')}`
}
const rowLine = (frame: Frame, marker: string): string => { const line = frame.lines.find(line => line.includes(marker)) ?? ''; return line.split('│').find(part => part.includes(marker))?.trim() ?? line.trim() }
const text = (frame: Frame): string => collapse(frame.lines.map(line => line.replace(/[│╭╮╰╯─]/g, ' ')).join(' '))

console.log(`board posts paint as chat rows: the shape, the palette, lifecycle, long and multiline text, excluded bodies, at 120x44 and 80x24\n  bundle ${DIST} (build tree ${distBuildTree(DIST)?.slice(0, 12) ?? 'unknown'})\n  fixture ${api.url}\n  scratch ${SCRATCH}\n  frames ${FRAMES}\n  theme ${THEME}`)
try {
  section('§1 the wide window: every public kind, main, the owner, two seats of one team, a captain, lifecycle, long and multiline text')
  const directing = director()
  const wide = await capture('wide', 120, 44, [], [
    FACE,
    after(BACK, 'boot', 4),
    type('/swarm on\r', BACK),
    type('/swarmchat\r', 'Swarm on for new crewmates'),
    after('Swarm launched', 'launched', 4),
    after('[solo] Joined', 'joined', 4),
    after('ROW-OWNER', 'owner', 4),
    after('ROW-LAST', 'rows', 8),
  ], 'ROW-LAST', 600)
  check('the wide window ran its journey to the end', wide.endReason === 'stable' || wide.endReason === 'ready', `endReason ${wide.endReason} · ${wide.receipts} sends fired · vshot exit ${wide.status}`)
  const rows = wide.frames.get('rows') ?? wide.frames.get('final')!
  const wideText = text(rows)
  for (const [label, needle] of [
    ['the launch row', '[main] Swarm launched'],
    ['a Joined row for each seat', '[lists-judge] Joined'],
    ['an ask by a labelled seat', '[lists-judge] @lists-writer is the list ready? ROW-ASK'],
    ['an answer', '[lists-writer] nearly, two rows left ROW-ANSWER'],
    ['a blocker', '[solo] @all the disk is full ROW-BLOCKER'],
    ['a correction', '[lists-writer] six rows, not five ROW-CORRECTION'],
    ["the lead's own post", '[main] the lead notes it ROW-LEAD'],
    ["the owner's whisper as its sender receipt", '[owner] @solo ship it ROW-OWNER'],
    ['a captain row, named at the time of its post', '[captain lists-judge] The long post keeps going'],
    ['the completion row', '[solo] Done'],
  ] as const) check(`${label}: ${needle}`, wideText.includes(needle), wideText.slice(-1200))
  check('the ask was posted before the appointment and keeps its plain plate', wideText.includes('[lists-judge] @lists-writer') && !wideText.includes('[captain lists-judge] @lists-writer'))
  check('a resumed seat does not join again: one Joined row per seat', (wideText.match(/\[lists-judge\] Joined/g) ?? []).length === 1 && (wideText.match(/\[lists-writer\] Joined/g) ?? []).length === 1 && (wideText.match(/\[solo\] Joined/g) ?? []).length === 1)
  check('one completion, one launch', (wideText.match(/\[solo\] Done/g) ?? []).length === 1 && (wideText.match(/Swarm launched/g) ?? []).length === 1)
  check('a message body and a plain notice never reach the chat', !wideText.includes('ROW-MESSAGE') && !wideText.includes('ROW-NOTICE'))
  check('the multiline post paints its three lines literally, in order', wideText.includes('first line of one post ROW-MULTI second line of the same post stays its body third line closes it ROW-MULTI-END'), wideText.slice(wideText.indexOf('ROW-MULTI') - 40, wideText.indexOf('ROW-MULTI') + 160))
  check('the continuation lines carry no second clock or name', !/second line of the same post/.test(rowLine(rows, 'second line')) || !/\d\d:\d\d:\d\d \[/.test(rowLine(rows, 'second line')), rowLine(rows, 'second line'))
  check('the long post is whole at 120 columns', wideText.includes(collapse(LONG)), wideText.slice(wideText.indexOf('The long post') - 30, wideText.indexOf('The long post') + 300))
  const order = ['ROW-ASK', 'ROW-ANSWER', 'ROW-MULTI-END', 'ROW-BLOCKER', 'ROW-CORRECTION', 'ROW-LEAD', 'ROW-OWNER', 'ROW-LONG-END', '[solo] Done', 'ROW-LAST'].map(marker => wideText.indexOf(marker))
  check('rows follow the board sequence', order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), order.join(','))
  check('every row opens with its clock', ['ROW-ASK', 'ROW-ANSWER', 'ROW-BLOCKER', 'ROW-CORRECTION', 'ROW-LEAD', 'ROW-OWNER', 'ROW-LAST', '[solo] Done', 'Swarm launched'].every(marker => /^\d\d:\d\d:\d\d \[/.test(rowLine(rows, marker))), ['ROW-ASK', 'ROW-OWNER'].map(marker => rowLine(rows, marker)).join(' | '))
  const recorded = transcript === null ? [] : paintedRows(transcript)
  const clockOf = (marker: string): string | null => { const row = recorded.find(row => row.text.includes(marker)); if (!row) return null; const d = new Date(row.at); return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` }
  const lines = transcript === null ? [] : readFileSync(transcript, 'utf8').split('\n')
  const lineOf = (needle: string): number => lines.findIndex(line => line.includes(needle))
  const launched = recorded.find(row => row.text === 'Swarm launched')
  check('the launch row a typed /swarmchat introduces is an idle row: no turn anchors it', launched !== undefined && launched.fields.turnId === undefined, JSON.stringify(launched?.fields ?? null))
  check("and it is recorded after the command's own output, never before its echo", lineOf('local-command-stdout>Swarm chat on') >= 0 && lineOf('"content":"Swarm launched"') > lineOf('local-command-stdout>Swarm chat on'), `${lineOf('"content":"Swarm launched"')} vs ${lineOf('local-command-stdout>Swarm chat on')}`)
  check('the @all blocker and the owner\'s whisper each woke the idle lead, and the scene waited for each turn to close before posting on', leadWakes.length === 2 && leadWakes.every(Boolean), JSON.stringify(leadWakes))
  check('the rows posted after those turns closed are idle rows: Done and the closing post carry no turn', ['[solo] Done', 'ROW-LAST'].every(marker => { const row = recorded.find(row => (marker === '[solo] Done' ? row.text === 'Done' && row.fields.name === 'solo' : row.text.includes(marker))); return row !== undefined && row.fields.turnId === undefined }), recorded.filter(row => row.text === 'Done' || row.text.includes('ROW-LAST')).map(row => `${row.text.slice(0, 12)}:${String(row.fields.turnId)}`).join(' | '))
  check('the Joined rows that arrived while the lead was idle carry no turn either', recorded.filter(row => row.text === 'Joined').length === 3 && recorded.filter(row => row.text === 'Joined').every(row => row.fields.turnId === undefined), recorded.filter(row => row.text === 'Joined').map(row => String(row.fields.turnId)).join(','))
  check("the clock is the post's own time, not the paint time", ['ROW-ASK', 'ROW-LAST'].every(marker => { const clock = clockOf(marker); return clock !== null && rowLine(rows, marker).includes(clock) }), ['ROW-ASK', 'ROW-LAST'].map(marker => `${clockOf(marker)} vs ${rowLine(rows, marker).slice(0, 12)}`).join(' | '))

  section('§2 the palette: grey clock and body, one ink per seat in join order, the lead in the first accent, the owner in the primary ink, a blocker body in the failure ink')
  const grey = hex(palette.textSecondary)
  check(`the clock is grey (${grey})`, ['ROW-ASK', 'ROW-BLOCKER', 'ROW-OWNER'].every(marker => fgOf(rows, marker, 'clock') === grey), ['ROW-ASK', 'ROW-BLOCKER', 'ROW-OWNER'].map(marker => fgOf(rows, marker, 'clock')).join(' / '))
  check('an ask, an answer and a correction keep a grey body', ['ROW-ASK', 'ROW-ANSWER', 'ROW-CORRECTION'].every(marker => fgOf(rows, marker, 'body') === grey), ['ROW-ASK', 'ROW-ANSWER', 'ROW-CORRECTION'].map(marker => fgOf(rows, marker, 'body')).join(' / '))
  check(`a blocker's body wears the failure ink (${hex(palette.failureText)})`, fgOf(rows, 'ROW-BLOCKER', 'body') === hex(palette.failureText), String(fgOf(rows, 'ROW-BLOCKER', 'body')))
  check(`the first seat enrolled paints accent 1 (${seatInk(1)})`, fgOf(rows, 'ROW-ASK', 'name') === seatInk(1), String(fgOf(rows, 'ROW-ASK', 'name')))
  check(`its team-mate, enrolled second, paints accent 2 (${seatInk(2)}) on every row`, fgOf(rows, 'ROW-ANSWER', 'name') === seatInk(2) && fgOf(rows, 'ROW-CORRECTION', 'name') === seatInk(2) && fgOf(rows, 'ROW-LAST', 'name') === seatInk(2), `${fgOf(rows, 'ROW-ANSWER', 'name')} / ${fgOf(rows, 'ROW-CORRECTION', 'name')} / ${fgOf(rows, 'ROW-LAST', 'name')}`)
  check('the captain plate wears its seat ink whole', fgOf(rows, 'The long post keeps going', 'name') === seatInk(1), String(fgOf(rows, 'The long post keeps going', 'name')))
  check(`the third seat, without a label, paints accent 3 (${seatInk(3)})`, fgOf(rows, 'ROW-BLOCKER', 'name') === seatInk(3), String(fgOf(rows, 'ROW-BLOCKER', 'name')))
  check(`the lead keeps the first accent (${hex(palette.agentAccents[0]!.color)})`, fgOf(rows, 'ROW-LEAD', 'name') === hex(palette.agentAccents[0]!.color), String(fgOf(rows, 'ROW-LEAD', 'name')))
  check(`the owner's name is the primary ink (${hex(palette.textPrimary)}), its body grey`, fgOf(rows, 'ROW-OWNER', 'name') === hex(palette.textPrimary) && fgOf(rows, 'ROW-OWNER', 'body') === grey, `${fgOf(rows, 'ROW-OWNER', 'name')} / ${fgOf(rows, 'ROW-OWNER', 'body')}`)
  check('lifecycle rows are grey bodies with the seat ink on the name', fgOf(rows, '[solo] Done', 'body') === grey && fgOf(rows, '[solo] Done', 'name') === seatInk(3) && fgOf(rows, '[solo] Joined', 'name') === seatInk(3), `${fgOf(rows, '[solo] Done', 'body')} / ${fgOf(rows, '[solo] Done', 'name')} / ${fgOf(rows, '[solo] Joined', 'name')}`)

  section('§3 the narrow window: the same session resumed at 80x24 paints the rows again, wraps a long post whole, and takes a live post')
  await untilAsync(() => transcript === null || !existsSync(`${transcript}.writer.lock`), vshotBudgetMs(30_000))
  firstExecution = boardPath === null ? '' : mainExecutionOf(boardPath)
  narrowPhase = true
  const narrow = await capture('narrow', 80, 24, ['--continue'], [
    after('ROW-LAST', 'boot', 8),
    after('ROW-NARROW-END', 'narrow', 8),
  ], 'ROW-NARROW-END', 480)
  const notes = await directing
  for (const note of notes) console.log(`  ${note}`)
  check('the narrow window ran its journey to the end', narrow.endReason === 'stable' || narrow.endReason === 'ready', `endReason ${narrow.endReason} · ${narrow.receipts} sends fired · vshot exit ${narrow.status}`)
  const boot = narrow.frames.get('boot')
  check('the resumed narrow screen paints the newest rows of the wide leg', boot !== undefined && text(boot).includes('ROW-LAST') && text(boot).includes('[solo] Done'), boot === undefined ? 'no boot frame' : text(boot).slice(-600))
  check(`the replayed rows keep their seat inks after the cold resume (${seatInk(2)}, ${seatInk(3)})`, boot !== undefined && fgOf(boot, 'ROW-LAST', 'name') === seatInk(2) && fgOf(boot, '[solo] Done', 'name') === seatInk(3), boot === undefined ? 'no boot frame' : `${fgOf(boot, 'ROW-LAST', 'name')} / ${fgOf(boot, '[solo] Done', 'name')}`)
  const narrowFrame = narrow.frames.get('narrow') ?? narrow.frames.get('final')!
  const narrowText = text(narrowFrame)
  check('a long post posted live wraps whole at 80 columns, every word in order, no shortening', narrowText.includes(collapse(NARROW)) && !narrowText.includes('…'), narrowText.slice(narrowText.indexOf('A second long post') - 20, narrowText.indexOf('A second long post') + 260))
  const narrowLines = narrowFrame.lines.filter(line => line.includes('second long post') || line.includes('narrow window') || line.includes('ROW-NARROW-END') || line.includes('wraps the same way'))
  check('the wrapped post spans several screen lines with one clock and one name', narrowLines.length >= 2 && narrowLines.filter(line => /\d\d:\d\d:\d\d \[/.test(line)).length === 1, narrowLines.join(' | '))
  check('the narrow rows keep the shape: clock, bracketed name, body', /^\d\d:\d\d:\d\d \[captain lists-judge\] A second long post/.test(rowLine(narrowFrame, 'A second long post')), rowLine(narrowFrame, 'A second long post'))
  check(`the seat re-enrolled for the resume posts live in its own ink, accent 1 (${seatInk(1)})`, fgOf(narrowFrame, 'A second long post', 'name') === seatInk(1), String(fgOf(narrowFrame, 'A second long post', 'name')))
  if (transcript !== null) {
    const all = paintedRows(transcript)
    check('no row was recorded twice across the two windows', new Set(all.map(row => row.id)).size === all.length, `${all.length} rows`)
    check('the excluded bodies never reached the transcript either', !all.some(row => row.text.includes('ROW-MESSAGE') || row.text.includes('ROW-NOTICE')))
  }
} finally {
  await api.close()
  if (failures === 0 && !KEEP && argAfter('--frames') === undefined) removeScratch(SCRATCH)
  else console.log(`\n  frames and transcripts kept at ${SCRATCH}`)
}
console.log(failures === 0 ? `\n✅ BOARD ROWS PAINT AS THE CONTRACT SAYS — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
