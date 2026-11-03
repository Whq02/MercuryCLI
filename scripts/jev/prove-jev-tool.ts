#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-tool-home-')))
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

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0002'
const ROOT = join(import.meta.dir, '..', '..')

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { startJevStandin } = await import('./lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setJevEnabled } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { resetJevLedger, jevLedgerSnapshot } = await import('../../src/services/jev/jevLedger.ts')
const { JEV_MAX_CHOICE_OPTIONS, JEV_MAX_SCORE_LEVELS, JEV_MIN_SCORE_LEVELS, JEV_STATUS_KINDS, JEV_TOOL_NAME } = await import('../../src/services/jev/jevContract.ts')
const { JEV_STATUS_HEADWORDS } = await import('../../src/services/jev/jevStatus.ts')
const { validateToolCapability } = await import('../../src/utils/capability/contract.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { JevEvalTool, jevEvalCall, jevEvalEnabled } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_ESCAPE_MEANS, JEV_EVAL_ESCAPE_OPTION, JEV_EVAL_FORBIDDEN_FIELDS } = await import('../../src/tools/JevEvalTool/constants.ts')
const { assembleJevEvalRequest, jevEvalTokenEstimate } = await import('../../src/tools/JevEvalTool/jevEvalRequest.ts')
const { jevEvalCell, jevEvalProbability } = await import('../../src/tools/JevEvalTool/jevEvalResult.ts')
const { JEV_EVAL_DESCRIPTION, JEV_EVAL_PROMPT, JEV_EVAL_SEARCH_HINT } = await import('../../src/tools/JevEvalTool/prompt.ts')

setJevEnabled(true)
storeJevApiKey(PROOF_KEY)
resetJevLedger()

const schema = JevEvalTool.inputSchema
const parse = (input: unknown) => schema.safeParse(input)
const messages = (input: unknown): string => {
  const r = parse(input)
  return r.success ? 'ok' : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' | ')
}
const noul = (id: string, ask = `Is \`fact\` enough on its own?`) => ({ id, kind: 'noul' as const, ask })
const choice = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'choice' as const, ask: 'Which one?', options: { a: 'the first', b: 'the second' }, allow_none: true, ...extra })
const score = (id: string, levels: string[] = ['low', 'mid', 'high']) => ({ id, kind: 'score' as const, ask: 'How much?', levels })
const valid = (questions: unknown[] = [noul('q')], evidence: Record<string, string> = { fact: 'the lease released early on 3 of 40 runs' }) => ({ goal: 'a bounded decision', evidence: [evidence], questions })
const labels = (n: number): Record<string, null> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`opt${i}`, null]))

section('§1 the tool is what the contract says')
check('the name is JevEval, the owner\'s name in house spelling', JevEvalTool.name === 'JevEval' && JevEvalTool.name === JEV_TOOL_NAME)
check('enabled with the switch on and a key stored', jevEvalEnabled() === true && JevEvalTool.isEnabled() === true)
check('read-only and concurrency-safe', JevEvalTool.isReadOnly({} as never) === true && JevEvalTool.isConcurrencySafe({} as never) === true)
check('deferred, announced with its line (the model sees it at the fork by name and purpose)', JevEvalTool.shouldDefer === true)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const permissionVerdict = await JevEvalTool.checkPermissions(valid() as never, { getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) } as never)
const toolSource = readFileSync(join(ROOT, 'src/tools/JevEvalTool/JevEvalTool.ts'), 'utf8')
check('an inline call is allowed without a permission check; JevEval answers no permission request — its only permission call is the Read ladder on a file it loads', permissionVerdict.behavior === 'allow' && /checkReadPermissionForTool/.test(toolSource) && !/validateInput|readOnlyAllowlist/.test(toolSource))
check('the search hint is 3..10 words', JEV_EVAL_SEARCH_HINT.trim().split(/\s+/).length >= 3 && JEV_EVAL_SEARCH_HINT.trim().split(/\s+/).length <= 10, JEV_EVAL_SEARCH_HINT)
check('the capability declaration is valid and names its condition and proof', validateToolCapability(JevEvalTool.capability).ok && (JevEvalTool.capability?.conditions?.length ?? 0) > 0 && JevEvalTool.capability?.proof === 'scripts/jev/run-all.sh')
check('it reaches beyond the machine and says so', JevEvalTool.isOpenWorld?.() === true)
check('a new user message cancels it', JevEvalTool.interruptBehavior?.() === 'cancel')

