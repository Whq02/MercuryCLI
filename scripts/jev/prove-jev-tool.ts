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
const { isToolDefaultFn } = await import('../../src/Tool.ts')
const { validateToolCapability } = await import('../../src/utils/capability/contract.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { JevEvalTool, jevEvalCall, jevEvalEnabled } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_ESCAPE_MEANS, JEV_EVAL_ESCAPE_OPTION, JEV_EVAL_FORBIDDEN_FIELDS } = await import('../../src/tools/JevEvalTool/constants.ts')
const { assembleJevEvalRequest, jevEvalTokenEstimate } = await import('../../src/tools/JevEvalTool/jevEvalRequest.ts')
const { jevEvalChoiceDistribution, jevEvalProbability } = await import('../../src/tools/JevEvalTool/jevEvalResult.ts')
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
const valid = (questions: unknown[] = [noul('q')], evidence: Record<string, string> = { fact: 'the lease released early on 3 of 40 runs' }) => ({ goal: 'a bounded decision', evidence, questions })
const labels = (n: number): Record<string, null> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`opt${i}`, null]))

section('§1 the tool is what the contract says')
check('the name is JevEval, the owner\'s name in house spelling', JevEvalTool.name === 'JevEval' && JevEvalTool.name === JEV_TOOL_NAME)
check('enabled with the switch on and a key stored', jevEvalEnabled() === true && JevEvalTool.isEnabled() === true)
check('read-only and concurrency-safe', JevEvalTool.isReadOnly({} as never) === true && JevEvalTool.isConcurrencySafe({} as never) === true)
check('not deferred (a tool the model cannot see is not reached for at the fork)', JevEvalTool.shouldDefer === false)
const permissionVerdict = await JevEvalTool.checkPermissions({ goal: 'g' } as never, {} as never)
check('checkPermissions is the default allow — it never joins the permission plane', permissionVerdict.behavior === 'allow' && !/checkPermissions|validateInput/.test(readFileSync(join(ROOT, 'src/tools/JevEvalTool/JevEvalTool.ts'), 'utf8')))
check('the classifier projection is declared deliberately, and empty', !isToolDefaultFn(JevEvalTool.toAutoClassifierInput) && JevEvalTool.toAutoClassifierInput({} as never) === '')
check('the auto-mode classifier allowlist never names it', !/jev/i.test(readFileSync(join(ROOT, 'src/utils/permissions/classifierDecision.ts'), 'utf8')))
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
check('empty evidence', !parse(valid([noul('q')], {})).success && /at least one named fact/.test(messages(valid([noul('q')], {}))))
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
check('the wire schema carries the seven question fields and the three top-level ones', ['goal', 'evidence', 'questions', 'id', 'kind', 'ask', 'options', 'levels', 'allow_none', 'none_means'].every(name => propertyNames.includes(name)))

