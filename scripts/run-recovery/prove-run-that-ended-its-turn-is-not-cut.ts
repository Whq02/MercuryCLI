#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'own-ending-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const loaderCwd = join(scratch, 'loader-cwd')
mkdirSync(loaderCwd, { recursive: true })
bootstrap.setOriginalCwd(loaderCwd)
bootstrap.setProjectRoot(loaderCwd)
const { loadConversationForResume, getResumePrompt } = await import('../../src/utils/conversationRecovery.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { ENDED_RUN_TOOL_RESULT, NO_RESPONSE_REQUESTED } = await import('../../src/utils/messages/rejectionText.ts')
import type { Message } from '../../src/types/message.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the own-ending proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const CONTINUATION = getResumePrompt()
const MODEL = 'claude-opus-4-8'
const SYSTEM_PATH = process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin'

type Arena = { home: string; cwd: string; env: Record<string, string> }
function makeArena(name: string, fixture: FixtureApi, settings?: Record<string, unknown>): Arena {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'cwd')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (settings !== undefined) writeFileSync(join(home, '.mercury', 'settings.json'), JSON.stringify(settings))
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: [SYSTEM_PATH, dirname(nodeBin!)].filter(part => part !== '').join(delimiter),
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_TMPDIR: join(scratch, name, 'tmp'),
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TRUST_DIALOG_ACCEPTED: '1',
    },
  }
}
function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolve({ exit, stdout, stderr })
    })
  })
}
function transcriptOf(arena: Arena, sessionId: string): string {
  const stack = [join(arena.home, '.mercury', 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name === `${sessionId}.jsonl`) return path
    }
  }
  return ''
}
type StoredRow = Record<string, unknown> & { type: string; uuid: string }
type Block = Record<string, unknown> & { type?: string }
async function recordOf(file: string): Promise<StoredRow[]> {
  if (file === '') return []
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true })
  return [...loaded.messages.values()] as unknown as StoredRow[]
}
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [{ type: 'text', text: String(content ?? '') }])
const kindOf = (row: StoredRow): string => {
  if (row.type === 'attachment') return `attachment:${String((row.attachment as { type?: unknown } | undefined)?.type)}`
  if (row.type === 'system') return `system:${String(row.subtype)}`
  return `${row.type}(${blocksOf((row.message as { content?: unknown } | undefined)?.content).map(block => String(block.type)).join('+')})`
}
const resultTextOf = (block: Block | undefined): string => (block === undefined ? '' : typeof block.content === 'string' ? block.content : j(block.content))
const resultsOfRow = (row: StoredRow | undefined): Block[] => (row?.type === 'user' ? blocksOf((row.message as { content?: unknown } | undefined)?.content).filter(block => block.type === 'tool_result') : [])
const rowsOf = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
type Wire = Array<{ role: string; blocks: Block[] }>
const wireOf = (request: { body: unknown } | undefined): Wire => (((request?.body ?? {}) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []).map(message => ({ role: message.role, blocks: blocksOf(message.content) }))
const wireTexts = (wire: Wire): string[] => wire.flatMap(message => message.blocks.map(block => (block.type === 'text' ? String(block.text) : block.type === 'tool_result' ? `result:${resultTextOf(block)}` : String(block.type))))
const says = (wire: Wire, words: string): number => wireTexts(wire).filter(text => text.includes(words)).length
const shapeOf = (wire: Wire): string => j(wire.map(message => [message.role, message.blocks.map(block => (block.type === 'text' ? String(block.text).slice(0, 70) : block.type === 'tool_result' ? `result:${resultTextOf(block).slice(0, 70)}` : String(block.type)))]))
const lastRequest = (fixture: FixtureApi): Wire => wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))