section('§2 schema refusals: the shape makes an out-of-scope request unrepresentable')
check('a valid input parses', parse(valid([noul('a'), choice('b'), score('c')])).success, messages(valid([noul('a'), choice('b'), score('c')])))
check('no ask', !parse(valid([{ id: 'q', kind: 'noul' }])).success && /ask/.test(messages(valid([{ id: 'q', kind: 'noul' }]))))
check('an empty ask', !parse(valid([noul('q', '')])).success)
check('choice without options', !parse(valid([{ id: 'q', kind: 'choice', ask: 'x', allow_none: false }])).success && /needs options/.test(messages(valid([{ id: 'q', kind: 'choice', ask: 'x', allow_none: false }]))))
check('choice without allow_none', !parse(valid([{ id: 'q', kind: 'choice', ask: 'x', options: { a: null, b: null } }])).success && /allow_none/.test(messages(valid([{ id: 'q', kind: 'choice', ask: 'x', options: { a: null, b: null } }]))))
check('the refusal names the question', /question "q"/.test(messages(valid([{ id: 'q', kind: 'choice', ask: 'x', options: { a: null, b: null } }]))))
check('1 level', !parse(valid([score('q', ['only'])])).success && JEV_MIN_SCORE_LEVELS === 2)
check('11 levels', !parse(valid([score('q', Array.from({ length: 11 }, (_, i) => `level ${i}`))])).success && JEV_MAX_SCORE_LEVELS === 10)
check('2 and 10 levels parse', parse(valid([score('q', ['a', 'b'])])).success && parse(valid([score('q', Array.from({ length: 10 }, (_, i) => `level ${i}`))])).success)
check('indistinct levels', !parse(valid([score('q', ['same', 'same', 'other'])])).success && /distinct/.test(messages(valid([score('q', ['same', 'same', 'other'])]))))
check('256 options', !parse(valid([choice('q', { options: labels(256), allow_none: false })])).success && /256 outcomes/.test(messages(valid([choice('q', { options: labels(256), allow_none: false })]))) && JEV_MAX_CHOICE_OPTIONS === 255)
check('255 options plus the escape is 256: refused', !parse(valid([choice('q', { options: labels(255), allow_none: true })])).success)
check('255 options without the escape parses', parse(valid([choice('q', { options: labels(255), allow_none: false })])).success)
check('one option needs the escape to be a choice', !parse(valid([choice('q', { options: { a: null }, allow_none: false })])).success && parse(valid([choice('q', { options: { a: null }, allow_none: true })])).success)
check('the escape label is reserved', !parse(valid([choice('q', { options: { a: null, [JEV_EVAL_ESCAPE_OPTION]: null } })])).success && /reserved/.test(messages(valid([choice('q', { options: { a: null, [JEV_EVAL_ESCAPE_OPTION]: null } })]))))
check('none_means without allow_none', !parse(valid([choice('q', { allow_none: false, none_means: 'nothing fits' })])).success)
check('levels on a choice, options on a noul, none_means on a score', !parse(valid([choice('q', { levels: ['a', 'b'] })])).success && !parse(valid([{ ...noul('q'), options: { a: null } }])).success && !parse(valid([{ ...score('q'), none_means: 'x' }])).success)
check('unknown kind', !parse(valid([{ id: 'q', kind: 'advice', ask: 'what should I do?' }])).success && /kind/.test(messages(valid([{ id: 'q', kind: 'advice', ask: 'what should I do?' }]))))
check('duplicate ids', !parse(valid([noul('q'), noul('q')])).success && /twice/.test(messages(valid([noul('q'), noul('q')]))))
check('no questions', !parse(valid([])).success)
check('an evidence item without a named fact', !parse(valid([noul('q')], {})).success && /at least one named fact/.test(messages(valid([noul('q')], {}))))
check('an empty evidence list', !parse({ ...valid(), evidence: [] }).success)
check('an id with spaces', !parse(valid([noul('a question')])).success)
const forbiddenTop = JEV_EVAL_FORBIDDEN_FIELDS.filter(field => parse({ ...valid(), [field]: true }).success)
const forbiddenQuestion = JEV_EVAL_FORBIDDEN_FIELDS.filter(field => parse(valid([{ ...noul('q'), [field]: true }])).success)
check(`the forbidden field names (${JEV_EVAL_FORBIDDEN_FIELDS.join(', ')}) are refused at both levels`, forbiddenTop.length === 0 && forbiddenQuestion.length === 0, [...forbiddenTop, ...forbiddenQuestion].join(','))
const jsonSchema = zodToJsonSchema(schema as never)
const propertyNames: string[] = []
const walk = (node: unknown): void => {
  if (typeof node !== 'object' || node === null) return
  const o = node as Record<string, unknown>
  if (typeof o.properties === 'object' && o.properties !== null) propertyNames.push(...Object.keys(o.properties as Record<string, unknown>))
  for (const value of Object.values(o)) walk(value)
}
walk(jsonSchema)
check('the wire schema has no approve/allow/verdict/safe/gate/advice/explain property', !propertyNames.some(name => JEV_EVAL_FORBIDDEN_FIELDS.includes(name)), propertyNames.join(','))
check('the wire schema is closed at both levels', JSON.stringify(jsonSchema).split('"additionalProperties":false').length >= 3)
check('the wire schema carries the seven question fields, the evidence item id and the three top-level ones', ['goal', 'evidence', 'questions', 'id', 'kind', 'ask', 'options', 'levels', 'allow_none', 'none_means'].every(name => propertyNames.includes(name)))

