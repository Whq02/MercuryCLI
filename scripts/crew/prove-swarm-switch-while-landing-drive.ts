#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, section, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { untilAsync } from '../lib/untilAsync.ts'
import { readSessionWorkers } from '../../src/daemon/concourseWorkers.ts'
import { open } from '../../src/services/crewBoard/store.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Leg = Awaited<ReturnType<typeof startLeg>>
type Wire = { model?: string; tools?: Array<{ name: string }>; messages?: unknown[] }

const driver = requireCaptureDriver('swarm-switch-while-landing')
const COLS = 120
const ROWS = 50
const CREW_MODEL = 'claude-fable-5-1'
const PROMPT = 'Launch the crew.'
const PLAIN_PROMPT = 'Say the first reply.'
const ASK = '@main ALPHA-ASK which file first?'
const WAITING = 'Lead is waiting.'
const WOKEN = 'WAKE-REPLY.'
const NOTED = 'ALPHA-NOTED.'
const FIRST = 'FIRST-REPLY.'
const SWARM_ON = 'Swarm on for new crewmates'
const OWNER_LINE = 'hello crew'
const TITLE = 'Landing name'
const CONTRACT = 'the work agreed'
const textRows = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
const then = (data: string, awaitText: string, mark?: string): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 2, awaitSettleTicks: 3, ...(mark ? { mark } : {}) })
const atOnce = (data: string, awaitText: string): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 0, awaitSettleTicks: 0 })
const typed = (line: string): Array<Record<string, unknown>> => [atOnce(line, ADMITTED), atOnce('\r', line)]
const enter = { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' }
const crew = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: CREW_MODEL, whenModel: 'fable-5-1' }) as ScriptedTurn
const crewScript = (): ScriptedTurn[] => [
  { kind: 'tool_use', name: 'Crewmate', input: { name: 'alpha', model: CREW_MODEL, crewmate_type: 'mercury-crew', description: 'Ask the lead', prompt: 'Post your question to the lead on the board, wait a little, then finish.', run_in_background: true } },
  { kind: 'text', text: WAITING },
  { kind: 'text', text: WOKEN, whenBody: 'ALPHA-ASK' },
  { kind: 'text', text: NOTED },
  { kind: 'text', text: 'SPARE-ONE.' },
  { kind: 'text', text: 'SPARE-TWO.' },
  crew({ kind: 'tool_use', name: 'CrewBoard', input: { op: 'post', clientOpId: 'alpha-ask', kind: 'ask', text: ASK } }),
  crew({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 6', description: 'Wait a little' } }),
  crew({ kind: 'text', text: 'ALPHA-FINAL.' }),
  handoffTurn(),
]

function filesUnder(dir: string, keep: (name: string) => boolean, skip: (name: string) => boolean = () => false): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (!skip(entry)) out.push(...filesUnder(path, keep, skip))
    } else if (keep(entry)) out.push(path)
  }
  return out
}
const boardFiles = (leg: Leg): string[] => filesUnder(leg.home, name => name === 'board.sqlite')
const chatFiles = (leg: Leg): string[] => filesUnder(join(leg.home, 'projects'), name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(name), name => name === 'lineage')
const boardSession = (path: string): string => basename(dirname(dirname(dirname(path))))
const workersOf = (leg: Leg): Array<{ sessionId?: string; pid?: number; endedAt?: number; title?: string; contract?: { text?: string; status?: string } }> => {
  const dir = join(leg.home, 'daemon')
  return existsSync(dir) ? (Object.values(readSessionWorkers(dir)) as never) : []
}
const sessionOf = (leg: Leg): string => workersOf(leg)[0]?.sessionId ?? ''
const recordOf = (leg: Leg): string[] => {
  const file = chatFiles(leg).find(path => basename(path, '.jsonl') === sessionOf(leg))
  if (file === undefined) return []
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const eventsOf = (path: string): string[] => {
  try {
    const board = open(path, boardSession(path))
    try {
      return board.view().events.map(event => JSON.stringify(event))
    } finally {
      board.close()
    }
  } catch {
    return []
  }
}
const requestsOf = (leg: Leg): Wire[] => leg.fixture.messageRequests().map(request => request.body as Wire)
const offers = (request: Wire, tool: string): boolean => (request.tools ?? []).some(candidate => candidate.name === tool)
const says = (request: Wire, words: string): boolean => JSON.stringify(request.messages ?? []).includes(words)
const rowOf = (rows: string[], ...needles: string[]): number => rows.findIndex(row => needles.every(needle => row.includes(needle)))
const commandAt = (rows: string[], verb: string): number => rowOf(rows, '"kind":"input"', `<command-name>/swarm</command-name><command-args>${verb}</command-args>`)
const promptAt = (rows: string[], words: string): number => rowOf(rows, '"kind":"input"', `"content":"${words}"`)
const switchRows = (rows: string[]): string[] => rows.filter(row => row.includes('"metaKind":"swarm-switch"')).map(row => (row.includes('"on":true') ? 'on' : 'off'))
const inOrder = (lines: string[], needles: string[]): boolean => {
  let at = -1
  for (const needle of needles) {
    const next = lines.findIndex((line, index) => index > at && line.includes(needle))
    if (next < 0) return false
    at = next
  }
  return true
}
const short = (paths: string[], leg: Leg): string => paths.map(path => path.replace(leg.home, '<home>')).join(' · ')

function stopDaemon(leg: Leg): void {
  for (const worker of workersOf(leg)) {
    if (worker.pid && worker.endedAt === undefined) {
      try {
        process.kill(worker.pid, 'SIGTERM')
      } catch {
      }
    }
  }
  try {
    const pid = Number(readFileSync(join(leg.home, 'daemon', 'daemon.pid'), 'utf8').trim())
    if (pid > 1) process.kill(pid, 'SIGTERM')
  } catch {
  }
}
const daemonGone = (leg: Leg): boolean => {
  try {
    const pid = Number(readFileSync(join(leg.home, 'daemon', 'daemon.pid'), 'utf8').trim())
    if (!(pid > 1)) return true
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function capture(tag: string, leg: Leg, argv: string[], sends: unknown[], readyText: string, total: number, during?: (ended: () => boolean) => Promise<void>): Promise<{ status: number | null; marks: Map<string, string[]>; final: string[]; log: string }> {
  const out = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, ...argv], cwd: leg.cwd, cols: COLS, rows: ROWS, sends, resizes: [], total, out, readyText: [readyText], readySettleTicks: 6 }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: leg.cwd, env: childEnv(leg, { TMPDIR: '.', MERCURY_DESKTOP_DRIVER: 'none', MERCURY_CRITTER: 'clam' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', chunk => { log += String(chunk) })
  child.stderr.on('data', chunk => { log += String(chunk) })
  let ended = false
  const status = new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(total * 200 + 60_000))
    child.once('error', error => { log += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); ended = true; resolve(code) })
  })
  if (during !== undefined) await during(() => ended)
  const code = await status
  const marks = new Map<string, string[]>()
  let final: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    for (const mark of payload.marks ?? []) marks.set(mark.label, textRows(mark.grid))
    final = payload.grid ? textRows(payload.grid) : []
  }
  return { status: code, marks, final, log }
}