let variant = 0
async function resumedFrom(rows: StoredRow[], sessionId: string): Promise<{ state: string; saysContinuation: number; saysSentinel: number }> {
  const dir = join(scratch, 'variants', String(++variant))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, rows.map(row => encodeTranscriptLine(file, row).line).join(''))
  const loaded = await loadConversationForResume(sessionId, file)
  const talk = ((loaded?.messages ?? []) as Message[]).filter(row => row.type === 'user' || row.type === 'assistant')
  const textOf = (row: Message): string => (row.type === 'user' || row.type === 'assistant' ? j(row.message.content) : '')
  return {
    state: loaded?.turnInterruptionState.kind ?? 'nothing loaded',
    saysContinuation: talk.filter(row => textOf(row).includes(CONTINUATION)).length,
    saysSentinel: talk.filter(row => textOf(row).includes(NO_RESPONSE_REQUESTED)).length,
  }
}
const withResult = (row: StoredRow, patch: Record<string, unknown>): StoredRow => ({ ...row, message: { ...(row.message as Record<string, unknown>), content: blocksOf((row.message as { content?: unknown }).content).map(block => (block.type === 'tool_result' ? { ...block, ...patch } : block)) } }) as StoredRow

console.log('============================================================')
console.log(' a turn the run ended itself is not read as cut from outside')
console.log('============================================================')

