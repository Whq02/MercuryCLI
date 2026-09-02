#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-chat-tabs.ts
//  PROOF: the WoW-style chat-tab classifier (scribeChatTabs.ts) partitions the
//  transcript by author/stream into General/Scribe/Implement/Trace. Pure +
//  loadable under `bun run`; the rendering is render-verified separately (vshot).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-chat-tabs.ts
// ============================================================================
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const t = (await import('../../src/components/mercury-ui/scribeChatTabs.js')) as typeof import('../../src/components/mercury-ui/scribeChatTabs.js')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

console.log('============================================================')
console.log(' Scribe chat-tabs classifier — proof')
console.log('============================================================')

// Synthetic messages in the runtime shape (m.type + m.message.content blocks).
const opMsg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'refactor the parser' }] } }
const scribeMsg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it — dispatching' }] } }
const toolMsg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }
const toolResultMsg = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }
const implEnv = bus.buildEscalate('implementer', 'blocked on the tokenizer')
const implMsg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: bus.serializeScribeEnvelope(implEnv) }] } }
const stringMsg = { type: 'user', message: { role: 'user', content: 'plain string content' } }
// The REAL inbound shape: useInboxPoller XML-WRAPS the envelope before it lands in
// the transcript: <teammate-message teammate_id="implementer" …>\n{envelope}\n</teammate-message>.
// classifyAuthor must unwrap it (else JSON.parse fails → mislabels as the operator).
const wrap = (from: string, body: string) => `<teammate-message teammate_id="${from}" color="#3FBFA0">\n${body}\n</teammate-message>`
const wrappedImplEnvMsg = { type: 'user', message: { role: 'user', content: wrap('implementer', bus.serializeScribeEnvelope(bus.buildProgress('implementer', 'done', { detail: 'wrote the sentence' }))) } }
const wrappedImplProseMsg = { type: 'user', message: { role: 'user', content: wrap('implementer', 'Here is the short sentence you asked for.') } }
const wrappedOpMsg = { type: 'user', message: { role: 'user', content: wrap('sam', 'a normal teammate relay from a human') } }

section('messageText (defensive: blocks + string)')
check('extracts text blocks', t.messageText(opMsg) === 'refactor the parser')
check('handles string content', t.messageText(stringMsg) === 'plain string content')
check('tool-only message ⇒ empty text', t.messageText(toolMsg) === '')

section('hasToolActivity')
check('tool_use ⇒ true', t.hasToolActivity(toolMsg) === true)
check('tool_result ⇒ true', t.hasToolActivity(toolResultMsg) === true)
check('plain text ⇒ false', t.hasToolActivity(opMsg) === false)

section('classifyAuthor')
check('assistant ⇒ scribe', t.classifyAuthor(scribeMsg) === 'scribe')
check('user plain ⇒ operator', t.classifyAuthor(opMsg) === 'operator')
check('user implementer-envelope ⇒ implement', t.classifyAuthor(implMsg) === 'implement')
// The wire delivers tool_result blocks in USER-type turns. A pure tool_result turn (no
// operator prose) is the environment's reply to the SCRIBE's tool_use — it belongs
// to the Scribe's working stream, NOT the operator. Without this it mislabels as the operator.
check('user tool_result-only ⇒ scribe (mechanical tool loop, not the operator)', t.classifyAuthor(toolResultMsg) === 'scribe')
// The relay path: inbound Implementer messages are XML-wrapped before reaching the
// transcript. classifyAuthor must unwrap to attribute them to the Implementer.
check('wrapped Implementer ENVELOPE ⇒ implement (not the operator)', t.classifyAuthor(wrappedImplEnvMsg) === 'implement')
check('wrapped Implementer PROSE (teammate_id=implementer) ⇒ implement', t.classifyAuthor(wrappedImplProseMsg) === 'implement')
check('wrapped non-implementer relay (teammate_id=sam) ⇒ operator', t.classifyAuthor(wrappedOpMsg) === 'operator')

section('scribeStreamName (the inline-transcript nameplate name, no brackets)')
check('scribe ⇒ Mercury-Amanuensis (not generic [Hermes])', t.scribeStreamName('scribe', 'sam') === 'Mercury-Amanuensis')
check('implement ⇒ Mercury-Implement', t.scribeStreamName('implement', 'sam') === 'Mercury-Implement')
check('operator ⇒ the OS handle', t.scribeStreamName('operator', 'sam') === 'sam')