async function legOf(tag: string, turns: ScriptedTurn[]): Promise<Leg> {
  const leg = await startLeg(tag, turns, null, project)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Bash(sleep *)'] }, view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  return leg
}

const project = realpathSync(scratch)

section('§1 /swarm off and then the first prompt, both typed while the session lands')
{
  const leg = await legOf('landing-off', crewScript())
  let boardsBeforeOn: string[] | null = null
  const run = await capture('off', leg, ['--chat'], [
    enter,
    ...typed('/swarm off'),
    ...typed(PROMPT),
    then('', WAITING, 'waiting'),
    then('', NOTED, 'noted'),
    then('/swarm on', NOTED),
    then('\r', '/swarm on'),
    then('', SWARM_ON, 'on-after'),
  ], SWARM_ON, 600, async ended => {
    if (await untilAsync(() => recordOf(leg).some(row => row.includes(NOTED)) || ended(), vshotBudgetMs(120_000), 50)) boardsBeforeOn = boardFiles(leg)
  })
  const sid = sessionOf(leg)
  const record = recordOf(leg)
  const requests = requestsOf(leg)
  const boards = boardFiles(leg)
  const chats = chatFiles(leg)
  stopDaemon(leg)
  const noted = run.marks.get('noted') ?? []
  const after = run.marks.get('on-after') ?? run.final
  printFrame('the first prompt answered, the swarm off', noted)
  printFrame('/swarm on typed after the first prompt', after)
  check('the capture ran every send (engine exit 0)', run.status === 0 && sid !== '', `exit ${run.status} · session ${sid} · ${run.log.slice(-400)}`)
  const offAt = commandAt(record, 'off')
  const askedAt = promptAt(record, PROMPT)
  check('the conversation heard the switch: its record holds /swarm off, and before the first prompt as typed (the parent\'s record holds no such row: its window answered for itself)', offAt >= 0 && askedAt > offAt, `/swarm off at row ${offAt}, the prompt at row ${askedAt}, of ${record.length}`)
  check('…and the switch it recorded says off, then on once /swarm on is typed', switchRows(record).includes('off') && switchRows(record).at(-1) === 'on', switchRows(record).join(' '))
  check('the first prompt\'s crewmate was launched with no board: no request of the lead or of the crewmate offers CrewBoard (the parent offers it in every one)', requests.length >= 4 && requests.every(request => !offers(request, 'CrewBoard')), requests.map(request => `${request.model}:${offers(request, 'CrewBoard')}`).join(' '))
  check('…so the lead is not woken by a post: it waits, then notes the crewmate\'s end (the parent\'s lead is woken and answers the post)', record.some(row => row.includes(NOTED)) && !record.some(row => row.includes(WOKEN)) && !requests.some(request => says(request, 'crew-board-event:')), `woken ${record.some(row => row.includes(WOKEN))} · packets ${requests.filter(request => says(request, 'crew-board-event:')).length}`)
  check('no board file stands under the home while the swarm is off', boardsBeforeOn !== null && (boardsBeforeOn as string[]).length === 0, boardsBeforeOn === null ? 'never sampled' : short(boardsBeforeOn, leg))
  check('/swarm on after the first prompt behaves as it did: the command, its answer and the launch row', inOrder(after, [NOTED, '/swarm on', `${SWARM_ON}.`]) && after.some(line => line.includes('[main] Swarm launched')), after.filter(line => line.includes('warm')).map(line => line.trim()).join(' | '))
  check('…and it makes the one board file, under the conversation\'s id', boards.length === 1 && boardSession(boards[0]!) === sid, short(boards, leg))
  check('one conversation file under the home, the conversation\'s', chats.length === 1 && basename(chats[0]!, '.jsonl') === sid, short(chats, leg))
  await endLeg(leg)
}