try {
  section('G1 — the loop guard ends the turn: three failed calls with the same arguments; a second process resumes')
  {
    const SID = 'facef00d-0000-4000-8000-00000000a101'
    const failing = (n: number): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', id: `toolu_g1_${n}`, input: { unrecognized: 'not a valid Read input' } })
    const fixture = await startFixtureApi([handoffTurn(), failing(1), failing(2), failing(3), { kind: 'text', text: 'G1-SECOND-REPLY.' }])
    const arena = makeArena('g1', fixture)
    try {
      const first = await run(arena, ['run', 'G1 first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
      const outcome = rowsOf(first.stdout).findLast(row => row.type === 'outcome')
      const record = await recordOf(transcriptOf(arena, SID))
      const kinds = record.map(kindOf)
      const guardAt = kinds.lastIndexOf('attachment:loop_stopped')
      check('G1: the run ended its own turn (its outcome row: loop_stopped), and the record ends on the three failed results and the guard\'s row', outcome?.status === 'loop_stopped' && guardAt !== -1 && kinds.filter(kind => kind === 'user(tool_result)').length === 3 && kinds.slice(guardAt + 1).every(kind => kind.startsWith('attachment:') || kind.startsWith('system:')), `exit=${first.exit} ${j({ status: outcome?.status, tail: kinds.slice(-6) })} ${first.stderr.slice(-200)}`)
      const loaded = await resumedFrom(record, SID)
      check('G1: the loader does not read the turn as cut from outside — no cut-off sentence', loaded.state === 'none' && loaded.saysContinuation === 0, j(loaded))
      const second = await run(arena, ['run', 'G1 second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      const wire = lastRequest(fixture)
      check('G1: the second process answered, and its request carries the three results, the guard\'s own words and the second prompt, with no cut-off sentence and no stand-in reply', second.exit === 0 && second.stdout.includes('G1-SECOND-REPLY.') && says(wire, CONTINUATION) === 0 && says(wire, NO_RESPONSE_REQUESTED) === 0 && wire.flatMap(message => message.blocks).filter(block => block.type === 'tool_result').length === 3 && says(wire, 'Stopped after 3 failed Read calls') >= 1 && wireTexts(wire).at(-1) === 'G1 second prompt.', `exit=${second.exit} ${shapeOf(wire)}`)
      check('G1: …and nowhere says a call\'s outcome is not known', says(wire, ENDED_RUN_TOOL_RESULT) === 0, shapeOf(wire))
      const beforeGuard = await resumedFrom(record.slice(0, guardAt), SID)
      check('G1 control: the same record stopped before the guard\'s row (a process stopped from outside after the third result) reads as cut — the sentence once', kinds[guardAt - 1] !== undefined && beforeGuard.state === 'interrupted_prompt' && beforeGuard.saysContinuation === 1, j({ last: kinds[guardAt - 1], ...beforeGuard }))
    } finally {
      await fixture.close()
    }
  }

  section('G2 — the turn limit ends the turn while the closing reply still calls a tool: the run answers that call itself; a second process resumes')
  {
    const SID = 'facef00d-0000-4000-8000-00000000a201'
    const first: ScriptedTurn = { kind: 'tool_use', name: 'Read', id: 'toolu_g2_first', input: {} }
    const closing: ScriptedTurn = { kind: 'tool_use', name: 'Read', id: 'toolu_g2_closing', input: {} }
    const fixture = await startFixtureApi([handoffTurn(), first, closing, { kind: 'text', text: 'G2-SECOND-REPLY.' }])
    const arena = makeArena('g2', fixture)
    const note = join(arena.cwd, 'note.txt')
    writeFileSync(note, 'G2-NOTE-CONTENT\n')
    ;(first as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: note }
    ;(closing as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: note }
    try {
      const firstRun = await run(arena, ['run', 'G2 first prompt.', '--model', MODEL, '--session-id', SID, '--max-turns', '1', '--mode', 'implement', '--format', 'rows'])
      const rows = rowsOf(firstRun.stdout)
      const outcome = rows.findLast(row => row.type === 'outcome')
      const record = await recordOf(transcriptOf(arena, SID))
      const kinds = record.map(kindOf)
      const lastTalk = record.findLast(row => row.type === 'user' || row.type === 'assistant')
      const cut = resultsOfRow(lastTalk)[0]
      check('G2: the run ended its own turn (its outcome row: turn_limit) and the record ends on the result it wrote for the call it did not run — "Cut off: the turn budget was spent"', outcome?.status === 'turn_limit' && cut?.tool_use_id === 'toolu_g2_closing' && cut.is_error === true && resultTextOf(cut) === 'Cut off: the turn budget was spent', `exit=${firstRun.exit} ${j({ status: outcome?.status, tail: kinds.slice(-5), cut })} ${firstRun.stderr.slice(-200)}`)
      const loaded = await resumedFrom(record, SID)
      check('G2: the loader does not read the turn as cut from outside — no cut-off sentence', loaded.state === 'none' && loaded.saysContinuation === 0, j(loaded))
      const second = await run(arena, ['run', 'G2 second prompt.', '--model', MODEL, '--resume', SID, '--mode', 'implement', '--format', 'rows'])
      const wire = lastRequest(fixture)
      check('G2: the second process answered, and its request carries the run\'s own result once and the second prompt, with no cut-off sentence', second.exit === 0 && second.stdout.includes('G2-SECOND-REPLY.') && says(wire, CONTINUATION) === 0 && says(wire, 'Cut off: the turn budget was spent') === 1 && wireTexts(wire).at(-1) === 'G2 second prompt.', `exit=${second.exit} ${shapeOf(wire)}`)
      check('G2: …and nowhere says a call\'s outcome is not known', says(wire, ENDED_RUN_TOOL_RESULT) === 0, shapeOf(wire))
      const at = record.indexOf(lastTalk!)
      const failed = await resumedFrom(record.map((row, i) => (i === at ? withResult(row, { content: '<tool_use_error>File does not exist.</tool_use_error>' }) : row)), SID)
      check('G2 control: the same record with a result the tool itself gave in that place (a failed read) reads as cut — the sentence once', failed.state === 'interrupted_prompt' && failed.saysContinuation === 1, j(failed))
      const lookalike = await resumedFrom(record.map((row, i) => (i === at ? withResult(row, { content: 'Cut off: a line of a file the tool read', is_error: false }) : row)), SID)
      check('G2 control: …and a result that is not an error and merely begins with the same words (a tool\'s own output) reads as cut', lookalike.state === 'interrupted_prompt' && lookalike.saysContinuation === 1, j(lookalike))
      const unanswered = await resumedFrom(record.slice(0, at), SID)
      check('G2 control: …and the record stopped before that result (the call left with no answer) is answered by the ended-run sentence and reads as cut', unanswered.state === 'interrupted_prompt' && unanswered.saysContinuation === 1, j(unanswered))
    } finally {
      await fixture.close()
    }
  }

  section('G2 — the same turn-limit ending with a turn.end hook that leaves its notice row behind the run\'s own result; a second process resumes')
  {
    const SID = 'facef00d-0000-4000-8000-00000000a251'
    const first: ScriptedTurn = { kind: 'tool_use', name: 'Read', id: 'toolu_g2h_first', input: {} }
    const closing: ScriptedTurn = { kind: 'tool_use', name: 'Read', id: 'toolu_g2h_closing', input: {} }
    const fixture = await startFixtureApi([handoffTurn(), first, closing, { kind: 'text', text: 'G2H-SECOND-REPLY.' }])
    const arena = makeArena('g2h', fixture, { events: { hooks: { 'turn.end': [{ name: 'end note', run: `echo '${JSON.stringify({ notice: 'the end hook spoke' })}'` }] } } })
    const note = join(arena.cwd, 'note.txt')
    writeFileSync(note, 'G2H-NOTE-CONTENT\n')
    ;(first as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: note }
    ;(closing as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: note }
    try {
      const firstRun = await run(arena, ['run', 'G2H first prompt.', '--model', MODEL, '--session-id', SID, '--max-turns', '1', '--mode', 'implement', '--format', 'rows'])
      const outcome = rowsOf(firstRun.stdout).findLast(row => row.type === 'outcome')
      const record = await recordOf(transcriptOf(arena, SID))
      const kinds = record.map(kindOf)
      const lastTalk = record.findLast(row => row.type === 'user' || row.type === 'assistant')
      const cut = resultsOfRow(lastTalk)[0]
      check('G2: with the hook the record ends on the hook\'s row, behind the result the run wrote for the call it did not run', outcome?.status === 'turn_limit' && kinds.at(-1) === 'attachment:hook' && cut?.tool_use_id === 'toolu_g2h_closing' && resultTextOf(cut) === 'Cut off: the turn budget was spent', `exit=${firstRun.exit} ${j({ status: outcome?.status, tail: kinds.slice(-4), cut })} ${firstRun.stderr.slice(-200)}`)
      const loaded = await resumedFrom(record, SID)
      check('G2: the loader still does not read the turn as cut from outside — no cut-off sentence', loaded.state === 'none' && loaded.saysContinuation === 0, j(loaded))
      const second = await run(arena, ['run', 'G2H second prompt.', '--model', MODEL, '--resume', SID, '--mode', 'implement', '--format', 'rows'])
      const wire = lastRequest(fixture)
      check('G2: the second process answered, and its request carries no cut-off sentence', second.exit === 0 && second.stdout.includes('G2H-SECOND-REPLY.') && says(wire, CONTINUATION) === 0 && says(wire, 'Cut off: the turn budget was spent') === 1 && wireTexts(wire).at(-1) === 'G2H second prompt.', `exit=${second.exit} ${shapeOf(wire)}`)
      const at = record.indexOf(lastTalk!)
      const failed = await resumedFrom(record.map((row, i) => (i === at ? withResult(row, { content: '<tool_use_error>File does not exist.</tool_use_error>' }) : row)), SID)
      check('G2 control: the same record with a result the tool itself gave in that place, the hook\'s row behind it, reads as cut — the sentence once', failed.state === 'interrupted_prompt' && failed.saysContinuation === 1, j(failed))
    } finally {
      await fixture.close()
    }
  }

  section('G3 — the budget ends the turn on a reply that asks for a tool: the run answers the call it leaves unrun, in the turn limit\'s form with the budget\'s own sentence; a second process resumes')
  {
    const SID = 'facef00d-0000-4000-8000-00000000a301'
    const asking: ScriptedTurn = { kind: 'tool_use', name: 'Read', id: 'toolu_g3_read', input: {}, usage: { input_tokens: 2000, output_tokens: 1000 } }
    const fixture = await startFixtureApi([handoffTurn(), asking, { kind: 'text', text: 'G3-SECOND-REPLY.' }])
    const arena = makeArena('g3', fixture)
    const note = join(arena.cwd, 'note.txt')
    writeFileSync(note, 'G3-NOTE-CONTENT\n')
    ;(asking as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: note }
    try {
      const firstRun = await run(arena, ['run', 'G3 first prompt.', '--model', MODEL, '--session-id', SID, '--budget', '0.000001', '--mode', 'implement', '--format', 'rows'])
      const rows = rowsOf(firstRun.stdout)
      const outcome = rows.findLast(row => row.type === 'outcome') as (Record<string, unknown> & { error?: { message?: string } }) | undefined
      const sentence = String(outcome?.error?.message ?? '')
      const callAt = rows.findIndex(row => row.type === 'tool_call' && row.call_id === 'toolu_g3_read')
      const resultAt = rows.findIndex(row => row.type === 'tool_result' && row.call_id === 'toolu_g3_read')
      check('G3: the run ended its own turn (its outcome row: budget_limit, "Reached the maximum budget of $0.000001") after one request', outcome?.status === 'budget_limit' && sentence === 'Reached the maximum budget of $0.000001' && fixture.messageRequests().filter(request => !isHandoffRequest(request)).length === 1, `exit=${firstRun.exit} ${j({ status: outcome?.status, sentence })} ${firstRun.stderr.slice(-200)}`)
      check('G3: its rows hold a tool_result for the call it left unrun — status aborted, "Cut off: " and the outcome\'s own sentence — between the call and the outcome', callAt !== -1 && resultAt > callAt && resultAt < rows.length - 1 && rows[resultAt]?.status === 'aborted' && rows[resultAt]?.output === `Cut off: ${sentence}`, j({ callAt, resultAt, row: rows[resultAt] ?? null, types: rows.map(row => row.type) }))
      const record = await recordOf(transcriptOf(arena, SID))
      const lastTalk = record.findLast(row => row.type === 'user' || row.type === 'assistant')
      const cut = resultsOfRow(lastTalk)[0]
      check('G3: the record ends on that result (an error result on the call\'s id), and holds no result of the tool\'s own', cut?.tool_use_id === 'toolu_g3_read' && cut.is_error === true && resultTextOf(cut) === `Cut off: ${sentence}` && !j(record).includes('G3-NOTE-CONTENT'), j({ tail: record.map(kindOf).slice(-4), cut }))
      const loaded = await resumedFrom(record, SID)
      check('G3: the loader does not read the turn as cut from outside — no cut-off sentence', loaded.state === 'none' && loaded.saysContinuation === 0, j(loaded))
      const second = await run(arena, ['run', 'G3 second prompt.', '--model', MODEL, '--resume', SID, '--mode', 'implement', '--format', 'rows'])
      const wire = lastRequest(fixture)
      check('G3: the second process answered, and its request carries the call, the run\'s own result once and the second prompt — no cut-off sentence, and nowhere that the call\'s outcome is not known', second.exit === 0 && second.stdout.includes('G3-SECOND-REPLY.') && says(wire, CONTINUATION) === 0 && says(wire, ENDED_RUN_TOOL_RESULT) === 0 && says(wire, `Cut off: ${sentence}`) === 1 && wireTexts(wire).at(-1) === 'G3 second prompt.', `exit=${second.exit} ${shapeOf(wire)}`)
    } finally {
      await fixture.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ OWN ENDING IS NOT A CUT (${checks} checks)` : ` ❌ ${failures} of ${checks} OWN-ENDING CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