section('rowDisplayText: readable rows (no raw JSON / XML wrapper)')
check('wrapped Implementer envelope ⇒ readable status (not JSON)', t.rowDisplayText(wrappedImplEnvMsg) === 'done: wrote the sentence')
check('wrapped Implementer prose ⇒ unwrapped prose', t.rowDisplayText(wrappedImplProseMsg) === 'Here is the short sentence you asked for.')
check('plain operator text ⇒ itself', t.rowDisplayText(opMsg) === 'refactor the parser')

section('buildScribeLedger: dispatch→result work log from real envelopes')
const dispEnv = bus.buildDispatch('scribe', 'refactor the tokenizer', { title: 'Tokenizer' })
const ledgerTranscript = [
  { type: 'user', message: { role: 'user', content: bus.serializeScribeEnvelope(dispEnv) } },
  { type: 'user', message: { role: 'user', content: wrap('implementer', bus.serializeScribeEnvelope(bus.buildProgress('implementer', 'working', { refRequestId: dispEnv.request_id }))) } },
  { type: 'user', message: { role: 'user', content: wrap('implementer', bus.serializeScribeEnvelope(bus.buildProgress('implementer', 'done', { detail: 'merged', refRequestId: dispEnv.request_id }))) } },
  opMsg, // unrelated — not in the ledger
]
const ledger = t.buildScribeLedger(ledgerTranscript)
check('one ledger entry per dispatch (unrelated turns excluded)', ledger.length === 1)
check('entry title = the dispatch title', ledger[0]!.title === 'Tokenizer')
check('latest progress advances the status to done', ledger[0]!.status === 'done')
check('carries the latest detail', ledger[0]!.detail === 'merged')
const escTranscript = [
  { type: 'user', message: { role: 'user', content: bus.serializeScribeEnvelope(dispEnv) } },
  { type: 'user', message: { role: 'user', content: wrap('implementer', bus.serializeScribeEnvelope(bus.buildEscalate('implementer', 'API ambiguous', { refRequestId: dispEnv.request_id }))) } },
]
check('escalate flips the entry to escalated + reason', t.buildScribeLedger(escTranscript)[0]!.status === 'escalated' && t.buildScribeLedger(escTranscript)[0]!.detail === 'API ambiguous')
check('empty transcript ⇒ empty ledger', t.buildScribeLedger([]).length === 0)

section('ledger delivery honesty (trust-cockpit): envelope stamps + unacked signature')
{
  const e0 = ledger[0]!
  check('dispatchedTs = the dispatch envelope timestamp', e0.dispatchedTs === Date.parse(dispEnv.timestamp))
  check('lastUpdateTs set by the latest progress', typeof e0.lastUpdateTs === 'number')
  // unacked = still 'dispatched' past the threshold; acked/working entries never flag
  const soloDispatch = t.buildScribeLedger([
    { type: 'user', message: { role: 'user', content: bus.serializeScribeEnvelope(dispEnv) } },
  ])[0]!
  const base = Date.parse(dispEnv.timestamp)
  check("fresh 'dispatched' not flagged", !t.isDispatchUnacked(soloDispatch, base + 10_000))
  check("'dispatched' past 90s ⇒ unacked (deaf-bus signature)", t.isDispatchUnacked(soloDispatch, base + 91_000))
  check("'done' entry never flags however old", !t.isDispatchUnacked(e0, base + 10 * 60_000))
  const unstamped = { requestId: 'x', title: 'x', status: 'dispatched' as const }
  check('unstamped entry never flags (no fabricated age)', !t.isDispatchUnacked(unstamped, base + 10 * 60_000))
}

