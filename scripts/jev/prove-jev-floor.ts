#!/usr/bin/env bun
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-floor-home-')))
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

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0007'

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { startJevStandin } = await import('./lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setJevEnabled } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { JEV_TOOL_NAME } = await import('../../src/services/jev/jevContract.ts')
const { formatZodValidationError } = await import('../../src/utils/toolErrors.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { JevEvalTool, jevEvalCall } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const constants = await import('../../src/tools/JevEvalTool/constants.ts')
const result = await import('../../src/tools/JevEvalTool/jevEvalResult.ts')
const { JEV_EVAL_PROMPT } = await import('../../src/tools/JevEvalTool/prompt.ts')

setJevEnabled(true)
storeJevApiKey(PROOF_KEY)
resetJevLedger()

const floor = (constants as Record<string, unknown>).JEV_EVAL_CONFIDENCE_FLOOR
const cell = (result as Record<string, unknown>).jevEvalCell as ((answer: unknown) => string) | undefined
const unsure = (result as Record<string, unknown>).jevEvalUnsure as ((answer: unknown, floor?: number) => boolean) | undefined
const schema = JevEvalTool.inputSchema
const refusal = (input: unknown): string => {
  const r = schema.safeParse(input)
  return r.success ? 'ok' : formatZodValidationError(JEV_TOOL_NAME, r.error, zodToJsonSchema(schema as never))
}

section('§1 the floor is one named constant, 0.6, and each kind reads it its own way')
check('JEV_EVAL_CONFIDENCE_FLOOR is 0.6', floor === 0.6, String(floor))
check('jevEvalUnsure and jevEvalCell are exported', typeof unsure === 'function' && typeof cell === 'function')
if (unsure !== undefined) {
  check('a choice at conf .41 is unsure; at .66 it is not; at exactly .6 it is not (the floor is inclusive)', unsure({ type: 'choice', choice: 'a', probabilities: { a: 0.5, b: 0.5 }, confidence: 0.41 }) === true && unsure({ type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.66 }) === false && unsure({ type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.6 }) === false)
  check('a score at conf .38 is unsure; at .9 it is not', unsure({ type: 'score', score: 1.2, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0.3, '1': 0.4, '2': 0.3 }, confidence: 0.38 }) === true && unsure({ type: 'score', score: 1.9, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0, '1': 0.1, '2': 0.9 }, confidence: 0.9 }) === false)
  check('a noul carries no confidence: p(yes) from .4 through .6 is unsure (the floor mirrored around a half); .9 and .1 are not; .52 is', unsure({ type: 'noul', noul: 0.52 }) === true && unsure({ type: 'noul', noul: 0.4 }) === true && unsure({ type: 'noul', noul: 0.6 }) === true && unsure({ type: 'noul', noul: 0.9 }) === false && unsure({ type: 'noul', noul: 0.1 }) === false && unsure({ type: 'noul', noul: 0.39 }) === false && unsure({ type: 'noul', noul: 0.61 }) === false)
  check('the floor is a parameter: at 0.8 the .66 choice is unsure', unsure({ type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.66 }, 0.8) === true)
}
if (cell !== undefined) {
  check('an unsure cell opens with the word unsure and keeps the numbers (an opinion is still reported honestly)', cell({ type: 'choice', choice: 'a', probabilities: { a: 0.45, b: 0.55 }, confidence: 0.41 }) === 'unsure · a .45 conf .41' && cell({ type: 'noul', noul: 0.52 }) === 'unsure · .52' && cell({ type: 'score', score: 1.2, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0.3, '1': 0.4, '2': 0.3 }, confidence: 0.38 }) === 'unsure · 1.2 of 0..2 conf .38', [cell({ type: 'choice', choice: 'a', probabilities: { a: 0.45, b: 0.55 }, confidence: 0.41 }), cell({ type: 'noul', noul: 0.52 })].join(' / '))
  check('a plain cell carries no unsure word', cell({ type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.66 }) === 'a .90 conf .66' && cell({ type: 'noul', noul: 0.9 }) === '.90')
}

section('§2 the rendered table: the header names the floor once; the unsure rows read so')
standin.reset()
resetJevLedger()
standin.next({
  status: 200,
  body: {
    model: 'jev-1.13.0',
    answers: {
      killed: { type: 'noul', noul: 0.52 },
      class: { type: 'choice', choice: 'harness', probabilities: { harness: 0.45, product: 0.53, none: 0.02 }, confidence: 0.41 },
      sev: { type: 'score', score: 1.9, legend: { '0': 'cosmetic', '1': 'a re-true', '2': 'a user-visible defect' }, probabilities: { '0': 0, '1': 0.1, '2': 0.9 }, confidence: 0.9 },
    },
    usage: { input_tokens: 400, output_tokens: 30 },
  },
})
const questions = [
  { id: 'killed', kind: 'noul' as const, ask: 'Does `tail` name a kill from outside?' },
  { id: 'class', kind: 'choice' as const, ask: 'Which class?', options: { harness: 'a kill', product: 'wrong words' }, allow_none: true },
  { id: 'sev', kind: 'score' as const, ask: 'How much does it matter?', levels: ['cosmetic', 'a re-true', 'a user-visible defect'] },
]
const rendered = await jevEvalCall({ goal: 'read one red', evidence: [{ id: 'ui', tail: 'rc 137' }], questions })
const lines = rendered.text.split('\n')
console.log(rendered.text.split('\n').map(l => `    ${l}`).join('\n'))
check('the header says the floor once', rendered.status === 'ok' && lines[0] === 'JEV jev-1.13.0 | 1 item × 3 questions | in 400 tok | $0.000017 | floor 0.6 | ok' && rendered.text.split('floor').length === 2, lines[0])
check('the row: the noul at .52 and the choice at conf .41 read unsure with their numbers; the score at .9 reads plain', lines[2] === 'ui | unsure · .52 | unsure · harness .45 conf .41 | 1.9 of 0..2 conf .90', lines[2])

