#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY', 'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_SM_COMPACT', 'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
const scratch = mkdtempSync(join(tmpdir(), 'footer-matches-receipt-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string, change: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} — change: ${change}`}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-footer-matches-receipt exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const FOLD = 'Write the running record of this conversation'
const FILL = "contextFill in src/engine/context-window/contextTokenCount.ts must read the last manual fold's record (postTokens and postEstimate on its boundary, written by compactConversation in src/engine/compaction/foldConversation.ts) until a provider count lands for the seated model"
const TRIGGER = 'tokenCountWithEstimation in src/engine/context-window/contextTokenCount.ts is the count the automatic fold reads: it must stay the request estimate and never read a fold\'s record'

const { recordToEntry } = await import('../../src/sessions/fabric/entryCodec.ts')
const { historyLines } = await import('../../src/sessions/transcripts/historyParts.ts')
const { transcriptFiles } = await import('../daemon/dupline-world.ts')
const { liveFactsOf, withFixtureRunner } = await import('../lib/builtProduct.ts')
type Turn = import('../lib/fixtureApi.ts').ScriptedTurn

const notes = Array.from({ length: 700 }, (_, i) => `Note ${i + 1}: module ${(i * 7919) % 1000} changed and its ${(i * 31) % 97} checks pass.`).join(' ')
const afterFigureOf = (receipt: string): string => /context \S+ → (\S+) tokens/.exec(receipt)?.[1] ?? 'no after figure'

async function foldInTheProduct(usageOf: (turn: number) => { input_tokens: number; output_tokens: number }): Promise<{ receipt: string; before: number | null; footer: number | null; source: string | null; refusal: string; summaries: number; settled: number | null; settledSource: string | null; recorded: number | undefined }> {
  const home = join(scratch, `runner-${randomUUID()}`)
  const session = randomUUID()
  const seen = { receipt: '', before: null as number | null, footer: null as number | null, source: null as string | null, refusal: '', summaries: -1, settled: null as number | null, settledSource: null as string | null }
  const turns: Turn[] = [
    ...[0, 1, 2, 3].map(turn => ({ kind: 'text' as const, text: notes, usage: usageOf(turn) })),
    { kind: 'text', text: '<summary>The notes of the earlier turns are recorded and nothing is open.</summary>', whenBody: FOLD, usage: usageOf(4) },
    { kind: 'text', text: 'carried on', usage: usageOf(5) },
  ]
  await withFixtureRunner(turns, async (runner, api) => {
    for (const turn of [1, 2, 3, 4]) {
      await runner.prompt(`record the notes, pass ${turn}`)
      await runner.waitFor(`turn ${turn}`, row => row.type === 'outcome' && row.turn === turn)
    }
    seen.before = (await liveFactsOf(runner)).usage.context?.usedTokens ?? null
    await runner.prompt('/compact')
    const folded = await runner.waitFor('the turn of /compact', row => row.type === 'outcome' && row.turn === 5)
    seen.receipt = String(folded.answer ?? (folded.error as { message?: string } | undefined)?.message ?? '')
    const after = (await liveFactsOf(runner)).usage.context
    seen.footer = after?.usedTokens ?? null
    seen.source = after?.fillSource ?? null
    await runner.prompt('/compact')
    const again = await runner.waitFor('a second /compact at once', row => row.type === 'outcome' && row.turn === 6)
    seen.refusal = String((again.error as { message?: string } | undefined)?.message ?? again.answer ?? '')
    seen.summaries = api.messageRequests().filter(request => request.raw.includes(FOLD)).length
    await runner.prompt('carry on')
    await runner.waitFor('the turn after the fold', row => row.type === 'outcome' && row.turn === 7)
    const settled = (await liveFactsOf(runner)).usage.context
    seen.settled = settled?.usedTokens ?? null
    seen.settledSource = settled?.fillSource ?? null
    await runner.stop()
  }, { argv: ['--session-id', session], env: { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus' } })
  const file = transcriptFiles(join(home, 'projects')).find(path => path.endsWith(`${session}.jsonl`))
  const entries = file === undefined ? [] : Array.from(historyLines(file), line => recordToEntry(JSON.parse(line.toString('utf8'))))
  const boundary = entries.find(row => row.type === 'system' && row.subtype === 'compact_boundary')
  return { ...seen, recorded: (boundary?.compactMetadata as { postTokens?: number } | undefined)?.postTokens }
}

section('1 the built product, a provider that counts fewer tokens than the estimate: the footer after /compact')
{
  const run = await foldInTheProduct(turn => (turn < 4 ? { input_tokens: 20_500 + turn * 8_100, output_tokens: 8_000 } : { input_tokens: 30_000, output_tokens: 5 }))
  check('/compact folds and its receipt reads a smaller context', run.receipt.startsWith('Compacted — folded ') && run.recorded !== undefined && run.before !== null && run.recorded < run.before, JSON.stringify(run), FILL)
  check("the footer reads the after size of the fold's record, the figure the receipt prints", run.footer !== null && run.footer === run.recorded, JSON.stringify({ footer: run.footer, recorded: run.recorded, receipt: run.receipt }), FILL)
  check('it is still marked as an estimate: no provider count has landed', run.source === 'estimate', String(run.source), FILL)
  check('a second /compact at once names that same figure in its refusal', run.refusal === `Nothing to compact: the last fold already holds this conversation (${afterFigureOf(run.receipt)} tokens)`, run.refusal, 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must take the context before a fold from contextFill in src/engine/context-window/contextTokenCount.ts')
  check('that second /compact asks for no summary: the one request of the session is the fold that landed', run.summaries === 1, String(run.summaries), 'call in src/commands/compact/compact.ts must refuse a fold that would fold no working round before it asks for a summary (manualFoldHasNothingToFold in src/engine/compaction/fold/projection.ts)')
  check("once the next answer lands, the footer reads the provider's count", run.settledSource === 'usage' && run.settled === 30_005, JSON.stringify({ settled: run.settled, source: run.settledSource }), FILL)
}

section('2 the built product, a provider that reports no usage: the footer after /compact')
{
  const run = await foldInTheProduct(() => ({ input_tokens: 0, output_tokens: 0 }))
  check('/compact folds and its receipt reads a smaller context', run.receipt.startsWith('Compacted — folded ') && run.recorded !== undefined && run.before !== null && run.recorded < run.before, JSON.stringify(run), FILL)
  check("the footer reads the after size of the fold's record: the folded rows are not counted, the skills list on its way back is", run.footer !== null && run.footer === run.recorded, JSON.stringify({ footer: run.footer, recorded: run.recorded, receipt: run.receipt }), FILL)
  check('a second /compact at once names that same figure in its refusal', run.refusal === `Nothing to compact: the last fold already holds this conversation (${afterFigureOf(run.receipt)} tokens)`, run.refusal, 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must take the context before a fold from contextFill in src/engine/context-window/contextTokenCount.ts')
  check('that second /compact asks for no summary: the one request of the session is the fold that landed', run.summaries === 1, String(run.summaries), 'call in src/commands/compact/compact.ts must refuse a fold that would fold no working round before it asks for a summary (manualFoldHasNothingToFold in src/engine/compaction/fold/projection.ts)')
  check('once the next turn has run, the footer counts the conversation that stands, no less than the fold left', run.settledSource === 'estimate' && run.settled !== null && run.recorded !== undefined && run.settled >= run.recorded, JSON.stringify({ settled: run.settled, recorded: run.recorded }), FILL)
}

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { contextFill, tokenCountWithEstimation } = await import('../../src/engine/context-window/contextTokenCount.ts')
const { contextFillView } = await import('../../src/engine/context-window/contextFill.ts')
const { requestGaugeDigest } = await import('../../src/engine/run/requestGauge.ts')
const { buildPostFoldMessages } = await import('../../src/engine/compaction/foldConversation.ts')
const { estimateContextTokens } = await import('../../src/engine/compaction/pruneToolResults.ts')
const { call } = await import('../../src/commands/compact/compact.ts')

section('3 the measure: the conversation as stored after a manual fold, read for the model that measured it, for the automatic fold and for a model of another family')
{
  const SOURCE = 'claude-opus-4-8'
  const OTHER = 'gpt-5.6-sol'
  const FIXED = 31_900
  type AnyMsg = Record<string, unknown> & { type?: string }
  const rows: AnyMsg[] = []
  for (let n = 1; n <= 6; n++) {
    rows.push(createUserMessage({ content: `write design note ${n}` }) as AnyMsg)
    let text = ''
    for (let line = 0; text.length < 40_000; line++) text += `Note ${n}, section ${line} records a module boundary: ${(n * 7919 + line * 104729).toString(16).padStart(64, 'a')}. Check the indexed observations before changing it.\n`
    const digest = requestGaugeDigest(rows as never)
    const asked = estimateContextTokens(rows as never, SOURCE)
    const reply: AnyMsg = { type: 'assistant', uuid: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, timestamp: new Date().toISOString(), requestId: `req_${n}`, message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: SOURCE, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null } }
    const answered = estimateContextTokens([...rows, reply] as never, SOURCE)
    ;(reply.message as Record<string, unknown>).usage = { input_tokens: FIXED + asked - 9_000, output_tokens: answered - asked, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    reply.contextGauge = { version: 1, key: `anthropic:${SOURCE}:c1`, epoch: 1, digest, rawTokens: asked, fixed: { digest: 'f', tokens: FIXED }, density: { ratio: 1, samples: 0, residuals: [] }, sample: { eligible: false, denominator: 0, measured: 0, reason: 'cold' } }
    rows.push(reply)
  }
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: SOURCE, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (update: (prev: never) => never): void => {
      appState = update(appState as never) as unknown as Record<string, unknown>
    },
    messages: rows,
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  fixture.script([{ text: 'SUMMARY BY OPUS: the design notes were written one by one and the operator asked to carry on from them.' }, { text: 'never reached' }])
  const folded = (await call('', context as never)) as { type: string; compactionResult: Parameters<typeof buildPostFoldMessages>[0] }
  const post = buildPostFoldMessages(folded.compactionResult) as AnyMsg[]
  const stored = [...rows, ...post]
  const recorded = folded.compactionResult.boundaryMarker.compactMetadata.postTokens
  const estimate = FIXED + estimateContextTokens(post as never, SOURCE)
  check('the fixture: the provider counted 9,000 tokens fewer than the estimate, so the record and the estimate differ', recorded !== undefined && estimate - recorded === 9_000, JSON.stringify({ recorded, estimate }), 'the fixture of this proof: the stamped usage must stand 9,000 under the gauge estimate')
  check('the fill and the footer view read the record for the model that measured the conversation', contextFill(stored as never, SOURCE).tokens === recorded && contextFillView(stored as never, SOURCE).usedTokens === recorded, JSON.stringify({ fill: contextFill(stored as never, SOURCE), view: contextFillView(stored as never, SOURCE).usedTokens, recorded }), FILL)
  check('a row added after the fold is counted on top of the record once the conversation outgrows it', contextFill([...stored, createUserMessage({ content: 'x'.repeat(8_000) })] as never, SOURCE).tokens === (recorded ?? 0) + 2_000, JSON.stringify({ fill: contextFill([...stored, createUserMessage({ content: 'x'.repeat(8_000) })] as never, SOURCE), recorded }), FILL)
  check('the count the automatic fold reads is the request estimate, as before', tokenCountWithEstimation(stored as never, SOURCE) === estimate, JSON.stringify({ count: tokenCountWithEstimation(stored as never, SOURCE), estimate }), TRIGGER)
  check("a model of another family reads its own estimate of the rows that stand, never the measuring model's record", contextFill(stored as never, OTHER).tokens === estimateContextTokens(post as never, OTHER), JSON.stringify({ fill: contextFill(stored as never, OTHER), rows: estimateContextTokens(post as never, OTHER), recorded }), FILL)
}

await fixture.close()
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
