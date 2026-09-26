#!/usr/bin/env bun
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-batch-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['TYPESAFE_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0006'

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { startJevStandin } = await import('./lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setJevEnabled, setJevPacePerMinute } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { jevLedgerSnapshot, noteJevAttempt, resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { JEV_SUBAGENT_CALL_BUDGET, JEV_TOOL_NAME } = await import('../../src/services/jev/jevContract.ts')
const { runWithAgentContext } = await import('../../src/utils/agentContext.ts')
const { formatZodValidationError } = await import('../../src/utils/toolErrors.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { JevEvalTool, jevEvalCall } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_PROMPT } = await import('../../src/tools/JevEvalTool/prompt.ts')

setJevEnabled(true)
storeJevApiKey(PROOF_KEY)
resetJevLedger()

const schema = JevEvalTool.inputSchema
const parse = (input: unknown) => schema.safeParse(input)
const refusal = (input: unknown): string => {
  const r = parse(input)
  return r.success ? 'ok' : formatZodValidationError(JEV_TOOL_NAME, r.error, zodToJsonSchema(schema as never))
}
const noul = (id: string, ask: string) => ({ id, kind: 'noul' as const, ask })
const questions = [
  noul('killed', 'Does `tail` name a kill from outside (rc 137, a signal, a kill line)?'),
  { id: 'class', kind: 'choice' as const, ask: 'Which one class explains this red?', options: { harness: 'a kill or a runner fault', product: 'the product answers wrongly' }, allow_none: true },
  { id: 'sev', kind: 'score' as const, ask: 'If real, how much does it matter?', levels: ['cosmetic', 'a re-true', 'a user-visible defect'] },
]
const items = [
  { id: 'ui', tail: 'rc 137 — killed by the runner after the deadline' },
  'expected the row "settled" and the frame read "settling"; no kill line, no deadline',
  { id: 'api', tail: 'capture deadline exceeded; the last frame is empty', rc: '1' },
]
const call = (evidence: unknown[] = items, qs: unknown[] = questions) => ({ goal: 'sort three reds', evidence, questions: qs })
const context = { abortController: new AbortController() } as never
const stateOf = (index: number): unknown => (standin.received[index]?.body as { state?: unknown } | undefined)?.state
const questionsOf = (index: number): unknown => (standin.received[index]?.body as { questions?: unknown } | undefined)?.questions

section('§1 the input is a LIST of evidence items — named-facts records or bare paragraphs — and one question set')
check('a list of three items (a record with an id, a paragraph, a record with an id) parses', parse(call()).success, refusal(call()))
check('a list of one item parses (a single item is a one-row table)', parse(call([items[0]!])).success, refusal(call([items[0]!])))
check('a record without an id parses (its row is keyed by position)', parse(call([{ fact: 'a measured value' }])).success, refusal(call([{ fact: 'a measured value' }])))
const single = { goal: 'g', evidence: { fact: 'the old single-record form' }, questions }
check('the old single-record form is refused, naming `evidence`', !parse(single).success && /`evidence`/.test(refusal(single)), refusal(single))
check('an empty list is refused, naming `evidence`', !parse(call([])).success && /`evidence`/.test(refusal(call([]))), refusal(call([])))
check('an empty paragraph is refused, naming `evidence[1]`', !parse(call([items[0]!, ''])).success && /evidence\[1\]/.test(refusal(call([items[0]!, '']))), refusal(call([items[0]!, ''])))
check('a record carrying only an id is refused, naming `evidence[0]`', !parse(call([{ id: 'lonely' }])).success && /evidence\[0\]/.test(refusal(call([{ id: 'lonely' }]))) && /named fact/.test(refusal(call([{ id: 'lonely' }]))), refusal(call([{ id: 'lonely' }])))
const twice = call([{ id: 'same', a: 'x' }, { id: 'same', b: 'y' }])
check('two items with the same id are refused, naming `evidence[1].id`', !parse(twice).success && /evidence\[1\]\.id/.test(refusal(twice)) && /twice/.test(refusal(twice)), refusal(twice))
check('an item that is neither a paragraph nor a record is refused, naming `evidence[0]` and both forms', !parse(call([42])).success && /evidence\[0\]/.test(refusal(call([42]))) && /paragraph/.test(refusal(call([42]))) && /named facts/.test(refusal(call([42]))), refusal(call([42])))
check('a fact that is not a string is refused, naming `evidence[0]` and the string-values rule', !parse(call([{ id: 'ui', tail: 137 }])).success && /evidence\[0\]/.test(refusal(call([{ id: 'ui', tail: 137 }]))) && /string values/.test(refusal(call([{ id: 'ui', tail: 137 }]))), refusal(call([{ id: 'ui', tail: 137 }])))
check('an id with a space is refused, naming `evidence[0].id`', !parse(call([{ id: 'u i', tail: 'x' }])).success && /evidence\[0\]\.id/.test(refusal(call([{ id: 'u i', tail: 'x' }]))), refusal(call([{ id: 'u i', tail: 'x' }])))
const jsonSchema = JSON.stringify(zodToJsonSchema(schema as never))
check('the wire schema says evidence is an array whose items are a string or a string-valued record with an optional id', /"evidence":\{[^}]*"type":"array"/.test(jsonSchema) && /"anyOf":\[\{"type":"string"/.test(jsonSchema) && /"additionalProperties":\{"type":"string"\}/.test(jsonSchema) && /"id":\{"description":"[^"]*row/.test(jsonSchema), jsonSchema.slice(0, 600))

const answered = (label: string, noulP: number, pick: string, pickP: number, choiceConf: number, score: number, scoreConf: number, delayMs = 0) => ({
  status: 200,
  delayMs,
  body: {
    model: 'jev-1.13.0',
    answers: {
      killed: { type: 'noul', noul: noulP },
      class: { type: 'choice', choice: pick, probabilities: { harness: pick === 'harness' ? pickP : 1 - pickP - 0.02, product: pick === 'product' ? pickP : 1 - pickP - 0.02, none: 0.02 }, confidence: choiceConf },
      sev: { type: 'score', score, legend: { '0': 'cosmetic', '1': 'a re-true', '2': 'a user-visible defect' }, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: scoreConf },
    },
    usage: { input_tokens: 400, output_tokens: 30 },
  },
  label,
})

section('§2 parallel dispatch: n items → n requests in flight at once, one call')
standin.reset()
resetJevLedger()
for (let i = 0; i < 3; i++) standin.next(answered('slow', 0.9, 'harness', 0.8, 0.7, 0.5, 0.7, 700))
const started = Date.now()
const pending = jevEvalCall(call())
await sleep(250)
const inFlight = standin.received.length
check('all three requests reached the stand-in before any answered (in flight together)', inFlight === 3, `${inFlight} received after 250ms`)
const result = await pending
const wall = Date.now() - started
check('the call took about one answer delay, not three (parallel, not sequential)', wall < 1500, `${wall}ms`)
const states = [0, 1, 2].map(stateOf).map(s => JSON.stringify(s))
check('each request carries one item as its state: the facts without the id; a paragraph as the one fact `text`', states.includes(JSON.stringify({ tail: 'rc 137 — killed by the runner after the deadline' })) && states.includes(JSON.stringify({ text: items[1] })) && states.includes(JSON.stringify({ tail: 'capture deadline exceeded; the last frame is empty', rc: '1' })), states.join(' / '))
check('no state carries the row id', !states.some(s => s.includes('"id"')))
check('every request carries the same question set', new Set([0, 1, 2].map(questionsOf).map(q => JSON.stringify(q))).size === 1 && JSON.stringify(Object.keys(questionsOf(0) as object)) === JSON.stringify(['killed', 'class', 'sev']))
check('the ledger counted three attempts and three settled calls — every request counts', jevLedgerSnapshot().attempts === 3 && jevLedgerSnapshot().calls === 3 && jevLedgerSnapshot().attemptsThisMinute === 3, JSON.stringify(jevLedgerSnapshot()))
check('the input tokens are the three requests summed', jevLedgerSnapshot().inputTokens === 1200, String(jevLedgerSnapshot().inputTokens))
check('the result of the parallel call is one three-row table', result.status === 'ok' && result.text.split('\n').filter(line => /^(ui|#2|api) \| /.test(line)).length === 3, result.text)

section('§3 the result is ONE table: rows = the items, columns = the question ids, cells = the typed answers')
standin.reset()
resetJevLedger()
const scripts = [answered('ui', 0.93, 'harness', 0.81, 0.77, 0.4, 0.71), answered('#2', 0.12, 'product', 0.7, 0.66, 1.62, 0.7), answered('api', 0.5, 'harness', 0.58, 0.4, 1.9, 0.9)]
for (const script of scripts) standin.next(script)
const table = await jevEvalCall(call())
const lines = table.text.split('\n')
console.log(table.text.split('\n').map(l => `    ${l}`).join('\n'))
check('status ok', table.status === 'ok', table.text)
check('the header: model, the item and question counts, the tokens summed, the charge summed, ok', lines[0] === 'JEV jev-1.13.0 | 3 items × 3 questions | in 1200 tok | $0.00005 | ok', lines[0])
check('the column row: item, then every question id with its kind', lines[1] === 'item | killed (noul) | class (choice) | sev (score)', lines[1])
const rowOf = (label: string): string | undefined => lines.find(line => line.startsWith(`${label} | `))
const rowsAnswered = ['ui', '#2', 'api'].map(rowOf)
check('three rows keyed by the id or the position (#2 for the paragraph), in the list order', lines[2]?.startsWith('ui | ') === true && lines[3]?.startsWith('#2 | ') === true && lines[4]?.startsWith('api | ') === true, lines.slice(2, 5).join(' // '))
check('every answered row has a noul probability, a choice pick with its probability and confidence, and a score with its confidence', rowsAnswered.every(row => row !== undefined && /\| \.\d\d \|/.test(row) && /\| (harness|product) \.\d\d conf \.\d\d \|/.test(row) && /\| \d\.\d+ of 0\.\.2 conf \.\d\d$/.test(row)), rowsAnswered.join(' // '))
check('the score levels are named once, after the table, not in every cell', lines.filter(line => /^sev levels: 0=cosmetic 1=a re-true 2=a user-visible defect$/.test(line)).length === 1 && !rowsAnswered.some(row => row?.includes('cosmetic')), lines.slice(5).join(' // '))
check('the answers are the stand-in\'s numbers, verbatim', lines.some(line => line.startsWith('ui | .93 | harness .81 conf .77 | 0.4 of 0..2 conf .71')) && lines.some(line => line.startsWith('#2 | .12 | product .70 conf .66 | 1.62 of 0..2 conf .70')), lines.slice(2, 5).join(' // '))
check('no rationale, no band, no words attributed to Jev', !/because|rationale|reason|Jev (says|thinks|recommends)|band/i.test(table.text))
check('the tool_result block is the text itself', JevEvalTool.mapToolResultToToolResultBlockParam(table, 'tu_1').content === table.text)
const one = await jevEvalCall(call([items[0]!]))
const oneLines = one.text.split('\n')
check('a single item is a one-row table with the same header and column row', one.status === 'ok' && /^JEV jev-1\.13\.0 \| 1 item × 3 questions \| in \d+ tok \| \$[\d.]+ \| ok/.test(oneLines[0]!) && oneLines[1] === 'item | killed (noul) | class (choice) | sev (score)' && oneLines[2]?.startsWith('ui | ') === true && oneLines.filter(line => line.includes(' | ')).length === 3, one.text)

section('§4 per-row unavailability sits in the row; the table stands; a held road is said once, with the notice once')
standin.reset()
resetJevLedger()
standin.next({ status: 503, raw: 'Service Unavailable' })
const mixed = await jevEvalCall(call())
const mixedLines = mixed.text.split('\n')
console.log(mixed.text.split('\n').map(l => `    ${l}`).join('\n'))
const failedRows = mixedLines.filter(line => / \| unavailable — provider-down — HTTP 503: Service Unavailable$/.test(line))
const answeredRows = mixedLines.filter(line => /^(ui|#2|api) \| \.\d\d \| /.test(line))
check('status ok: two rows answered', mixed.status === 'ok', mixed.status)
check('the header counts the answered rows', /\| ok 2 of 3$/.test(mixedLines[0]!), mixedLines[0])
check('exactly one row reads unavailable with the wire\'s own evidence; the other two carry their answers', failedRows.length === 1 && answeredRows.length === 2 && ['ui', '#2', 'api'].every(label => mixedLines.some(line => line.startsWith(`${label} | `))), mixed.text)
const trailer = mixedLines.find(line => line.startsWith('JEV — | status=provider-down | '))
check('the road\'s hold is said once, after the table, in the resolver\'s words', trailer !== undefined && /provider down — 503 "Service Unavailable" at \d\d:\d\d; the next attempt is admitted in (\d+m( \d+s)?|\d+s)$/.test(trailer) && mixedLines.filter(line => line.startsWith('JEV — |')).length === 1, trailer)
check('the notice rides that first result, once', /\nnotice: the next attempt is admitted in (\d+m( \d+s)?|\d+s); do not retry before then$/.test(mixed.text) && mixed.text.split('notice:').length === 2)
check('the ledger: three attempts, two settled calls, one refusal streak (a batch is one event for the cool-down)', jevLedgerSnapshot().attempts === 3 && jevLedgerSnapshot().calls === 2 && jevLedgerSnapshot().refusals === 1 && jevLedgerSnapshot().holdUntil > Date.now(), JSON.stringify(jevLedgerSnapshot()))
const held = await jevEvalCall(call())
check('while the road is held the next batch is not sent: the single unavailable line, no notice again', held.status === 'provider-down' && held.text.split('\n').length === 1 && held.text.startsWith('JEV — | status=provider-down | provider down') && standin.received.length === 3, held.text)

section('§5 a reason that ends Jev for the session still ends it: said once, the answered rows kept')
resetJevLedger()
standin.reset()
standin.next({ status: 402, body: { error: { message: 'Insufficient credits on this account' } } })
const credit = await jevEvalCall(call())
const creditLines = credit.text.split('\n')
check('two rows answered, one row unavailable with the wire\'s own refusal', credit.status === 'ok' && creditLines.filter(line => / \| unavailable — provider-refused — HTTP 402: Insufficient credits on this account$/.test(line)).length === 1 && creditLines.filter(line => /^(ui|#2|api) \| \.\d\d \| /.test(line)).length === 2, credit.text)
check('the session-ending reason is said once with the final notice', creditLines.filter(line => line.startsWith('JEV — | status=provider-credit | provider refused for credit')).length === 1 && /\nnotice: no further call will succeed this session for this reason; do not retry; carry on unaided$/.test(credit.text), credit.text)
const after = await jevEvalCall(call())
check('the next call is refused locally with nothing sent', after.status === 'provider-credit' && standin.received.length === 3 && after.text.split('\n').length === 1, after.text)
resetJevLedger()
standin.reset()
for (let i = 0; i < 3; i++) standin.next({ status: 503, raw: 'Service Unavailable' })
const allDown = await jevEvalCall(call())
check('when no row answers the result is the one status line with the count, then the notice', allDown.status === 'provider-down' && /^JEV — \| status=provider-down \| provider down — 503 "Service Unavailable" at \d\d:\d\d; the next attempt is admitted in (\d+m( \d+s)?|\d+s) \| HTTP 503: Service Unavailable \| 0 of 3 items answered\nnotice: /.test(allDown.text), allDown.text)
check('three attempts, no settled call, one refusal streak', jevLedgerSnapshot().attempts === 3 && jevLedgerSnapshot().calls === 0 && jevLedgerSnapshot().refusals === 1)

section('§6 the pace and the sub-agent budget count every request: the rows past the limit are not sent, and say so')
resetJevLedger()
standin.reset()
setJevPacePerMinute(2)
const paced = await jevEvalCall(call())
const pacedLines = paced.text.split('\n')
const notSent = pacedLines.filter(line => / \| not sent — pace hit — 2 requests in the last minute is the pace set in \/jev \(2 a minute\); the next is admitted in (\d+m( \d+s)?|\d+s)$/.test(line))
check('with a pace of 2, two items are sent and the third row reads not sent with the pace words', paced.status === 'ok' && standin.received.length === 2 && notSent.length === 1 && notSent[0]!.startsWith('api | ') && /\| ok 2 of 3$/.test(pacedLines[0]!), paced.text)
check('the pace hold is said once after the table, with its notice', pacedLines.filter(line => line.startsWith('JEV — | status=pace-hit | pace hit')).length === 1 && /notice: the next attempt is admitted in/.test(paced.text), paced.text)
check('the ledger counted exactly the two sent requests', jevLedgerSnapshot().attempts === 2 && jevLedgerSnapshot().calls === 2)
setJevPacePerMinute(100)
resetJevLedger()
standin.reset()
const subagent = { agentType: 'subagent' as const, agentId: 'batch-agent' }
for (let i = 0; i < JEV_SUBAGENT_CALL_BUDGET - 1; i++) noteJevAttempt(Date.now() - 120_000 + i, subagent.agentId)
const capped = await runWithAgentContext(subagent, () => jevEvalCall(call()))
const cappedLines = capped.text.split('\n')
check('a sub-agent with one call left: one item sent, two rows not sent under the budget words, the table stands', capped.status === 'ok' && standin.received.length === 1 && cappedLines.filter(line => / \| not sent — sub-agent budget hit — this agent has used its 200 JEV calls; carry on unaided$/.test(line)).length === 2 && /\| ok 1 of 3$/.test(cappedLines[0]!), capped.text)
check('the budget end is said once with the final notice', cappedLines.filter(line => line.startsWith('JEV — | status=subagent-budget-hit | ')).length === 1 && /\nnotice: no further call will succeed this session for this reason; do not retry; carry on unaided$/.test(capped.text), capped.text)
check('the ledger: the agent stands at its 200', jevLedgerSnapshot().subagentAttempts[subagent.agentId] === JEV_SUBAGENT_CALL_BUDGET)

section('§7 the size pre-flight names the item and the question; nothing is sent; an abort counts every request in flight')
resetJevLedger()
standin.reset()
const big = await JevEvalTool.call(call([items[0]!, { id: 'huge', excerpt: 'x'.repeat(140_000) }], [noul('q', 'Is it?')]) as never, context)
check('an oversized item is refused before any network, naming evidence[1] (huge) and the question', big.data.status === 'refused' && /evidence\[1\] \(huge\)/.test(big.data.text) && /question "q"/.test(big.data.text) && /32000/.test(big.data.text) && standin.received.length === 0 && jevLedgerSnapshot().attempts === 0, big.data.text)
const many = await JevEvalTool.call(call([items[0]!, { id: 'wide', excerpt: 'x'.repeat(60_000) }], Array.from({ length: 9 }, (_, i) => noul(`q${i}`, 'z'.repeat(24_000)))) as never, context)
check('an item plus all the questions over the request limit is refused naming evidence[1] (wide), the count and the longest', many.data.status === 'refused' && /evidence\[1\] \(wide\) plus all 9 questions/.test(many.data.text) && /64000/.test(many.data.text) && /"q0"/.test(many.data.text) && standin.received.length === 0, many.data.text)
standin.next({ status: 200, body: {}, delayMs: 1500 })
standin.next({ status: 200, body: {}, delayMs: 1500 })
const controller = new AbortController()
const inflight = jevEvalCall(call([items[0]!, items[2]!]), controller.signal)
setTimeout(() => controller.abort(), 80)
const aborted = await inflight
check('an abort after send: status aborted, both charges unconfirmed and counted', aborted.status === 'aborted' && /status=aborted/.test(aborted.text) && /2 of 2 requests/.test(aborted.text) && jevLedgerSnapshot().unconfirmedCharges === 2 && jevLedgerSnapshot().attempts === 2, aborted.text)

section('§8 the description says the shape')
check('the prompt names the list, the one question set, one request per item at once, and one table back', /list of evidence items/.test(JEV_EVAL_PROMPT) && /one question set/.test(JEV_EVAL_PROMPT) && /one request per item/.test(JEV_EVAL_PROMPT) && /one table/.test(JEV_EVAL_PROMPT), JEV_EVAL_PROMPT.slice(0, 200))
check('the prompt shows the paragraph-list form with a literal example keyed by position', /"evidence": \["[^"]+", "[^"]+"\]/.test(JEV_EVAL_PROMPT) && /#1/.test(JEV_EVAL_PROMPT))

await standin.close()
resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