section('§2 /swarm on typed while the session lands, then the first prompt')
{
  const leg = await legOf('landing-on', crewScript())
  const run = await capture('on', leg, ['--chat'], [
    enter,
    ...typed('/swarm on'),
    then(PROMPT, SWARM_ON),
    then('\r', PROMPT),
    then('', WOKEN, 'woken'),
    then('', NOTED, 'noted'),
  ], NOTED, 600)
  const sid = sessionOf(leg)
  const record = recordOf(leg)
  const requests = requestsOf(leg)
  const boards = boardFiles(leg)
  const chats = chatFiles(leg)
  stopDaemon(leg)
  const woken = run.marks.get('woken') ?? []
  printFrame('woken by the crewmate\'s post', woken)
  check('the capture ran every send (engine exit 0)', run.status === 0 && sid !== '', `exit ${run.status} · session ${sid} · ${run.log.slice(-400)}`)
  check('ONE board file stands under the home, the conversation\'s (the parent leaves a second, under the window\'s own id)', boards.length === 1 && boardSession(boards[0]!) === sid, short(boards, leg))
  const mine = boards.find(path => boardSession(path) === sid)
  check('…and it holds the crewmate\'s post', mine !== undefined && eventsOf(mine).some(event => event.includes(ASK)), mine === undefined ? 'no board under the conversation' : `${eventsOf(mine).length} events`)
  const onAt = commandAt(record, 'on')
  const askedAt = promptAt(record, PROMPT)
  check('the conversation heard the switch: its record holds /swarm on before the first prompt, and the switch it recorded says on (the parent\'s holds neither)', onAt >= 0 && askedAt > onAt && switchRows(record).length > 0 && switchRows(record).every(state => state === 'on'), `/swarm on at row ${onAt}, the prompt at row ${askedAt}, switch rows ${switchRows(record).join(' ') || 'none'}`)
  check('the lead is woken by the post and reads it: the turn that answers carries the board\'s packet with the post', record.some(row => row.includes(WOKEN)) && requests.some(request => !request.model?.includes('fable') && says(request, 'crew-board-event:') && says(request, 'ALPHA-ASK')), `woken ${record.some(row => row.includes(WOKEN))}`)
  check('…and the screen paints the post as the seat\'s own row above the lead\'s answer', inOrder(woken, [WAITING, `[alpha] ${ASK}`, WOKEN]), woken.filter(line => line.includes('alpha') || line.includes('REPLY') || line.includes('waiting')).map(line => line.trim()).join(' | '))
  check('one conversation file under the home, the conversation\'s', chats.length === 1 && basename(chats[0]!, '.jsonl') === sid, short(chats, leg))

  await untilAsync(() => daemonGone(leg), vshotBudgetMs(30_000), 100)
  const resumed = await capture('resumed', leg, ['--resume', sid], [then('', NOTED, 'resumed')], NOTED, 400)
  const again = resumed.marks.get('resumed') ?? resumed.final
  const boardsAgain = boardFiles(leg)
  stopDaemon(leg)
  printFrame('the session resumed in a new window', again)
  check('the session resumed in a new window paints its post and its answers again', resumed.status === 0 && inOrder(again, [`[alpha] ${ASK}`, WOKEN, NOTED]), `exit ${resumed.status} · ${again.filter(line => line.includes('alpha') || line.includes('REPLY') || line.includes('NOTED')).map(line => line.trim()).join(' | ')}`)
  check('…and keeps its board: the conversation\'s file is where it was and still holds the post', mine !== undefined && boardsAgain.includes(mine) && eventsOf(mine).some(event => event.includes(ASK)), short(boardsAgain, leg))
  check('…and resuming made no other board file', boardsAgain.length === boards.length, short(boardsAgain, leg))
  await endLeg(leg)
}

