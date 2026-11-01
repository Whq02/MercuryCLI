import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { DIST, NODE, closeWorld, findFiles, makeTally, makeWorld, record } from './crew-world.ts'
import { hostRunner, type HostedRunner } from '../lib/runnerHost.ts'

const { open } = await import('../../src/services/crewBoard/store.ts')
const requireRuntime = createRequire(import.meta.url)
const { runSwarmchatCommand } = await import('../../src/commands/swarmchat/swarmchat.ts')
const tally = makeTally('swarm-party-controls')
const USAGE = 'usage: /swarmchat [all|team <name>|main] — /swarmchat alone toggles board messages in the chat'

tally.section('§0 the grammar refuses bad syntax before it looks at any switch')
for (const raw of ['bogus', 'team', 'all extra', 'team lists extra', 'main now', 'ALL']) tally.check(`"/swarmchat ${raw}" answers the usage line`, runSwarmchatCommand(raw) === USAGE, runSwarmchatCommand(raw))
tally.check('without the master Swarm setting every valid form names /config once', ['', 'all', 'main', 'team lists'].every(raw => runSwarmchatCommand(raw) === 'Swarm is off — enable swarm.enabled in your user settings.json (/config → Swarm).'), runSwarmchatCommand(''))

const world = await makeWorld('swarm-party-controls', Array.from({ length: 24 }, () => ({ kind: 'text' as const, text: 'Lead is waiting.' })))
const settings = join(world.config, 'settings.json')
writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
let raw = ''
const boot = (argv: string[]): HostedRunner => hostRunner({ dist: DIST, node: NODE, cwd: world.project, home: world.config, env: world.env as Record<string, string | undefined>, argv: ['--model', 'claude-fable-5-1', '--allowed-tools', 'Bash', 'CrewBoard', ...argv], raw: line => { raw += line } })
let host = boot([])
const until = async (label: string, test: () => boolean, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`${label}\n--- rows tail ---\n${raw.slice(-2000)}\n--- stderr tail ---\n${host.stderr().slice(-1500)}`)
    await new Promise(tick => setTimeout(tick, 25))
  }
}
const command = async (text: string): Promise<string> => {
  const before = raw.length
  await host.prompt(text)
  await until(`${text} answered`, () => raw.slice(before).includes('"type":"command_output"'))
  const line = raw.slice(before).split('\n').find(l => l.includes('"type":"command_output"'))!
  return String((JSON.parse(line) as { params: { text: string } }).params.text)
}
type Painted = { id: string; text: string; fields: Record<string, unknown> }
const paintedRows = (transcript: string): Painted[] => {
  const out: Painted[] = []
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.includes('"crew_chat"')) continue
    let entry: { recordId: string; updates?: string; payload?: { kind?: string; noticeKind?: string; content?: unknown; fields?: Record<string, unknown> } }
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.updates !== undefined || entry.payload?.kind !== 'notice' || entry.payload.noticeKind !== 'crew_chat') continue
    out.push({ id: entry.recordId, text: String(entry.payload.content ?? ''), fields: entry.payload.fields ?? {} })
  }
  return out
}
let board: ReturnType<typeof open> | undefined
let transcript = ''
try {
  await host.initialize({ partial_rows: true })
  tally.section('§1 the session switch comes first; the controls never enable it')
  tally.check('before /swarm on, /swarmchat names the switch to flip', (await command('/swarmchat')) === 'Swarm is off for this session — /swarm on enables it.')
  tally.check('and so does /swarmchat all', (await command('/swarmchat all')) === 'Swarm is off for this session — /swarm on enables it.')
  tally.check('neither opened a board', findFiles(world.config, 'board.sqlite').length === 0)
  const swarmOn = await command('/swarm on')
  tally.check('/swarm on answers its usual words', swarmOn.startsWith('Swarm on for new crewmates'), swarmOn)
  const path = findFiles(world.config, 'board.sqlite')[0]!
  const sessionDir = dirname(dirname(dirname(path)))
  const sid = basename(sessionDir)
  transcript = join(dirname(sessionDir), `${sid}.jsonl`)
  let clock = Date.now()
  board = open(path, sid, undefined, () => (clock += 20_000))
  const mainExecution = (): string => {
    const db = new (requireRuntime('bun:sqlite').Database)(path, { readonly: true }) as { prepare(sql: string): { get(): { execution: string } }; close(): void }
    try { return String(db.prepare("SELECT execution FROM members WHERE agent = 'main'").get().execution) } finally { db.close() }
  }
  const main = () => ({ author: { sessionId: sid, agentId: 'main', executionId: mainExecution() }, name: 'main' })
  const judge = { author: { sessionId: sid, agentId: 'a-judge', executionId: 'e-judge' }, name: 'lists-judge', team: 'lists' }
  const writer = { author: { sessionId: sid, agentId: 'a-writer', executionId: 'e-writer' }, name: 'lists-writer', team: 'lists' }
  const solo = { author: { sessionId: sid, agentId: 'a-solo', executionId: 'e-solo' }, name: 'solo' }
  const scout = { author: { sessionId: sid, agentId: 'a-scout', executionId: 'e-scout' }, name: 'scout', team: 'maps' }
  type Seat = { author: { sessionId: string; agentId: string; executionId: string }; name: string; team?: string }
  const post = (who: Seat, clientOpId: string, text: string, extra: Record<string, unknown> = {}): string => {
    const receipt = board!.post(who, { clientOpId, kind: 'result', text, ...extra } as never)
    assert(receipt.ok, JSON.stringify(receipt))
    return receipt.eventId
  }
  const painted = (): Painted[] => paintedRows(transcript)
  const settled = (): Promise<void> => new Promise(tick => setTimeout(tick, 750))
  const landed = async (marker: string): Promise<void> => until(`${marker} painted`, () => painted().some(row => row.text.includes(marker)))
  const absent = (marker: string): boolean => !painted().some(row => row.text.includes(marker))

  tally.section('§2 every grammar arm, through the runner')
  tally.check('a fresh board starts off, filter all', JSON.stringify(board.chat()) === JSON.stringify({ on: false, filter: { kind: 'all' } }), JSON.stringify(board.chat()))
  tally.check('/swarmchat toggles on', (await command('/swarmchat')) === 'Swarm chat on' && board.chat().on === true)
  await landed('Swarm launched')
  tally.check("the first enable introduces the wave's launch row once", painted().filter(row => row.text === 'Swarm launched').length === 1 && painted()[0]!.fields.name === 'main')
  tally.check('/swarmchat toggles off', (await command('/swarmchat')) === 'Swarm chat off' && board.chat().on === false)
  const unknownLabel = await command('/swarmchat team lists')
  tally.check('an unknown team changes nothing and says so', unknownLabel === 'No team lists on the board.' && board.chat().on === false, unknownLabel)
  board.enroll(judge)
  board.enroll(writer)
  board.enroll(solo)
  board.enroll(scout)
  const labelWords = await command('/swarmchat team LISTS')
  tally.check('team selects an existing team by its canonical spelling, case-insensitively', labelWords === 'Swarm chat · team lists' && JSON.stringify(board.chat()) === JSON.stringify({ on: true, filter: { kind: 'team', team: 'lists' } }), labelWords)
  const stillUnknown = await command('/swarmchat team nobody')
  tally.check('an unknown team leaves the current filter in place and names the teams', stillUnknown === 'No team nobody on the board — teams: lists, maps.' && board.chat().filter.kind === 'team', stillUnknown)
  tally.check('the toggle off keeps the filter', (await command('/swarmchat')) === 'Swarm chat off' && JSON.stringify(board.chat()) === JSON.stringify({ on: false, filter: { kind: 'team', team: 'lists' } }))
  tally.check('and the toggle on brings it back', (await command('/swarmchat')) === 'Swarm chat on' && JSON.stringify(board.chat()) === JSON.stringify({ on: true, filter: { kind: 'team', team: 'lists' } }))
  tally.check('main selects traffic addressed to the lead', (await command('/swarmchat main')) === 'Swarm chat · main' && board.chat().filter.kind === 'main')
  tally.check('all selects everything', (await command('/swarmchat all')) === 'Swarm chat · all' && board.chat().filter.kind === 'all')
  tally.check('bad syntax through the runner answers the usage line and changes nothing', (await command('/swarmchat nonsense')) === USAGE && (await command('/swarmchat team')) === USAGE && JSON.stringify(board.chat()) === JSON.stringify({ on: true, filter: { kind: 'all' } }))
  tally.check('no control dumped the board: the four seats joined while the channel was off, so only the launch row has painted', painted().length === 1, painted().map(row => `${row.fields.name}:${row.text}`).join(' | '))
  tally.check('a later enable never repeats the launch row', painted().filter(row => row.text === 'Swarm launched').length === 1)

  tally.section('§3 main: explicit addressing only')
  tally.check('select main', (await command('/swarmchat main')) === 'Swarm chat · main')
  const mainAsk = post(judge, 'm1', '@main the list is ready MAIN-ASK', { kind: 'ask' })
  post(judge, 'm2', 'a plain result MAIN-PLAIN')
  post(solo, 'm3', '@all the disk is full MAIN-ALL', { kind: 'blocker' })
  post(writer, 'm4', 'for the judge MAIN-TO-SEAT', { to: ['lists-judge'] })
  post(writer, 'm5', 'to main by field MAIN-TO-FIELD', { to: ['main'] })
  post(writer, 'm6', 'to main by mention MAIN-MENTION', { mentions: ['main'] })
  const leadAnswer = board.post(main(), { clientOpId: 'm7', kind: 'answer', replyTo: mainAsk, text: 'the lead answers without naming itself MAIN-LEAD' })
  assert(leadAnswer.ok, JSON.stringify(leadAnswer))
  const whisper = board.postOwner(main(), { clientOpId: 'm8', text: 'quietly MAIN-OWNER', channel: 'whisper', target: 'solo' })
  assert(whisper.ok, JSON.stringify(whisper))
  const runner = { author: { sessionId: sid, agentId: 'a-runner', executionId: 'e-runner' }, name: 'runner', team: 'maps' }
  board.enroll(runner)
  post(scout, 'm9', '@main last one for main MAIN-LAST')
  await landed('MAIN-LAST')
  tally.check('an explicit @main paints', !absent('MAIN-ASK'))
  tally.check('an unaddressed post does not', absent('MAIN-PLAIN'))
  tally.check('@all alone is not addressed to main', absent('MAIN-ALL'))
  tally.check('a post to a seat does not', absent('MAIN-TO-SEAT'))
  tally.check('to: main qualifies', !absent('MAIN-TO-FIELD'))
  tally.check('mentions: main qualifies', !absent('MAIN-MENTION'))
  tally.check("the lead's own post qualifies only when addressed to main", absent('MAIN-LEAD'))
  tally.check("the owner's command always paints, as its sender receipt", painted().some(row => row.text === '@solo quietly MAIN-OWNER' && row.fields.authorRole === 'owner' && row.fields.name === 'owner'))
  tally.check('a lifecycle row is not addressed traffic under main', !painted().some(row => row.text === 'Joined' && row.fields.name === 'runner'))

  tally.section('§4 team: traffic for that team, not a subscription')
  tally.check('select team lists', (await command('/swarmchat team lists')) === 'Swarm chat · team lists')
  post(judge, 't1', 'authored by the team TEAM-AUTHOR')
  post(solo, 't2', '@lists for the label TEAM-LABEL')
  post(solo, 't3', '@lists-judge for a member TEAM-MEMBER')
  post(solo, 't4', '@all for everyone TEAM-ALL')
  post(solo, 't5', 'nothing to do with lists TEAM-NONE')
  post(scout, 't6', '@maps for the other team TEAM-OTHER')
  const leadToMember = board.post(main(), { clientOpId: 't7', kind: 'result', text: '@lists-writer the lead to a member TEAM-LEAD' })
  assert(leadToMember.ok, JSON.stringify(leadToMember))
  const general = board.postOwner(main(), { clientOpId: 't8', text: 'everyone TEAM-OWNER', channel: 'general' })
  assert(general.ok, JSON.stringify(general))
  const reader = { author: { sessionId: sid, agentId: 'a-reader', executionId: 'e-reader' }, name: 'lists-reader', team: 'lists' }
  board.enroll(reader)
  const keeper = { author: { sessionId: sid, agentId: 'a-keeper', executionId: 'e-keeper' }, name: 'keeper', team: 'maps' }
  board.enroll(keeper)
  post(judge, 't9', 'closing the team leg TEAM-LAST')
  await landed('TEAM-LAST')
  tally.check('authored by the team paints', !absent('TEAM-AUTHOR'))
  tally.check('addressed to the team label paints', !absent('TEAM-LABEL'))
  tally.check('addressed to a member paints', !absent('TEAM-MEMBER'))
  tally.check('@all is traffic for every team', !absent('TEAM-ALL'))
  tally.check('an unaddressed post from elsewhere does not paint', absent('TEAM-NONE'))
  tally.check("another team's traffic does not paint", absent('TEAM-OTHER'))
  tally.check("the lead's post to a member paints", !absent('TEAM-LEAD'))
  tally.check("the owner's broadcast paints as the sender receipt", painted().some(row => row.text === '@all everyone TEAM-OWNER' && row.fields.authorRole === 'owner'))
  tally.check("a team seat's Joined row paints", painted().some(row => row.text === 'Joined' && row.fields.name === 'lists-reader'))
  tally.check("another team's Joined row does not", !painted().some(row => row.text === 'Joined' && row.fields.name === 'keeper'))

  tally.section('§5 all: every public kind and lifecycle row, nothing else')
  tally.check('select all', (await command('/swarmchat all')) === 'Swarm chat · all')
  post(solo, 'a1', 'a message is traffic, not a post ALL-MESSAGE', { kind: 'message', to: ['lists-judge'] })
  assert(board.post(solo, { clientOpId: 'a2', kind: 'notice', text: 'a plain mirrored notice ALL-NOTICE' }, 'mirror').ok)
  const earlier = post(solo, 'a3', 'a result to correct ALL-RESULT')
  post(solo, 'a4', 'a correction ALL-CORRECTION', { kind: 'correction', corrects: earlier })
  post(solo, 'a5', 'an ask ALL-ASK', { kind: 'ask' })
  assert(board.post(solo, { clientOpId: 'a6', kind: 'notice', text: 'Crewmate "solo" completed', lifecycle: { kind: 'done' } }, 'mirror').ok)
  post(scout, 'a7', 'closing the all leg ALL-LAST')
  await landed('ALL-LAST')
  tally.check('a message kind never paints', absent('ALL-MESSAGE'))
  tally.check('a plain notice never paints', absent('ALL-NOTICE'))
  tally.check('corrections and asks paint', !absent('ALL-CORRECTION') && !absent('ALL-ASK'))
  tally.check('a completed run paints Done once', painted().filter(row => row.text === 'Done' && row.fields.name === 'solo').length === 1)
  const workbench = board.view()
  tally.check('the Workbench projection is untouched by the display controls: no lifecycle launch or Joined rows, the public posts and the completion notice', workbench.events.every(event => { const lifecycle = (event as { lifecycle?: { kind: string } }).lifecycle; return lifecycle === undefined || lifecycle.kind === 'done' }) && workbench.events.some(event => event.text.includes('ALL-MESSAGE')), workbench.events.map(event => event.text.slice(0, 20)).join(' | '))
  const consumed = (): Record<string, number> => {
    const db = new (requireRuntime('bun:sqlite').Database)(path, { readonly: true }) as { prepare(sql: string): { get(): { n: number } }; close(): void }
    const count = (sql: string): number => Number(db.prepare(sql).get().n)
    try { return { presented: count("SELECT COUNT(*) AS n FROM deliveries WHERE state != 'pending'"), whole: count('SELECT COUNT(*) AS n FROM whole_deliveries'), seen: count('SELECT COUNT(*) AS n FROM seen_events'), read: count('SELECT COUNT(*) AS n FROM read_events'), requests: count('SELECT COUNT(*) AS n FROM requests') } } finally { db.close() }
  }
  const beforeBurst = consumed()

  tally.section('§6 a burst larger than the Workbench page paints whole, in sequence')
  for (let i = 0; i < 40; i++) post(writer, `burst-${i}`, `burst row ${String(i).padStart(2, '0')} BURST-${String(i).padStart(2, '0')}`)
  await landed('BURST-39')
  const burst = painted().filter(row => row.text.includes('BURST-')).map(row => row.text.slice(-2))
  tally.check('all forty rows painted, in order', burst.length === 40 && burst.every((n, i) => Number(n) === i), burst.join(','))
  tally.check('no row painted twice', new Set(painted().map(row => row.id)).size === painted().length)
  const afterBurst = consumed()
  tally.check('painting forty rows presented, read or marked nothing for any seat: the deliveries the posts created stay pending', JSON.stringify(afterBurst) === JSON.stringify(beforeBurst), `${JSON.stringify(beforeBurst)} → ${JSON.stringify(afterBurst)}`)

  tally.section('§7 off stops new rows, on resumes at the current sequence; /swarm off suspends, /swarm on resumes')
  tally.check('toggle off', (await command('/swarmchat')) === 'Swarm chat off')
  post(judge, 'o1', 'posted while the chat is off OFF-1')
  post(judge, 'o2', 'posted while the chat is off OFF-2')
  tally.check('toggle on', (await command('/swarmchat')) === 'Swarm chat on')
  post(judge, 'o3', 'posted after the chat came back ON-1')
  await landed('ON-1')
  tally.check('the posts made while off never paint', absent('OFF-1') && absent('OFF-2'))
  const swarmOff = await command('/swarm off')
  tally.check('/swarm off answers its usual words', swarmOff.startsWith('Swarm off for new crewmates'), swarmOff)
  post(judge, 's1', 'posted while swarm is off SUSPENDED-1')
  tally.check('the session choice survives /swarm off', board.chat().on === true)
  tally.check('/swarm on answers its usual words again', (await command('/swarm on')).startsWith('Swarm on for new crewmates'))
  await settled()
  post(judge, 's2', 'posted after swarm came back RESUMED-1')
  await landed('RESUMED-1')
  tally.check('the post made while swarm was off never paints', absent('SUSPENDED-1'))

  tally.section('§8 a resumed session keeps its choice; a new session starts off')
  const before = painted().length
  host.end()
  await host.stop(30_000)
  host = boot(['--resume', sid])
  await host.initialize({ partial_rows: true })
  await settled()
  post(judge, 'r1', 'posted to the resumed session RESUMED-ROW')
  await landed('RESUMED-ROW')
  tally.check('the resumed session paints without a command', painted().length === before + 1)
  tally.check('its first answer is the toggle off, so the choice was on', (await command('/swarmchat')) === 'Swarm chat off')
  host.end()
  await host.stop(30_000)
  host = boot([])
  await host.initialize({ partial_rows: true })
  tally.check('a new session: /swarm on', (await command('/swarm on')).startsWith('Swarm on for new crewmates'))
  const fresh = findFiles(world.config, 'board.sqlite').find(p => p !== path)!
  const freshBoard = open(fresh, basename(dirname(dirname(dirname(fresh)))))
  tally.check('its channel starts off, filter all', JSON.stringify(freshBoard.chat()) === JSON.stringify({ on: false, filter: { kind: 'all' } }))
  tally.check('and its first toggle switches it on', (await command('/swarmchat')) === 'Swarm chat on')
  freshBoard.close()
} finally {
  record('swarm-party-controls-out.txt', raw)
  board?.close()
  await host.stop(5_000)
  await closeWorld(world)
}
tally.finish()
