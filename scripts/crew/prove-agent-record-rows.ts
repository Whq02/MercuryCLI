#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { decodeTranscriptBuffer } from '../../src/fabric/transcriptDecode.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, toolResultOf, treeOf, TURN_MS } from './crew-world.ts'

const PEER_MODEL = 'claude-opus-4-6'
const ANSWER = 'RECORD-ANSWER-ONCE'
const CONTINUE = 'CONTINUE-RECORD-ONCE'
const TOOL_ID = 'toolu_record_pwd'
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: PEER_MODEL, whenModel: 'opus-4-6' }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', id: 'toolu_record_launch', name: 'Agent', input: { name: 'scribe', model: PEER_MODEL, subagent_type: 'mercury-crew', run_in_background: false, description: 'Record each turn once', prompt: 'Run pwd once and report the record witness.' } }),
  lead({ kind: 'text', text: 'LAUNCH-FINISHED' }),
  lead({ kind: 'tool_use', id: 'toolu_record_resume', name: 'ResumeAgent', input: { to: 'scribe', message: CONTINUE } }),
  lead({ kind: 'text', text: 'RESUME-SENT' }),
  ...Array.from({ length: 8 }, () => lead({ kind: 'text', text: 'LEAD-ACK' })),
  peer({ kind: 'tool_use', id: TOOL_ID, name: 'Bash', input: { command: 'pwd', description: 'Read the working directory' } }),
  peer({ kind: 'text', text: ANSWER }),
  peer({ kind: 'text', text: 'RESUMED-RECORD-ONCE' }),
]
const tally = makeTally('prove-agent-record-rows')
const world = await makeWorld('agent-record-rows', script)
const session = bootLead(world, ['--mode', 'sovereign'], ['Agent', 'Bash', 'SendMessage', 'ResumeAgent'])
type Entry = { type?: string; uuid?: string; message?: { content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } } }
type Block = { type?: string; text?: string; id?: string; tool_use_id?: string }
type Item = { role?: string; content?: unknown }
type Body = { model?: string; messages?: Item[] }
const blocks = (content: unknown): Block[] => Array.isArray(content) ? content as Block[] : []
const transcripts = (): string[] => treeOf(join(world.config, 'projects')).filter(path => /subagents\/agent-.*\.jsonl$/.test(path))
const peerBodies = (): Body[] => world.fixture.messageRequests().map(request => request.body as Body).filter(body => body.model === PEER_MODEL)
const resumed = (): Body | undefined => peerBodies().find(body => JSON.stringify(body.messages?.at(-1)).includes(CONTINUE))

try {
  session.submit('Start the scribe and wait for its answer.')
  await session.waitFor('the foreground agent never returned', () => session.stdout().includes('LAUNCH-FINISHED'), TURN_MS)
  const files = transcripts()
  tally.check('the real sub-agent wrote one transcript file', files.length === 1, JSON.stringify(files))
  if (files.length !== 1) throw new Error('no unique agent transcript')
  const file = join(world.config, 'projects', files[0]!)
  const raw = readFileSync(file, 'utf8')
  record('agent-record.jsonl', raw)
  const decoded = decodeTranscriptBuffer<Entry>(raw)
  tally.check('the written record decodes without malformed or invalid rows', !decoded.refusal && decoded.malformed.length === 0 && decoded.invalid.length === 0, JSON.stringify(decoded.invalid))
  const assistant = decoded.entries.filter(entry => entry.type === 'assistant')
  const groups = new Map<string, Entry[]>()
  for (const entry of assistant) groups.set(entry.uuid!, [...(groups.get(entry.uuid!) ?? []), entry])
  const counts = [...groups].map(([uuid, entries]) => ({ uuid, rows: entries.length, output: entries.map(entry => entry.message?.usage?.output_tokens ?? 0) }))
  console.log('  assistant rows per uuid: ' + JSON.stringify(counts))
  tally.check('each assistant turn has one physical row, not a placeholder plus a settlement', groups.size === 2 && counts.every(group => group.rows === 1), JSON.stringify(counts))
  const calls = assistant.flatMap(entry => blocks(entry.message?.content)).filter(block => block.type === 'tool_use' && block.id === TOOL_ID)
  tally.check('the tool-call row is recorded once', calls.length === 1, `tool-call rows=${calls.length}`)
  tally.check('both settled rows retain nonzero usage', [...groups.values()].every(entries => (entries.at(-1)?.message?.usage?.output_tokens ?? 0) > 0))
  const handback = toolResultOf(world, 'toolu_record_launch')
  tally.check('the hand-back retains the final answer and one tool use', handback !== null && !handback.isError && handback.text.startsWith(ANSWER + '\n') && handback.text.includes('tool_uses: 1'), handback?.text ?? 'no result')

  session.submit('Send the scribe the continuation now.')
  await session.waitFor('the resumed agent never read the continuation', () => resumed() !== undefined, TURN_MS)
  const history = resumed()!.messages ?? []
  record('resume-request.json', JSON.stringify(resumed(), null, 2))
  const replayed = history.filter(item => item.role === 'assistant').flatMap(item => blocks(item.content))
  tally.check('resume from the record replays the assistant answer exactly once', replayed.filter(block => block.type === 'text' && block.text?.includes(ANSWER)).length === 1, JSON.stringify(replayed))
  tally.check('resume from the record replays the tool call exactly once', replayed.filter(block => block.type === 'tool_use' && block.id === TOOL_ID).length === 1, JSON.stringify(replayed))
  tally.check('resume retains the matching tool result exactly once', history.filter(item => item.role === 'user').flatMap(item => blocks(item.content)).filter(block => block.type === 'tool_result' && block.tool_use_id === TOOL_ID).length === 1)
} catch (error) {
  tally.check('the fixture reached every checkpoint', false, error instanceof Error ? error.message : String(error))
} finally {
  record('lead-stderr.txt', session.stderr())
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