section('§3 the other verbs typed while the session lands: a title, an owner\'s line to the crew, a contract, then the first prompt')
{
  const leg = await legOf('landing-wider', [
    { kind: 'text', text: FIRST },
    { kind: 'text', text: 'SPARE-ONE.' },
    { kind: 'text', text: 'SPARE-TWO.' },
    handoffTurn(),
  ])
  const run = await capture('wider', leg, ['--chat'], [
    enter,
    ...typed(`/rename ${TITLE}`),
    ...typed(`/general ${OWNER_LINE}`),
    ...typed(`/contract ${CONTRACT}`),
    ...typed(PLAIN_PROMPT),
    then('', FIRST, 'replied'),
  ], FIRST, 500)
  const sid = sessionOf(leg)
  const worker = workersOf(leg).find(candidate => candidate.sessionId === sid)
  const requests = requestsOf(leg)
  const boards = boardFiles(leg)
  const chats = chatFiles(leg)
  stopDaemon(leg)
  const replied = run.marks.get('replied') ?? run.final
  printFrame('the first prompt answered', replied)
  check('the capture ran every send (engine exit 0)', run.status === 0 && sid !== '', `exit ${run.status} · session ${sid} · ${run.log.slice(-400)}`)
  check('/rename titled the conversation (the parent titles a file of the window\'s own and leaves the conversation unnamed)', worker?.title === TITLE, `the session's title: ${JSON.stringify(worker?.title)}`)
  check('…and left no file under the window\'s id: one conversation file under the home, the conversation\'s', chats.length === 1 && basename(chats[0]!, '.jsonl') === sid, short(chats, leg))
  check('the owner\'s /general line is on the conversation\'s board, the one board file under the home (the parent posts it to a board of the window\'s own, where nobody reads it)', boards.length === 1 && boardSession(boards[0]!) === sid && eventsOf(boards[0]!).some(event => event.includes(`"text":"${OWNER_LINE}"`)), `${short(boards, leg)} · ${boards.map(path => eventsOf(path).length).join(',')} events`)
  const first = requests[0]
  check('…and the lead reads it in the first turn, in the board\'s packet', first !== undefined && says(first, 'crew-board-event:') && says(first, OWNER_LINE), `first request: packet ${first !== undefined && says(first, 'crew-board-event:')} · the line ${first !== undefined && says(first, OWNER_LINE)}`)
  check('/contract answered for the landed session: its record holds the drafted contract (the parent says no chat is open)', worker?.contract?.text === CONTRACT, `the session's contract: ${JSON.stringify(worker?.contract)}`)
  check('the prompt typed after them is answered', inOrder(replied, [PLAIN_PROMPT, FIRST]), replied.filter(line => line.includes('REPLY') || line.includes(PLAIN_PROMPT)).map(line => line.trim()).join(' | '))
  await endLeg(leg)
}

rmSync(scratch, { recursive: true, force: true })
finish('swarm-switch-while-landing')