section('scribeReasoningFeed: ONLY the Scribe\'s operator-facing prose (deck feed)')
// "only reasoning + sentences is in the feed, transcript is available through the REPL"
const scribeProse1 = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it — refining the parser task and dispatching.' }] } }
const scribeProse2 = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done — the tokenizer is merged and green.' }] } }
const cmdXmlMsg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/effort</command-name>' }] } }
const cmdStdoutMsg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<local-command-stdout>effort set</local-command-stdout>' }] } }
const scribeEnvMsg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: bus.serializeScribeEnvelope(bus.buildDispatch('scribe', 'do the thing', { title: 'T' })) }] } }
const feedTranscript = [opMsg, scribeProse1, toolMsg, implMsg, cmdXmlMsg, scribeProse2, cmdStdoutMsg, toolResultMsg]
const feed = t.scribeReasoningFeed(feedTranscript, 5)
check('feed = the Scribe prose only, oldest→newest', feed.length === 2 && feed[0] === 'On it — refining the parser task and dispatching.' && feed[1] === 'Done — the tokenizer is merged and green.')
check('feed EXCLUDES the operator\'s own input turns', !feed.some(s => s.includes('refactor the parser')))
check('feed EXCLUDES raw slash-command XML scaffolding', !feed.some(s => /^<(command-name|command-message|command-args|local-command)/.test(s)))
check('feed EXCLUDES the inbound Implementer bus envelope (ledger material)', !feed.some(s => /blocked on the tokenizer/.test(s)))
check('feed EXCLUDES a raw envelope even on the scribe stream (ledger, not feed)', t.scribeReasoningFeed([scribeEnvMsg], 3).length === 0)
check('feed EXCLUDES tool-only rows (no prose)', feed.every(s => s.length > 0))
check('feed is bounded by limit (most recent kept)', t.scribeReasoningFeed([scribeProse1, scribeProse2, scribeProse1, scribeProse2], 2).length === 2)
check('feed of empty transcript = []', t.scribeReasoningFeed([], 3).length === 0)

section('messageInTab')
check('general shows everything', t.messageInTab('general', 'implement', false) && t.messageInTab('general', 'operator', false))
check('scribe shows operator + scribe, NOT implement', t.messageInTab('scribe', 'operator', false) && t.messageInTab('scribe', 'scribe', false) && !t.messageInTab('scribe', 'implement', false))
check('implement shows only implement', t.messageInTab('implement', 'implement', false) && !t.messageInTab('implement', 'scribe', false))
check('trace shows only tool-activity', t.messageInTab('trace', 'scribe', true) && !t.messageInTab('trace', 'scribe', false))

section('rowsForTab: filter + bound + order')
const transcript = [opMsg, scribeMsg, toolMsg, implMsg, toolResultMsg]
const gen = t.rowsForTab(transcript, 'general', 10)
check('general includes operator + scribe + implement rows', gen.some(r => r.author === 'operator') && gen.some(r => r.author === 'scribe') && gen.some(r => r.author === 'implement'))
const scr = t.rowsForTab(transcript, 'scribe', 10)
check('scribe excludes the implementer envelope', !scr.some(r => r.author === 'implement'))
const imp = t.rowsForTab(transcript, 'implement', 10)
check('implement ⇒ only the implementer row', imp.length === 1 && imp[0]!.author === 'implement')
const tr = t.rowsForTab(transcript, 'trace', 10)
check('trace ⇒ only tool-activity rows', tr.length === 2 && tr.every(r => r.hasTool))
const bounded = t.rowsForTab([opMsg, opMsg, opMsg, opMsg], 'general', 2)
check('bounded to limit', bounded.length === 2)
// audit-4 #3: synthetic (isMeta) user turns must NOT show as the operator.
const metaMsg = { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'internal hook re-prompt' }] } }
check('isChatNoise flags isMeta', t.isChatNoise(metaMsg) === true && t.isChatNoise(opMsg) === false)
const withMeta = t.rowsForTab([opMsg, metaMsg], 'general', 10)
check('rowsForTab excludes isMeta synthetic turns', !withMeta.some(r => r.text.includes('internal hook re-prompt')))

section('countForTab: per-tab activity tally (matches what rowsForTab shows)')
check('general counts all 5', t.countForTab(transcript, 'general') === 5)
check('scribe counts operator+scribe(+their tools) = 4', t.countForTab(transcript, 'scribe') === 4)
check('implement counts only the implementer envelope = 1', t.countForTab(transcript, 'implement') === 1)
check('trace counts tool-activity = 2', t.countForTab(transcript, 'trace') === 2)
check('count excludes isMeta noise', t.countForTab([opMsg, metaMsg], 'general') === 1)
check('count of empty transcript = 0', t.countForTab([], 'general') === 0)