section('§3 assembly: ask → instructions, options/levels → criteria, the escape option, the ids as keys')
const assembled = assembleJevEvalRequest(valid([noul('skew'), choice('next', { options: { pin: 'pin the clock', ser: 'serialise' }, allow_none: true, none_means: 'neither separates them' }), score('blast', ['One file', 'One module', 'Cross-cutting'])]) as never)
check('assembled', assembled.ok === true, assembled.ok ? '' : assembled.reason)
if (assembled.ok) {
  const { order } = assembled
  const { request, estimate } = assembled.items[0]!
  check('one item, one request; its state is the evidence, verbatim', assembled.items.length === 1 && JSON.stringify(request.state) === JSON.stringify({ fact: 'the lease released early on 3 of 40 runs' }))
  check('the ids are the questions keys, in order', JSON.stringify(Object.keys(request.questions)) === JSON.stringify(['skew', 'next', 'blast']) && JSON.stringify(order) === JSON.stringify(['skew', 'next', 'blast']))
  check('noul: ask → instructions, nothing else', JSON.stringify(request.questions.skew) === JSON.stringify({ type: 'noul', instructions: 'Is `fact` enough on its own?' }))
  check('choice: options → criteria plus the escape carrying none_means', JSON.stringify(request.questions.next) === JSON.stringify({ type: 'choice', instructions: 'Which one?', criteria: { pin: 'pin the clock', ser: 'serialise', none: 'neither separates them' } }))
  check('score: levels → the ordered criteria array', JSON.stringify(request.questions.blast) === JSON.stringify({ type: 'score', instructions: 'How much?', criteria: ['One file', 'One module', 'Cross-cutting'] }))
  check('no id, goal, kind or allow_none reaches the wire', !JSON.stringify(request).includes('"id"') && !JSON.stringify(request).includes('goal') && !JSON.stringify(request).includes('allow_none') && !JSON.stringify(request).includes('"kind"'))
  check('the estimate is bytes/4 of the evidence and of each question', estimate.stateTokens === Math.ceil(Buffer.byteLength(JSON.stringify(request.state)) / 4) && estimate.questionTokens.skew === jevEvalTokenEstimate(JSON.stringify(request.questions.skew)) && estimate.totalTokens === estimate.stateTokens + Object.values(estimate.questionTokens).reduce((a, b) => a + b, 0))
}
const noEscape = assembleJevEvalRequest(valid([choice('c', { allow_none: false })]) as never)
check('allow_none false appends no escape', noEscape.ok && !('none' in (noEscape.questions.c as { criteria: Record<string, unknown> }).criteria))
const defaultEscape = assembleJevEvalRequest(valid([choice('c', { allow_none: true })]) as never)
check('allow_none true without none_means uses the default escape words', defaultEscape.ok && (defaultEscape.questions.c as { criteria: Record<string, unknown> }).criteria.none === JEV_EVAL_ESCAPE_MEANS)