section('§3 assembly: ask → instructions, options/levels → criteria, the escape option, the ids as keys')
const assembled = assembleJevEvalRequest(valid([noul('skew'), choice('next', { options: { pin: 'pin the clock', ser: 'serialise' }, allow_none: true, none_means: 'neither separates them' }), score('blast', ['One file', 'One module', 'Cross-cutting'])]) as never)
check('assembled', assembled.ok === true, assembled.ok ? '' : assembled.reason)
if (assembled.ok) {
  const { request, order, estimate } = assembled
  check('state is the evidence, verbatim', JSON.stringify(request.state) === JSON.stringify({ fact: 'the lease released early on 3 of 40 runs' }))
  check('the ids are the questions keys, in order', JSON.stringify(Object.keys(request.questions)) === JSON.stringify(['skew', 'next', 'blast']) && JSON.stringify(order) === JSON.stringify(['skew', 'next', 'blast']))
  check('noul: ask → instructions, nothing else', JSON.stringify(request.questions.skew) === JSON.stringify({ type: 'noul', instructions: 'Is `fact` enough on its own?' }))
  check('choice: options → criteria plus the escape carrying none_means', JSON.stringify(request.questions.next) === JSON.stringify({ type: 'choice', instructions: 'Which one?', criteria: { pin: 'pin the clock', ser: 'serialise', none: 'neither separates them' } }))
  check('score: levels → the ordered criteria array', JSON.stringify(request.questions.blast) === JSON.stringify({ type: 'score', instructions: 'How much?', criteria: ['One file', 'One module', 'Cross-cutting'] }))
  check('no id, goal, kind or allow_none reaches the wire', !JSON.stringify(request).includes('"id"') && !JSON.stringify(request).includes('goal') && !JSON.stringify(request).includes('allow_none') && !JSON.stringify(request).includes('"kind"'))
  check('the estimate is bytes/4 of the evidence and of each question', estimate.stateTokens === Math.ceil(Buffer.byteLength(JSON.stringify(request.state)) / 4) && estimate.questionTokens.skew === jevEvalTokenEstimate(JSON.stringify(request.questions.skew)) && estimate.totalTokens === estimate.stateTokens + Object.values(estimate.questionTokens).reduce((a, b) => a + b, 0))
}
const noEscape = assembleJevEvalRequest(valid([choice('c', { allow_none: false })]) as never)
check('allow_none false appends no escape', noEscape.ok && !('none' in (noEscape.request.questions.c as { criteria: Record<string, unknown> }).criteria))
const defaultEscape = assembleJevEvalRequest(valid([choice('c', { allow_none: true })]) as never)
check('allow_none true without none_means uses the default escape words', defaultEscape.ok && (defaultEscape.request.questions.c as { criteria: Record<string, unknown> }).criteria.none === JEV_EVAL_ESCAPE_MEANS)

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
check('the header: model, input tokens, the charge at the published rate, ok', lines[0] === 'JEV jev-1.13.0 | in 412 tok | $0.000017 | ok', lines[0])
check('noul: p(yes) and the note that it carries no confidence', lines[1] === 'skew noul p(yes) .88 (noul carries no confidence)', lines[1])
check('choice: the choice, conf verbatim, the full distribution when ≤ 6', lines[2] === 'next_test choice pin_clock conf .41 { pin_clock .48  serialise .31  log_ordering .17  none .04 }', lines[2])
check('score: the score of 0..k-1, conf verbatim, the distribution by index, the levels', lines[3] === 'blast score 0.88 of 0..2 conf .77 { 0 .22  1 .68  2 .10 } levels: 0=One file 1=One module 2=Cross-cutting', lines[3])
check('four lines, nothing else', lines.length === 4)
check('no rationale, no band, no words attributed to Jev', !/because|rationale|reason|Jev (says|thinks|recommends)|band/i.test(rendered.text))
check('the ledger settled the charge from the returned tokens', jevLedgerSnapshot().calls === 1 && jevLedgerSnapshot().inputTokens === 412 && jevLedgerSnapshot().lastModel === 'jev-1.13.0')
check('the result carries no approve/allow/verdict/safe/gate', !/\b(approve|allow|verdict|safe|gate)\b/i.test(rendered.text))
check('the tool_result block is the text itself', JevEvalTool.mapToolResultToToolResultBlockParam(rendered, 'tu_1').content === rendered.text)
check('numbers: two decimals without the leading zero; one and zero spelled', jevEvalProbability(0.88) === '.88' && jevEvalProbability(1) === '1.00' && jevEvalProbability(0) === '.00' && jevEvalProbability(0.5) === '.50')

section('§6 the trim rule: top six, never dropping an option within .05 of the top')
const tie = { a: 0.16, b: 0.15, c: 0.14, d: 0.13, e: 0.12, f: 0.11, g: 0.11, h: 0.05, i: 0.03 }
check('seven shown when the seventh is within .05 of the top, +2 more', jevEvalChoiceDistribution(tie) === '{ a .16  b .15  c .14  d .13  e .12  f .11  g .11  +2 more }', jevEvalChoiceDistribution(tie))
const spread = { a: 0.4, b: 0.2, c: 0.15, d: 0.1, e: 0.05, f: 0.04, g: 0.03, h: 0.02, i: 0.01 }
check('six shown otherwise, +3 more', jevEvalChoiceDistribution(spread) === '{ a .40  b .20  c .15  d .10  e .05  f .04  +3 more }', jevEvalChoiceDistribution(spread))
const six = { a: 0.3, b: 0.25, c: 0.2, d: 0.15, e: 0.07, f: 0.03 }
check('six or fewer: the whole distribution, no marker', jevEvalChoiceDistribution(six) === '{ a .30  b .25  c .20  d .15  e .07  f .03 }')
check('sorted by probability, highest first', jevEvalChoiceDistribution({ low: 0.1, high: 0.9 }) === '{ high .90  low .10 }')

