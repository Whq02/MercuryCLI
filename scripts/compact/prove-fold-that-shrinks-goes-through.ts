import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordToEntry } from '../../src/sessions/fabric/entryCodec.ts'
import { historyLines } from '../../src/sessions/transcripts/historyParts.ts'
import { withFixtureRunner } from '../lib/builtProduct.ts'
import type { CapturedRequest, FixtureApi, ScriptedTurn } from '../lib/fixtureApi.ts'
import { transcriptFiles } from '../daemon/dupline-world.ts'

const FOLD = 'Write the running record of this conversation'
const SUMMARY = '<summary>The notes of the earlier turn are recorded and nothing is open.</summary>'
const notes = Array.from({ length: 700 }, (_, i) => `Note ${i + 1}: module ${(i * 7919) % 1000} changed and its ${(i * 31) % 97} checks pass.`).join(' ')
const long = (inputTokens: number): ScriptedTurn => ({ kind: 'text', text: notes, usage: { input_tokens: inputTokens, output_tokens: 8_000 } })
const METER = 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must count the conversation before the fold by the estimate it counts the fold with, never by the smaller of that estimate and the provider figure'
const RECEIPT = 'compactConversation in src/engine/compaction/foldConversation.ts must report the after figure of a manual fold as the before figure less what the fold saved by the one estimate'
const SENT_AGAIN = 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must leave the skills list out of the count before the fold: the next turn sends it again, so a fold credited with it can leave the next request longer'
const FLOOR = 'projectManualFold in src/engine/compaction/fold/projection.ts must project the summary at the shortest prose Mercury records as a full one (DEGRADED_SUMMARY_LENGTH in src/engine/compaction/fold/foldLimits.ts), so that the summariser is asked and its real summary judged'
const ONCE = 'autoCompactIfNeeded in src/engine/compaction/autoFold.ts must complete the queued /compact when compactConversation in src/engine/compaction/foldConversation.ts refuses its fold after the summary, and no later step or turn may ask for a summary nobody asked for'
const KEPT = 'compactConversation in src/engine/compaction/foldConversation.ts must throw its refusal before anything of the fold is committed: no boundary or summary row is stored and the conversation stands as it was'

let failures = 0
function check(label: string, ok: boolean, seen: unknown, change: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${JSON.stringify(seen)} — change: ${change}`}`)
}

function tokensOf(figure: string | undefined): number {
  if (figure === undefined) return Number.NaN
  return Number.parseFloat(figure) * (figure.endsWith('m') ? 1_000_000 : figure.endsWith('k') ? 1_000 : 1)
}

function receiptFigures(receipt: string): { before: number; after: number } {
  const pair = /context (\S+) → (\S+) tokens/.exec(receipt)
  return { before: tokensOf(pair?.[1]), after: tokensOf(pair?.[2]) }
}

function aroundTheFold(api: FixtureApi): { summaries: CapturedRequest[]; before: CapturedRequest | undefined; after: CapturedRequest | undefined } {
  const sent = api.messageRequests().filter(request => !request.path.includes('count_tokens'))
  const summaries = sent.filter(request => request.raw.includes(FOLD))
  const at = summaries[0] === undefined ? -1 : sent.indexOf(summaries[0])
  return { summaries, before: at < 1 ? undefined : sent[at - 1], after: at < 0 ? undefined : sent.slice(at + 1).find(request => !request.raw.includes(FOLD)) }
}

