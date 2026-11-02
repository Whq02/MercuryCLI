import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DIST, NODE, closeWorld, findFiles, makeTally, makeWorld, record } from './crew-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const { open } = await import('../../src/services/crewBoard/store.ts')
const words = (text: string): string[] => text.split(' ').map((w, i, all) => (i < all.length - 1 ? `${w} ` : w))
const THINK = 'Thinking about the fold before a word reaches the screen, slowly, so a post can land in the middle of it.'
const LONG = 'Sentence one of the long reply. Sentence two keeps streaming. Sentence three is still open while posts arrive. Sentence four closes the block. THE-LONG-END'
const TOOL_PRE = 'Running the tool now, with words before it. THE-PRE-END'
const TOOL_AFTER = 'The tool ran and printed its line. THE-TOOL-END'
const INPUT_PRE = 'Typing the next tool call slowly. THE-INPUT-PRE-END'
const INPUT_AFTER = 'The slowly typed tool ran too. THE-INPUT-END'
const FINAL = 'This reply will be interrupted before it ends, one word at a time, so the held row flushes at the close. THE-FINAL-END'
const world = await makeWorld('swarm-party-boundaries', [
  { kind: 'text', text: 'Lead is waiting.' },
  { kind: 'stream', blocks: [{ type: 'thinking', deltas: words(THINK) }, { type: 'text', deltas: words(LONG) }], gapMs: 120 },
  { kind: 'paced_tool_use', preDeltas: words(TOOL_PRE), gapMs: 120, tools: [{ name: 'Bash', input: { command: 'sleep 2; echo tool-done', description: 'Wait, then print one line' } }] },
  { kind: 'paced', deltas: words(TOOL_AFTER), gapMs: 120 },
  { kind: 'paced_tool_use', preDeltas: words(INPUT_PRE), gapMs: 100, tools: [{ name: 'Bash', input: { command: 'echo input-done', description: 'Print one line after a slowly typed input that keeps the block open for a while' } }], inputGapMs: 200, inputChunks: 8 },
  { kind: 'paced', deltas: words(INPUT_AFTER), gapMs: 100 },
  { kind: 'paced', deltas: words(FINAL), gapMs: 150 },
  { kind: 'text', text: 'After the interruption.' },
])
const settings = join(world.config, 'settings.json')
writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
const tally = makeTally('swarm-party-boundaries')
let raw = ''
const host = hostRunner({ dist: DIST, node: NODE, cwd: world.project, home: world.config, env: world.env as Record<string, string | undefined>, argv: ['--model', 'claude-fable-5-1', '--allowed-tools', 'Bash', 'CrewBoard'], raw: line => { raw += line } })
const until = async (label: string, test: () => boolean, timeoutMs = 90_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`${label}\n--- rows tail ---\n${raw.slice(-2000)}\n--- stderr tail ---\n${host.stderr().slice(-1500)}`)
    await new Promise(tick => setTimeout(tick, 25))
  }
}
const command = async (text: string, answer: string): Promise<void> => {
  const before = raw.length
  await host.prompt(text)
  await until(`${text} answered`, () => raw.slice(before).includes(answer))
}
type Row = { id: string; kind: string; what: string; text: string; fields: Record<string, unknown>; creation: boolean }
const rowsOf = (transcript: string): Row[] => {
  const out: Row[] = []
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry: { recordId: string; updates?: string; payload?: { kind?: string; noticeKind?: string; content?: unknown; fields?: Record<string, unknown> } }
    try { entry = JSON.parse(line) } catch { continue }
    const payload = entry.payload
    if (!payload) continue
    const creation = entry.updates === undefined
    if (payload.kind === 'notice' && payload.noticeKind === 'crew_chat') out.push({ id: entry.recordId, kind: 'party', what: 'party', text: String(payload.content ?? ''), fields: payload.fields ?? {}, creation })
    else if (payload.kind === 'input' || payload.kind === 'output') {
      const blocks = Array.isArray(payload.content) ? (payload.content as { kind?: string; text?: string; input?: unknown }[]) : []
      const what = typeof payload.content === 'string' ? 'prompt' : blocks.some(b => b.kind === 'tool-result') ? 'tool-result' : blocks.some(b => b.kind === 'tool-use') ? 'tool-use' : blocks.some(b => b.kind === 'reasoning') ? 'reasoning' : blocks.some(b => b.kind === 'text') ? (payload.kind === 'input' ? 'prompt' : 'text') : 'other'
      out.push({ id: entry.recordId, kind: payload.kind, what, text: typeof payload.content === 'string' ? payload.content : blocks.map(b => b.text ?? (b.input === undefined ? '' : JSON.stringify(b.input))).join(' '), fields: {}, creation })
    }
  }
  return out
}
const firstRecords = (all: Row[]): Row[] => {
  const seen = new Set<string>()
  return all.filter(row => !seen.has(row.id) && seen.add(row.id))
}
let board: ReturnType<typeof open> | undefined
try {
  await host.initialize({ partial_rows: true })
  await command('/swarm on', 'Swarm on for new crewmates')
  const beforeWait = raw.length
  await host.prompt('Wait for crew questions.')
  await until('the lead is idle', () => raw.includes('Lead is waiting.') && raw.slice(beforeWait).includes('"type":"outcome"'))
  await new Promise(tick => setTimeout(tick, 500))
  const path = findFiles(world.config, 'board.sqlite')[0]!
  const sessionDir = dirname(dirname(dirname(path)))
  const sid = basename(sessionDir)
  const transcript = join(dirname(sessionDir), `${sid}.jsonl`)
  board = open(path, sid)
  board.setChat({ on: true, filter: { kind: 'all' } })
  const sender = { author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'poster', team: 'lists' }
  board.enroll(sender)
  await until('the launch row and the Joined row landed while the lead was idle', () => { const text = readFileSync(transcript, 'utf8'); return text.includes('Swarm launched') && text.includes('"content":"joined') })
  const post = (clientOpId: string, text: string): string => {
    const receipt = board!.post(sender, { clientOpId, kind: 'result', text })
    assert(receipt.ok, JSON.stringify(receipt))
    return receipt.eventId
  }
  const emits = (turn: number, type: 'thinking' | 'text'): number => world.fixture.streamEmits.filter(e => e.turn === turn && e.blockType === type).length
  const paced = (turn: number): number => world.fixture.pacedEmits.filter(e => e.turn === turn).length

  await host.prompt('say the long one')
  await until('the thinking block is open', () => emits(2, 'thinking') >= 3)
  const p1 = post('during-thinking', 'posted while the lead thinks')
  await until('the text block is open', () => emits(2, 'text') >= 3)
  const p2 = post('during-text-one', 'first post while the lead writes')
  const p3 = post('during-text-two', 'second post while the lead writes')
  await until('the long reply settled', () => raw.includes('THE-LONG-END') && readFileSync(transcript, 'utf8').includes('second post while the lead writes'))

  await host.prompt('run the tool')
  await until('the words before the tool are streaming', () => paced(3) >= 3)
  const p4 = post('during-pre-text', 'posted during the words before the tool')
  await until('the tool call landed', () => world.fixture.toolEmits.some(e => e.turn === 3) && readFileSync(transcript, 'utf8').includes('"kind":"tool-use"'))
  const p5 = post('during-tool-run', 'posted while the tool runs')
  await until('the reply after the tool settled', () => raw.includes('THE-TOOL-END') && readFileSync(transcript, 'utf8').includes('THE-TOOL-END'))

  await host.prompt('type the input slowly')
  await until('the tool input block is open and still being typed', () => world.fixture.toolInputEmits.filter(e => e.turn === 5).length >= 2 && !world.fixture.toolEmits.some(e => e.turn === 5))
  const p6 = post('during-tool-input', 'posted while the tool input is still being typed')
  const inputOpenWhenPosted = !world.fixture.toolEmits.some(e => e.turn === 5)
  await until('the slowly typed tool ran and its reply settled', () => raw.includes('THE-INPUT-END') && readFileSync(transcript, 'utf8').includes('THE-INPUT-END'))

  await host.prompt('say the final one')
  await until('the final block is open', () => paced(7) >= 3)
  const p7 = post('during-interrupted', 'posted inside the block that gets interrupted')
  const interrupted = await host.request('turn/interrupt', {})
  tally.check('the turn was interrupted mid-block', interrupted.interrupted === true)
  await until('the interrupted turn closed and flushed its row', () => readFileSync(transcript, 'utf8').includes('posted inside the block that gets interrupted'))
  const p8 = post('idle-after', 'posted while the lead is idle')
  await until('the idle row landed', () => readFileSync(transcript, 'utf8').includes('posted while the lead is idle'))
  await host.prompt('one more')
  await until('the last turn settled', () => raw.includes('After the interruption.'))
  host.end()
  await host.stop(30_000)

  const allRecords = rowsOf(transcript)
  const rows = firstRecords(allRecords)
  const at = (id: string): number => rows.findIndex(row => row.id === id)
  const party = rows.filter(row => row.what === 'party')
  const prompts = rows.filter(row => row.what === 'prompt')
  const order = (label: string, before: string | number, after: string | number): void => {
    const a = typeof before === 'string' ? at(before) : before, b = typeof after === 'string' ? at(after) : after
    tally.check(label, a >= 0 && b >= 0 && a < b, `${a} vs ${b}: ${rows.map(row => `${row.what}:${row.text.slice(0, 24)}`).join(' | ')}`)
  }
  tally.section('§1 one record per post, every post recorded once')
  tally.check("the channel opens on the wave's launch row, then the seat that joined has one Joined row, then the eight posts", party.length === 10 && party[0]!.text === 'Swarm launched' && party[0]!.fields.name === 'main' && /^joined(?: · team .+)?$/.test(party[1]!.text) && party[1]!.fields.authorRole === 'system', party.map(row => row.text).join(' | '))
  const creations = allRecords.filter(row => row.what === 'party' && row.creation)
  tally.check('every party row is created once: one creation record per board event, before any projection', creations.length === party.length && new Set(creations.map(row => row.id)).size === creations.length, `${creations.length} creation records for ${party.length} rows`)
  tally.check('a party row carries the post words, the seat and its team', party.slice(2).every(row => row.fields.name === 'poster' && row.fields.team === 'lists' && row.fields.kind === 'result' && row.fields.authorRole === 'peer'))

  tally.section('§2 a row never cuts an open block')
  const longPrompt = prompts.find(row => row.text.includes('say the long one'))!
  const reasoning = rows.findIndex(row => row.what === 'reasoning' && rows.indexOf(row) > at(longPrompt.id))
  const longText = rows.findIndex(row => row.what === 'text' && row.text.includes('THE-LONG-END'))
  order('a post during the thinking block lands after the thinking record', reasoning, p1)
  order('and before the text block that followed it', p1, longText)
  order('the first post during the text block lands after the whole text', longText, p2)
  order('the second queued post follows the first', p2, p3)
  tally.check('the long text record is whole, not split around the rows', rows.filter(row => row.what === 'text' && row.text.includes('Sentence')).length === 1 && rows[longText]!.text.includes('Sentence one') && rows[longText]!.text.includes('THE-LONG-END'))

  tally.section('§3 tool turns: words before the tool, the tool call, the run, the words after')
  const preText = rows.findIndex(row => row.what === 'text' && row.text.includes('THE-PRE-END'))
  const toolUse = rows.findIndex(row => row.what === 'tool-use' && row.text.includes('tool-done'))
  const toolResult = rows.findIndex((row, i) => row.what === 'tool-result' && i > toolUse)
  const afterText = rows.findIndex(row => row.what === 'text' && row.text.includes('THE-TOOL-END'))
  order('a post during the words before the tool lands after those words', preText, p4)
  order('and before the tool call that followed them', p4, toolUse)
  order('a post while the tool runs lands after the landed tool call', toolUse, p5)
  order('and before the tool result', p5, toolResult)
  order('the words after the tool follow it', toolResult, afterText)
  const inputPre = rows.findIndex(row => row.what === 'text' && row.text.includes('THE-INPUT-PRE-END'))
  const inputUse = rows.findIndex(row => row.what === 'tool-use' && row.text.includes('input-done'))
  const inputResult = rows.findIndex((row, i) => row.what === 'tool-result' && i > inputUse)
  const inputAfter = rows.findIndex(row => row.what === 'text' && row.text.includes('THE-INPUT-END'))
  tally.check('the post was committed while the tool input block was still being typed', inputOpenWhenPosted)
  order('a post during an open tool-input block lands after the words before that tool', inputPre, p6)
  order('and after the whole landed tool call', inputUse, p6)
  order('and before the tool result', p6, inputResult)
  order('the words after the slowly typed tool follow its result', inputResult, inputAfter)
  tally.check('the slowly typed tool call is recorded whole, its input complete', inputUse >= 0 && rows[inputUse]!.text.includes('"command":"echo input-done"') && rows[inputUse]!.text.includes('keeps the block open for a while'), inputUse >= 0 ? rows[inputUse]!.text : 'no tool-use record')

  tally.section('§4 an interrupted turn flushes its held row at the close; an idle post lands at once')
  const finalPrompt = prompts.find(row => row.text.includes('say the final one'))!
  const nextPrompt = prompts.find(row => row.text.includes('one more'))!
  order('the row held in the interrupted block lands after its prompt', finalPrompt.id, p7)
  order('and before the next prompt', p7, nextPrompt.id)
  order('the idle post follows it', p7, p8)
  order('and sits before the next prompt too', p8, nextPrompt.id)

  tally.section('§5 the turn anchor: rows that arrived during a turn carry its prompt, idle rows carry none')
  const field = (id: string): string | undefined => party.find(row => row.id === id)?.fields.turnId as string | undefined
  tally.check('the rows of the long turn carry its prompt record', [p1, p2, p3].every(id => field(id) === longPrompt.id), JSON.stringify([field(p1), field(p2), field(p3), longPrompt.id]))
  const toolPrompt = prompts.find(row => row.text.includes('run the tool'))!
  tally.check('the rows of the tool turn carry its prompt record', [p4, p5].every(id => field(id) === toolPrompt.id))
  const inputPrompt = prompts.find(row => row.text.includes('type the input slowly'))!
  tally.check('the row of the slowly typed tool turn carries its prompt record', field(p6) === inputPrompt.id)
  tally.check('the row of the interrupted turn carries its prompt record', field(p7) === finalPrompt.id)
  tally.check('the idle row carries no turn', field(p8) === undefined)
  tally.check('the launch row and the Joined row arrived while the lead was idle and carry no turn', field(party[0]!.id) === undefined && field(party[1]!.id) === undefined, `${JSON.stringify([field(party[0]!.id), field(party[1]!.id)])} vs prompts ${JSON.stringify(prompts.map(row => `${row.id.slice(0, 8)}:${row.text.slice(0, 20)}`))}`)

  tally.section('§6 party rows are screen rows, not model input')
  const wire = JSON.stringify(world.fixture.messageRequests().map(request => request.body))
  tally.check('no post words reached the model through the rows', !wire.includes('posted while the lead thinks') && !wire.includes('posted while the tool runs') && !wire.includes('still being typed') && !wire.includes('crew_chat'))
} finally {
  record('swarm-party-boundaries-out.txt', raw)
  record('swarm-party-boundaries-requests.json', JSON.stringify(world.fixture.messageRequests().map(request => request.body)))
  board?.close()
  await host.stop(5_000)
  await closeWorld(world)
}
tally.finish()