section('§4 the size pre-flight refuses before any network, naming the question')
const context = { abortController: new AbortController() } as never
standin.reset()
const bigEvidence = { excerpt: 'x'.repeat(100_000) }
const longAsk = 'y'.repeat(30_000)
const tooLong = await JevEvalTool.call(valid([noul('short'), noul('long', longAsk)], bigEvidence) as never, context)
check('evidence plus the longest question over 32k: refused, naming that question', tooLong.data.status === 'refused' && /question "long"/.test(tooLong.data.text) && /32000/.test(tooLong.data.text) && /publishes no tokenizer/.test(tooLong.data.text), tooLong.data.text)
const mid = { excerpt: 'x'.repeat(60_000) }
const nine = Array.from({ length: 9 }, (_, i) => noul(`q${i}`, 'z'.repeat(24_000)))
const tooMany = await JevEvalTool.call(valid(nine, mid) as never, context)
check('evidence plus all questions over 64k: refused, naming the count and the longest', tooMany.data.status === 'refused' && /all 9 questions/.test(tooMany.data.text) && /64000/.test(tooMany.data.text) && /"q0"/.test(tooMany.data.text), tooMany.data.text)
check('nothing was sent and nothing was counted', standin.received.length === 0 && jevLedgerSnapshot().attempts === 0)
check('the refusal is a typed status line', tooLong.data.text.startsWith('JEV — | status=refused | '))
const fits = await JevEvalTool.call(valid([noul('q')], { fact: 'small' }) as never, context)
check('a request that fits is sent', fits.data.status === 'ok' && standin.received.length === 1, fits.data.text)