async function twoLongTurns(): Promise<void> {
  await withFixtureRunner([long(20_500), long(28_600), { kind: 'text', text: SUMMARY, whenBody: FOLD }, { kind: 'text', text: 'carried on' }], async (runner, api) => {
    await runner.prompt('record the notes')
    await runner.waitFor('the first long turn', row => row.type === 'outcome' && row.turn === 1)
    await runner.prompt('record the notes once more')
    await runner.waitFor('the second long turn', row => row.type === 'outcome' && row.turn === 2)
    await runner.prompt('/compact')
    const folded = await runner.waitFor('the turn of /compact', row => row.type === 'outcome' && row.turn === 3)
    await runner.prompt('carry on')
    await runner.waitFor('the turn after the fold', row => row.type === 'outcome' && row.turn === 4)
    const receipt = String(folded.answer ?? (folded.error as { message?: string } | undefined)?.message ?? '')
    const figures = receiptFigures(receipt)
    const { summaries, before, after } = aroundTheFold(api)
    check('two long turns: /compact folds, where the provider counts fewer tokens than the estimate', folded.status === 'completed' && receipt.startsWith('Compacted — folded '), receipt, METER)
    check('two long turns: the summary is asked for once', summaries.length === 1, summaries.length, METER)
    check('two long turns: the receipt reads a smaller context after than before', figures.after < figures.before, receipt, RECEIPT)
    check('two long turns: the request after the fold is shorter than the unfolded conversation, the second turn and its answer', before !== undefined && after !== undefined && after.raw.length < before.raw.length + notes.length, { before: before?.raw.length, answer: notes.length, after: after?.raw.length }, METER)
  }, { env: { MERCURY_SESSION_KIND: 'oculus' } })
}

function storedEntries(home: string, session: string): ReturnType<typeof recordToEntry>[] {
  const file = transcriptFiles(join(home, 'projects')).find(path => path.endsWith(`${session}.jsonl`))
  return file === undefined ? [] : Array.from(historyLines(file), line => recordToEntry(JSON.parse(line.toString('utf8'))))
}

function foldRowsOf(entries: ReturnType<typeof recordToEntry>[]): number {
  return entries.filter(row => (row.type === 'system' && row.subtype === 'compact_boundary') || (row.type === 'user' && row.isCompactSummary === true)).length
}

function answersIn(request: CapturedRequest | undefined): number {
  return request === undefined ? -1 : request.raw.split(notes).length - 1
}