section('#47 categorizeQueued + buildScribeBatchLedger (the deck BATCH ledger)')
check("'fix the parser bug' ⇒ fix", t.categorizeQueued('fix the parser bug') === 'fix')
check("'add a --json flag' ⇒ feature", t.categorizeQueued('add a --json flag') === 'feature')
check("'refactor the tokenizer' ⇒ refactor", t.categorizeQueued('refactor the tokenizer') === 'refactor')
check("'write tests for X' ⇒ test", t.categorizeQueued('write tests for X') === 'test')
check("'update the readme' ⇒ docs", t.categorizeQueued('update the readme') === 'docs')
check("'remove dead code' ⇒ cleanup", t.categorizeQueued('remove dead code') === 'cleanup')
check("'ponder the universe' ⇒ task (default)", t.categorizeQueued('ponder the universe') === 'task')
const queue = [
  { value: 'fix the off-by-one in tokenizer' },
  { value: 'fix the flaky parser test' },
  { value: 'add a --json flag to status' },
  { value: '/all heads up' }, // slash-command: skipped (not batchable task intent)
  { value: '   ' }, // empty: skipped
  { value: [{ type: 'text', text: 'refactor the AST visitor' }] }, // content-block form
]
const batches = t.buildScribeBatchLedger(queue)
check('batches group by category (fix, feature, refactor)', batches.map(b => b.category).join(',') === 'fix,feature,refactor')
check('the fix batch has BOTH fix prompts (order preserved)', batches[0]!.category === 'fix' && batches[0]!.items.length === 2)
check('slash-command + empty entries are skipped', batches.reduce((n, b) => n + b.items.length, 0) === 4)
check('content-block value text is extracted', batches.some(b => b.items.some(i => /refactor the AST visitor/.test(i))))
check('empty queue ⇒ [] (no batches box)', t.buildScribeBatchLedger([]).length === 0)

section('wiring (structural, src) — the classifier now feeds the new deck workspace (W4)')
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const deck = src('components', 'DeckPane.tsx')
const store = src('state', 'AppStateStore.ts')
// W4 retired the deck-docked WoW chat tabs + the ctrl+x t cycler + scribeChatTab
// state. The pure classifier above is now consumed by the deck's reasoning feed
// (rowsForTab) + prompt ledger (buildScribeLedger), and by the /chat surface.
check('retired: no ScribeChatTabs deck mount', !/<ScribeChatTabs/.test(deck))
check('retired: scribeChatTab state removed from AppState', !/scribeChatTab\?:/.test(store))
check('deck reasoning feed uses scribeReasoningFeed (prose only, not rowsForTab)', /scribeReasoningFeed\(chatMessages/.test(deck) && !/rowsForTab\(chatMessages/.test(deck))
check('deck feed flashes TEAL on a new turn (feedFlash state + timeout)', /feedFlash/.test(deck) && /setFeedFlash\(true\)/.test(deck))
check('deck prompt ledger uses buildScribeLedger', /buildScribeLedger\(chatMessages\)/.test(deck))
// #47 three-ledger deck: in flight + completed (split from the task ledger) + batches
// (from the command queue). Sourced from REAL data — never fabricated.
check('deck BATCH ledger uses buildScribeBatchLedger(queuedCommands)', /buildScribeBatchLedger\(queuedCommands\)/.test(deck))
// The steer-removal ruling retired the operator-facing queue
// mirror whole — useCommandQueue died with it. The deck's batch source is
// the honest empty; a live queue subscription returning here would revive
// the pen mirror (poison pin).
check('deck batch source is the honest empty (steer-removal ruling)', /const queuedCommands = EMPTY_QUEUED/.test(deck))
check('retired: no useCommandQueue subscription returns to the deck', !/useCommandQueue/.test(deck))
check('deck relabels the task ledger "in flight" + adds "completed" + "batches"', /in flight/.test(deck) && /completed/.test(deck) && /batches/.test(deck))
check('completed ledger = done dispatches (split from the task ledger)', /filter\(e => e\.status === 'done'\)/.test(deck) && /filter\(e => e\.status !== 'done'\)/.test(deck))
// audit-4 #2: the deck must read the populated scribeTranscript slice (NOT the
// never-written s.messages), and REPL must mirror the transcript into it (gated).
const repl = src('screens', 'REPL.tsx')
check('AppState carries scribeTranscript', /scribeTranscript\?:\s*Message\[\]/.test(store))
check('DeckPane reads scribeTranscript (not the absent s.messages)', /s\?\.scribeTranscript/.test(deck) && !/s\?\.messages\b/.test(deck))
// Law 9 shape: the face never writes the transcript — the mirror follows the
// focused records as they change, scribe-gated and identity-guarded.
check('REPL mirrors the focused transcript into scribeTranscript, scribe-gated ', /if \(!isScribeModeOn\(\)\) return;[\s\S]{0,240}if \(next === prev\) return;[\s\S]{0,200}scribeTranscript:\s*next/.test(repl))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CHAT-TABS PROOFS PASS')
else console.log(`❌ ${failures} CHAT-TABS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