section('§7 the prompt: the three first uses, the exclusions, the unavailability words, no "experimental", Eval kept apart')
const prompt = JEV_EVAL_PROMPT
const firstLine = prompt.split('\n')[0]!
check('the first line keeps Eval (code cells) and JevEval apart', /not the Eval tool/.test(firstLine) && /Eval runs code cells/.test(firstLine) && /JevEval runs no code/.test(firstLine))
check('use 1: rank hypotheses once the evidence is in, including which test separates them', /rank hypotheses once the evidence is in/.test(prompt) && /which test would separate them/.test(prompt))
check('use 2: a qualitative call after the frames are measured — code measures, Jev judges', /qualitative call after the frames or numbers are measured/.test(prompt) && /code measures, Jev judges/.test(prompt))
check('use 3: check a proposal against the owner\'s recorded rulings', /check a proposal against the owner's recorded rulings/.test(prompt))
const exclusions: Array<[string, RegExp]> = [
  ['not a ritual before every test', /ritual before every test/],
  ['no arithmetic, geometry, resizing, dates, counts', /arithmetic, geometry, resizing, dates, counts/],
  ['no facts already in context', /facts already in your context/],
  ['never a permission or a consent gate', /grant a permission or to satisfy a consent gate/],
  ['never proof of a green gate', /never as proof that tests pass, a build is green or a gate is met/],
  ['no re-asking a rephrased question', /re-ask a rephrased question/],
  ['report the answer even when it contradicts you', /even when it contradicts you/],
  ['one batched call', /in ONE call/],
  ['filtered evidence only and why', /filtered excerpts, never whole files, never the transcript/],
  ['why: it leaves the machine and is retained', /leaves the machine and is retained by the provider/],
  ['why: unrelated material costs accuracy', /unrelated material measurably costs accuracy/],
  ['every option in, allow_none set', /an option you omit cannot be chosen/],
  ['numbers are opinions, 0 and 1 prove nothing', /0 and 1 prove nothing/],
  ['confidence is concentration, noul has none', /how concentrated the distribution is/],
  ['never attribute a rationale', /never attribute a rationale to it/],
  ['the sub-agent budget', /A sub-agent has 2 calls/],
]
for (const [label, rx] of exclusions) check(label, rx.test(prompt))
const headwords = JEV_STATUS_KINDS.filter(k => k !== 'ready').map(k => JEV_STATUS_HEADWORDS[k])
check('the unavailability paragraph names every reason in the resolver\'s headwords', headwords.every(w => prompt.includes(w)), headwords.filter(w => !prompt.includes(w)).join(','))
check('final reasons end Jev for the session; waits name the next admission; never retry', /end Jev for this session/.test(prompt) && /name when the next attempt is admitted/.test(prompt) && /Never retry a refusal/.test(prompt))
check('no "experimental" anywhere the model reads', !/experimental/i.test(prompt + JEV_EVAL_DESCRIPTION + JEV_EVAL_SEARCH_HINT + JSON.stringify(jsonSchema)))
check('the short description is not Eval\'s and names numbers, never an approval', /numbers only/.test(JEV_EVAL_DESCRIPTION) && /never an approval/.test(JEV_EVAL_DESCRIPTION) && !/code cell/.test(JEV_EVAL_DESCRIPTION))
check('the prompt is what the wire carries', (await JevEvalTool.prompt({} as never)) === prompt && (await JevEvalTool.description()) === JEV_EVAL_DESCRIPTION)
console.log(`  prompt: ${Buffer.byteLength(prompt, 'utf8')} bytes; schema: ${Buffer.byteLength(JSON.stringify(jsonSchema), 'utf8')} bytes`)

await standin.close()
resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
