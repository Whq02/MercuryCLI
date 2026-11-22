import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordToEntry } from '../../src/fabric/entryCodec.ts'
import { historyLines } from '../../src/utils/sessionStorage/historyParts.ts'
import { withFixtureRunner } from '../lib/builtProduct.ts'
import type { CapturedRequest, FixtureApi, ScriptedTurn } from '../lib/fixtureApi.ts'
import { transcriptFiles } from '../daemon/dupline-world.ts'

const FOLD = 'Write the running record of this conversation'
const SUMMARY = '<summary>The notes of the earlier turn are recorded and nothing is open.</summary>'
const notes = Array.from({ length: 700 }, (_, i) => `Note ${i + 1}: module ${(i * 7919) % 1000} changed and its ${(i * 31) % 97} checks pass.`).join(' ')
const long = (inputTokens: number): ScriptedTurn => ({ kind: 'text', text: notes, usage: { input_tokens: inputTokens, output_tokens: 8_000 } })
const METER = 'createFoldMeter in src/services/compact/compact/foldMeasure.ts must count the conversation before the fold by the estimate it counts the fold with, never by the smaller of that estimate and the provider figure'
const RECEIPT = 'compactConversation in src/services/compact/compact.ts must report the after figure of a manual fold as the before figure less what the fold saved by the one estimate'
const SENT_AGAIN = 'createFoldMeter in src/services/compact/compact/foldMeasure.ts must leave the skills list out of the count before the fold: the next turn sends it again, so a fold credited with it can leave the next request longer'

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

async function summaryNearlyAsLongAsItsTurn(): Promise<void> {
  const summary = `<summary>${notes.slice(0, notes.length - 1_600)}</summary>`
  await withFixtureRunner([long(20_500), long(28_600), { kind: 'text', text: summary, whenBody: FOLD }], async (runner, api) => {
    await runner.prompt('record the notes')
    await runner.waitFor('the first long turn', row => row.type === 'outcome' && row.turn === 1)
    await runner.prompt('record the notes once more')
    await runner.waitFor('the second long turn', row => row.type === 'outcome' && row.turn === 2)
    await runner.prompt('/compact')
    const kept = await runner.waitFor('the turn of /compact', row => row.type === 'outcome' && row.turn === 3)
    const words = String((kept.error as { message?: string } | undefined)?.message ?? kept.answer ?? '')
    check('a summary 400 tokens shorter than its turn: /compact keeps the conversation and says why', kept.status === 'failed' && /^Nothing to compact yet: a summary would not shrink the \S+ tokens\.$/.test(words), words, SENT_AGAIN)
    check('a summary 400 tokens shorter than its turn: the summary was asked for once', aroundTheFold(api).summaries.length === 1, aroundTheFold(api).summaries.length, SENT_AGAIN)
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
    const file = transcriptFiles(join(home, 'projects')).find(path => path.endsWith(`${session}.jsonl`))
    const entries = file === undefined ? [] : Array.from(historyLines(file), line => recordToEntry(JSON.parse(line.toString('utf8'))))
    const receipts = entries.filter(row => row.type === 'system' && row.subtype === 'local_command' && String(row.content).includes('Compacted — ')).map(row => String(row.content))
    const figures = receiptFigures(receipts[0] ?? '')
    const journal = entries.filter(row => row.type === 'queue-operation' && row.commandUuid === queued).map(row => row.operation)
    check('queued mid-turn: one receipt, reading a smaller context after than before', receipts.length === 1 && figures.after < figures.before, receipts, RECEIPT)
    check('queued mid-turn: the queued line is entered once and settled once', journal.length === 2 && journal[0] === 'enqueue' && (journal[1] === 'dequeue' || journal[1] === 'remove'), journal, 'autoCompactIfNeeded in src/services/compact/autoCompact.ts must complete the queued /compact once when its fold lands')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

await twoLongTurns()
await summaryNearlyAsLongAsItsTurn()
await queuedMidTurn()
process.exitCode = failures ? 1 : 0