section('§5 rendering: each answer type from the stand-in, confidence verbatim, no rationale slot')
standin.reset()
resetJevLedger()
standin.next({
  status: 200,
  body: {
    model: 'jev-1.13.0',
    answers: {
      skew: { type: 'noul', noul: 0.88 },
      next_test: { type: 'choice', choice: 'pin_clock', probabilities: { pin_clock: 0.48, serialise: 0.31, log_ordering: 0.17, none: 0.04 }, confidence: 0.41 },
      blast: { type: 'score', score: 0.88, legend: { '0': 'One file', '1': 'One module', '2': 'Cross-cutting' }, probabilities: { '0': 0.22, '1': 0.68, '2': 0.1 }, confidence: 0.77 },
    },
    usage: { input_tokens: 412, output_tokens: 20 },
  },
})
const rendered = await jevEvalCall(
  valid([noul('skew'), choice('next_test', { options: { pin_clock: 'pin', serialise: 'ser', log_ordering: 'log' }, allow_none: true }), score('blast', ['One file', 'One module', 'Cross-cutting'])]) as never,
)
const lines = rendered.text.split('\n')
check('status ok', rendered.status === 'ok', rendered.text)
check('the header: model, one item by three questions, input tokens, the charge at the published rate, ok', lines[0] === 'JEV jev-1.13.0 | 1 item × 3 questions | in 412 tok | $0.000017 | floor 0.6 | ok', lines[0])
check('the column row: item, then each question id with its kind', lines[1] === 'item | skew (noul) | next_test (choice) | blast (score)', lines[1])
check('the one row, keyed #1 (no id given): noul p(yes); the choice under the floor reads unsure with its probability and conf; the score of 0..k-1 with conf', lines[2] === '#1 | .88 | unsure · pin_clock .48 conf .41 | 0.88 of 0..2 conf .77', lines[2])
check('the score levels named once under the table', lines[3] === 'blast levels: 0=One file 1=One module 2=Cross-cutting', lines[3])
check('four lines, nothing else', lines.length === 4)
check('no rationale, no band, no words attributed to Jev', !/because|rationale|reason|Jev (says|thinks|recommends)|band/i.test(rendered.text))
check('the ledger settled the charge from the returned tokens', jevLedgerSnapshot().calls === 1 && jevLedgerSnapshot().inputTokens === 412 && jevLedgerSnapshot().lastModel === 'jev-1.13.0')
check('the result carries no approve/allow/verdict/safe/gate', !/\b(approve|allow|verdict|safe|gate)\b/i.test(rendered.text))
check('the tool_result block is the text itself', JevEvalTool.mapToolResultToToolResultBlockParam(rendered, 'tu_1').content === rendered.text)
check('numbers: two decimals without the leading zero; one and zero spelled', jevEvalProbability(0.88) === '.88' && jevEvalProbability(1) === '1.00' && jevEvalProbability(0) === '.00' && jevEvalProbability(0.5) === '.50')