async function summaryNearlyAsLongAsItsTurn(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'fold-that-shrinks-'))
  const session = randomUUID()
  const summary = `<summary>${notes.slice(0, notes.length - 1_600)}</summary>`
  try {
    await withFixtureRunner([long(20_500), long(28_600), { kind: 'text', text: summary, whenBody: FOLD }, { kind: 'text', text: 'carried on' }], async (runner, api) => {
      await runner.prompt('record the notes')
      await runner.waitFor('the first long turn', row => row.type === 'outcome' && row.turn === 1)
      await runner.prompt('record the notes once more')
      await runner.waitFor('the second long turn', row => row.type === 'outcome' && row.turn === 2)
      await runner.prompt('/compact')
      const kept = await runner.waitFor('the turn of /compact', row => row.type === 'outcome' && row.turn === 3)
      const words = String((kept.error as { message?: string } | undefined)?.message ?? kept.answer ?? '')
      check('a summary 400 tokens shorter than its turn: /compact keeps the conversation and says why', kept.status === 'failed' && /^Nothing to compact yet: a summary would not shrink the \S+ tokens\.$/.test(words), words, SENT_AGAIN)
      check('a summary 400 tokens shorter than its turn: the summary was asked for once', aroundTheFold(api).summaries.length === 1, aroundTheFold(api).summaries.length, SENT_AGAIN)
      await runner.prompt('carry on')
      await runner.waitFor('the turn after the refusal', row => row.type === 'outcome' && row.turn === 4)
      const { summaries, after } = aroundTheFold(api)
      check('a summary 400 tokens shorter than its turn: the turn after the refusal asks for no second summary', summaries.length === 1, summaries.length, ONCE)
      check('a summary 400 tokens shorter than its turn: the turn after the refusal is sent the whole conversation, both answers', answersIn(after) === 2, { answers: answersIn(after), bytes: after?.raw.length }, KEPT)
      await runner.stop()
    }, { argv: ['--session-id', session], env: { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus' } })
    check('a summary 400 tokens shorter than its turn: the stored transcript holds no fold boundary and no summary row', storedEntries(home, session).length > 0 && foldRowsOf(storedEntries(home, session)) === 0, { rows: storedEntries(home, session).length, foldRows: foldRowsOf(storedEntries(home, session)) }, KEPT)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

async function foldOfOneShortAnswer(): Promise<void> {
  const short: ScriptedTurn = { kind: 'text', text: notes.slice(0, 8_000), usage: { input_tokens: 20_500, output_tokens: 1_700 } }
  await withFixtureRunner([short, long(22_300), long(30_400), { kind: 'text', text: SUMMARY, whenBody: FOLD }, { kind: 'text', text: 'carried on' }], async (runner, api) => {
    for (const [index, ask] of ['record the first notes', 'record the notes', 'record the notes once more'].entries()) {
      await runner.prompt(ask)
      await runner.waitFor(`turn ${index + 1}`, row => row.type === 'outcome' && row.turn === index + 1)
    }
    await runner.prompt('/compact')
    const folded = await runner.waitFor('the turn of /compact', row => row.type === 'outcome' && row.turn === 4)
    await runner.prompt('carry on')
    await runner.waitFor('the turn after the fold', row => row.type === 'outcome' && row.turn === 5)
    const receipt = String(folded.answer ?? (folded.error as { message?: string } | undefined)?.message ?? '')
    const figures = receiptFigures(receipt)
    const { summaries, before, after } = aroundTheFold(api)
    check('a head of one 2,000-token answer: /compact folds it, where a summary assumed at 2,000 tokens would have refused', folded.status === 'completed' && receipt.startsWith('Compacted — folded '), receipt, FLOOR)
    check('a head of one 2,000-token answer: the summary is asked for once', summaries.length === 1, summaries.length, FLOOR)
    check('a head of one 2,000-token answer: the receipt reads a smaller context after than before', figures.after < figures.before, receipt, FLOOR)
    check('a head of one 2,000-token answer: the request after the fold is shorter than the unfolded conversation, the third turn and its answer', before !== undefined && after !== undefined && after.raw.length < before.raw.length + notes.length, { before: before?.raw.length, answer: notes.length, after: after?.raw.length }, FLOOR)
  }, { env: { MERCURY_SESSION_KIND: 'oculus' } })
}

async function queuedMidTurn(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'fold-that-shrinks-'))
  const session = randomUUID()
  const queued = randomUUID()
  try {
    writeFileSync(join(home, 'note'), 'a fixture line')
    const read: ScriptedTurn = { kind: 'tool_use', name: 'Read', input: { file_path: join(home, 'note') }, usage: { input_tokens: 28_600, output_tokens: 30 } }
    await withFixtureRunner([long(20_500), read, { kind: 'text', text: SUMMARY, whenBody: FOLD }, { kind: 'text', text: 'continued the same turn' }], async (runner, api) => {
      await runner.prompt('record the notes')
      await runner.waitFor('the long turn', row => row.type === 'outcome' && row.turn === 1)
      await runner.prompt('read the fixture note')
      const ask = await runner.waitForAsk('the read holds the turn open')
      await runner.prompt('/compact', { id: queued })
      runner.answerAsk(ask.id, { outcome: 'allow' })
      const end = await runner.waitFor('the turn the fold ran in', row => row.type === 'outcome' && row.turn === 2)
      const folds = runner.rows.slice(0, runner.rows.indexOf(end)).filter(row => row.type === 'compaction' && row.state === 'ended')
      const { summaries, before, after } = aroundTheFold(api)
      check('queued mid-turn: the fold lands inside the open turn', folds.length === 1 && folds[0]?.trigger === 'manual' && folds[0]?.exit === 'landed', folds, METER)
      check('queued mid-turn: the summary is asked for once', summaries.length === 1, summaries.length, METER)
      check('queued mid-turn: the request after the fold is shorter than the request before it', before !== undefined && after !== undefined && after.raw.length < before.raw.length, { before: before?.raw.length, after: after?.raw.length }, METER)
      await runner.stop()
    }, { argv: ['--session-id', session], env: { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus' } })
    const entries = storedEntries(home, session)
    const receipts = entries.filter(row => row.type === 'system' && row.subtype === 'local_command' && String(row.content).includes('Compacted — ')).map(row => String(row.content))
    const figures = receiptFigures(receipts[0] ?? '')
    const journal = entries.filter(row => row.type === 'queue-operation' && row.commandUuid === queued).map(row => row.operation)
    check('queued mid-turn: one receipt, reading a smaller context after than before', receipts.length === 1 && figures.after < figures.before, receipts, RECEIPT)
    check('queued mid-turn: the queued line is entered once and settled once', journal.length === 2 && journal[0] === 'enqueue' && (journal[1] === 'dequeue' || journal[1] === 'remove'), journal, 'autoCompactIfNeeded in src/engine/compaction/autoFold.ts must complete the queued /compact once when its fold lands')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

async function queuedAndRefused(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'fold-that-shrinks-'))
  const session = randomUUID()
  const queued = randomUUID()
  try {
    writeFileSync(join(home, 'note'), 'a fixture line')
    const read: ScriptedTurn = { kind: 'tool_use', name: 'Read', input: { file_path: join(home, 'note') }, usage: { input_tokens: 28_600, output_tokens: 30 } }
    await withFixtureRunner([long(20_500), read, { kind: 'text', text: `<summary>${notes} ${notes}</summary>`, whenBody: FOLD }, { kind: 'text', text: 'continued the same turn' }, { kind: 'text', text: 'carried on' }], async (runner, api) => {
      await runner.prompt('record the notes')
      await runner.waitFor('the long turn', row => row.type === 'outcome' && row.turn === 1)
      await runner.prompt('read the fixture note')
      const ask = await runner.waitForAsk('the read holds the turn open')
      await runner.prompt('/compact', { id: queued })
      runner.answerAsk(ask.id, { outcome: 'allow' })
      const end = await runner.waitFor('the turn the fold was asked in', row => row.type === 'outcome' && row.turn === 2)
      const folds = runner.rows.slice(0, runner.rows.indexOf(end)).filter(row => row.type === 'compaction' && row.state === 'ended')
      check('queued and refused: one fold is tried inside the open turn and does not land', folds.length === 1 && folds[0]?.trigger === 'manual' && folds[0]?.exit !== 'landed', folds, ONCE)
      check('queued and refused: the open turn goes on to its answer', end.status === 'completed' && String(end.answer ?? '').includes('continued the same turn'), { status: end.status, answer: end.answer }, ONCE)
      await runner.prompt('carry on')
      await runner.waitFor('the turn after the refusal', row => row.type === 'outcome' && row.turn === 3)
      const { summaries, after } = aroundTheFold(api)
      check('queued and refused: the summary is asked for once, at no later step and not on the next turn', summaries.length === 1 && runner.rows.filter(row => row.type === 'compaction' && row.state === 'ended').length === 1, { summaries: summaries.length, folds: runner.rows.filter(row => row.type === 'compaction' && row.state === 'ended').length }, ONCE)
      check('queued and refused: the step after the refusal is sent the long answer whole', answersIn(after) === 1, { answers: answersIn(after), bytes: after?.raw.length }, KEPT)
      await runner.stop()
    }, { argv: ['--session-id', session], env: { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus' } })
    const entries = storedEntries(home, session)
    const told = entries.filter(row => row.type === 'system' && /^Nothing to compact yet: a summary would not shrink the \S+ tokens\.$/.test(String(row.content)))
    const journal = entries.filter(row => row.type === 'queue-operation' && row.commandUuid === queued).map(row => row.operation)
    check('queued and refused: the user is told why once', told.length === 1, entries.filter(row => row.type === 'system').map(row => String(row.content).slice(0, 120)), ONCE)
    check('queued and refused: the queued line is entered once and settled once', journal.length === 2 && journal[0] === 'enqueue' && (journal[1] === 'dequeue' || journal[1] === 'remove'), journal, ONCE)
    check('queued and refused: the stored transcript holds no fold boundary and no summary row', foldRowsOf(entries) === 0, foldRowsOf(entries), KEPT)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

await twoLongTurns()
await summaryNearlyAsLongAsItsTurn()
await foldOfOneShortAnswer()
await queuedMidTurn()
await queuedAndRefused()
process.exitCode = failures ? 1 : 0