section('§3 the description says exactly how the floor applies to each kind, and carries ONE literal example that parses')
const prompt = JEV_EVAL_PROMPT
check('the floor sentence: under the floor the cell reads unsure — do not act on it', /[Uu]nder the floor[^.]*reads unsure/.test(prompt) && /do not act on it/.test(prompt), prompt.slice(0, 120))
check('the choice and score rule: confidence under 0.6', /choice or a score whose confidence is under 0\.6/.test(prompt))
check('the noul rule: p\\(yes\\) from 0.4 through 0.6, the floor mirrored around a half', /noul carries no confidence[^.]*p\(yes\) from 0\.4 through 0\.6/.test(prompt) && /mirrored around a half/.test(prompt))
check('the numbers stay and the header names the floor', /numbers stay/.test(prompt) && /header names the floor/.test(prompt))
const examples = prompt.split('\n').filter(line => line.startsWith('{"goal":'))
check('exactly one complete example call, on its own line', examples.length === 1, String(examples.length))
let parsedExample: unknown
try {
  parsedExample = JSON.parse(examples[0] ?? '')
} catch {
  parsedExample = undefined
}
check('the example is JSON the schema accepts as a real call', parsedExample !== undefined && schema.safeParse(parsedExample).success, parsedExample === undefined ? 'not JSON' : refusal(parsedExample))
const example = parsedExample as { evidence?: unknown[]; questions?: Array<{ kind?: string; options?: unknown; allow_none?: unknown }> } | undefined
check('the example is real-shaped: two named-facts items with ids, a noul and a choice with allow_none, keys named in backticks', Array.isArray(example?.evidence) && example!.evidence!.length === 2 && example!.evidence!.every(item => typeof item === 'object' && item !== null && 'id' in item) && example?.questions?.some(q => q.kind === 'noul') === true && example?.questions?.some(q => q.kind === 'choice' && q.allow_none !== undefined) === true && /"ask":"[^"]*`[a-z_]+`/.test(examples[0]!), examples[0])
const reads = prompt.indexOf('reads back as')
check('the example says what its table reads back as', reads > -1 && /rows/.test(prompt.slice(reads, reads + 200)))

section('§4 a malformed call is refused naming the offending field, never a generic error')
const good = { goal: 'g', evidence: [{ id: 'ui', tail: 'rc 137' }], questions: [{ id: 'q', kind: 'noul', ask: 'Is it?' }] }
const cases: Array<[string, unknown, RegExp]> = [
  ['a question without an ask', { ...good, questions: [{ id: 'q', kind: 'noul' }] }, /`questions\[0\]\.ask`/],
  ['a question with an unknown kind', { ...good, questions: [{ id: 'q', kind: 'advice', ask: 'what?' }] }, /`questions\[0\]\.kind`/],
  ['a choice without allow_none', { ...good, questions: [{ id: 'q', kind: 'choice', ask: 'which?', options: { a: null, b: null } }] }, /`questions\[0\]\.allow_none`/],
  ['a choice without options', { ...good, questions: [{ id: 'q', kind: 'choice', ask: 'which?', allow_none: true }] }, /`questions\[0\]\.options`/],
  ['levels on a choice', { ...good, questions: [{ id: 'q', kind: 'choice', ask: 'which?', options: { a: null, b: null }, allow_none: false, levels: ['x', 'y'] }] }, /`questions\[0\]\.levels`/],
  ['a score with one level', { ...good, questions: [{ id: 'q', kind: 'score', ask: 'how?', levels: ['only'] }] }, /`questions\[0\]\.levels`/],
  ['two questions with one id', { ...good, questions: [good.questions[0], good.questions[0]] }, /`questions\[1\]\.id`/],
  ['an empty evidence list', { ...good, evidence: [] }, /`evidence`/],
  ['the old single-record evidence', { ...good, evidence: { tail: 'rc 137' } }, /`evidence`/],
  ['an evidence item of the wrong type', { ...good, evidence: [7] }, /`evidence\[0\]`/],
  ['a record with only an id', { ...good, evidence: [{ id: 'ui' }] }, /evidence\[0\]/],
  ['a duplicate evidence id', { ...good, evidence: [{ id: 'ui', a: 'x' }, { id: 'ui', b: 'y' }] }, /evidence\[1\]\.id/],
  ['an unexpected top-level field', { ...good, verdict: true }, /`verdict`/],
  ['a missing goal', { evidence: good.evidence, questions: good.questions }, /`goal`/],
]
for (const [label, input, rx] of cases) {
  const words = refusal(input)
  check(`${label}: refused naming the field`, words !== 'ok' && rx.test(words) && !/Invalid input$/m.test(words) && !/\[object Object\]|"code":/.test(words), words)
}
const context = { abortController: new AbortController() } as never
standin.reset()
resetJevLedger()
const big = await JevEvalTool.call({ ...good, evidence: [{ id: 'huge', excerpt: 'x'.repeat(140_000) }] } as never, context)
check('the size refusal names the item and the question, and sends nothing', big.data.status === 'refused' && /evidence\[0\] \(huge\)/.test(big.data.text) && /question "q"/.test(big.data.text) && standin.received.length === 0, big.data.text)

await standin.close()
resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