section('§6 the cells: a noul is its probability; a choice is the pick, its own probability and conf; a score is its position and conf')
check('noul', jevEvalCell({ type: 'noul', noul: 0.07 }) === '.07')
check('choice: the pick\'s own probability, not the top of the distribution', jevEvalCell({ type: 'choice', choice: 'b', probabilities: { a: 0.5, b: 0.3, c: 0.2 }, confidence: 0.7 }) === 'b .30 conf .70')
check('score: the position on 0..k-1 with the levels counted from the legend', jevEvalCell({ type: 'score', score: 2.5, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd' }, probabilities: { '0': 0, '1': 0.25, '2': 0.25, '3': 0.5 }, confidence: 0.9 }) === '2.5 of 0..3 conf .90')

section('§7 the prompt: what Jev answers and what comes back, each fact once; no when-to-use, no worked example, no other tool, no pre-empted refusal')
const prompt = JEV_EVAL_PROMPT
const firstLine = prompt.split('\n')[0]!
check('the first paragraph says what it is: one paid round trip for a second opinion on a judgement you have framed', /^One paid round trip to TypeSafe's Jev for a second opinion on a judgement you have framed\./.test(firstLine))
check('…what Jev reads and answers: only the evidence, numbers per typed question', /Jev reads only the `evidence` you supply and answers each typed question with numbers/.test(firstLine))
check('…the three kinds in one sentence each: noul a probability, choice an option with a probability per option and a confidence, score a position with a confidence', /`noul` the probability, 0\.\.1, that a yes\/no statement holds; `choice` one of your options, with a probability per option and a confidence; `score` a position on your ordered levels, with a confidence/.test(firstLine))
check('…what the numbers are: an opinion, 0 and 1 prove nothing, confidence is concentration not accuracy, no reasons', /writes no prose and gives no reasons/.test(firstLine) && /0 and 1 prove nothing/.test(firstLine) && /how concentrated the distribution is, not how often Jev is right/.test(firstLine))
check('the second paragraph says what comes back: one table, a row per item keyed by id or position, a column per question, a missing answer said in place', /One table comes back: a row per evidence item, keyed by its id or by position, a column per question, and a row that no answer reached says so in place\./.test(prompt))
check('two paragraphs, under 1,100 bytes', prompt.split('\n\n').length === 2 && Buffer.byteLength(prompt, 'utf8') <= 1100, `${prompt.split('\n\n').length} paragraphs, ${Buffer.byteLength(prompt, 'utf8')} bytes`)
const gone: Array<[string, RegExp]> = [
  ['another tool named (Eval)', /\bEval\b/],
  ['a when-to-use clause', /[Uu]se it whenever|decides the next step/],
  ['a worked example or a shape that worked', /killed from outside|capture starve|fixture fault|coin flip|fold_intent|reads back as|"goal":/],
  ['a rule written as a rule', /[Nn]ever call it|[Dd]o not re-ask|[Dd]o not act on it|never attribute|Never retry/],
  ['the crewmate budget and pace (limits speak at call time)', /200 calls|50 requests a minute/],
  ['the unavailability paragraph (the result names the reason and the next admission)', /end Jev for this session|next attempt is admitted|unavailable result/],
  ['the one-call rule', /in ONE call|re-sends the evidence/],
  ['"use them only if needed"', /only if needed/i],
  ['"do not call it as a ritual"', /ritual/i],
  ['sparingly', /sparing/i],
  ['budget as restraint ("hold back")', /hold back/i],
]
for (const [label, rx] of gone) check(`gone: ${label}`, !rx.test(prompt), (prompt.match(rx) ?? [''])[0])
check('"an option you omit cannot be chosen" is the options field\'s alone, not said again in the prompt', JSON.stringify(jsonSchema).includes('an option you omit cannot be chosen') && !prompt.includes('an option you omit cannot be chosen'))
check('the privacy effect is the evidence record\'s alone, once: everything sent leaves the machine under the selected road\'s data policy', JSON.stringify(jsonSchema).split("leaves the machine under the selected road's data policy").length === 2 && !prompt.includes('leaves the machine'))
check('the Fallback permission card prints JevEval\'s description() whole (one line, so truncateToLines keeps all of it): unchanged from .36', (await JevEvalTool.description()) === "A second opinion from TypeSafe's Jev: typed yes/no, choice and score questions over evidence you supply, answered with numbers only — never an approval, never a reason")
const headwords = JEV_STATUS_KINDS.filter(k => k !== 'ready').map(k => JEV_STATUS_HEADWORDS[k])
const headwordIn = (w: string): boolean => new RegExp(`\\b${w}\\b`).test(prompt)
check('no unavailability headword is pre-empted in the prompt (the result carries the reason and the wait, proven in prove-jev-honesty)', !headwords.some(headwordIn), headwords.filter(headwordIn).join(','))
check('no "experimental" anywhere the model reads', !/experimental/i.test(prompt + JEV_EVAL_DESCRIPTION + JEV_EVAL_SEARCH_HINT + JSON.stringify(jsonSchema)))
check('the short description is not Eval\'s and names numbers, never an approval', /numbers only/.test(JEV_EVAL_DESCRIPTION) && /never an approval/.test(JEV_EVAL_DESCRIPTION) && !/code cell/.test(JEV_EVAL_DESCRIPTION))
check('the prompt is what the wire carries', (await JevEvalTool.prompt({} as never)) === prompt && (await JevEvalTool.description()) === JEV_EVAL_DESCRIPTION)
console.log(`  prompt: ${Buffer.byteLength(prompt, 'utf8')} bytes; schema: ${Buffer.byteLength(JSON.stringify(jsonSchema), 'utf8')} bytes`)

await standin.close()
resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
