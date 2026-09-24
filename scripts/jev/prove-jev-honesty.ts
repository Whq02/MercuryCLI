#!/usr/bin/env bun
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-honesty-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
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

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0003'

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { startJevStandin } = await import('./lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setJevAllowanceUsd, setJevEnabled, setJevPacePerMinute, setJevRequestCeiling, setJevSubagents } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { jevLedgerSnapshot, noteJevAttempt, resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { JEV_MAX_CALL_USD, JEV_STATUS_KINDS } = await import('../../src/services/jev/jevContract.ts')
const { JEV_STATUS_HEADWORDS, jevStatus } = await import('../../src/services/jev/jevStatus.ts')
const { runWithAgentContext } = await import('../../src/utils/agentContext.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { assembleToolPool, getAllBaseTools, getTools } = await import('../../src/tools.ts')
const { JevEvalTool, jevEvalCall, jevEvalEnabled } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_FORBIDDEN_FIELDS } = await import('../../src/tools/JevEvalTool/constants.ts')

const ctx = { ...getEmptyToolPermissionContext(), mode: 'default' } as never
const rosterNames = (): string[] => getTools(ctx).map(t => t.name)
const poolNames = (): string[] => assembleToolPool(ctx, []).map(t => t.name)
const input = {
  goal: 'weigh two explanations',
  evidence: { measured: '3/40 runs early by 1.78-1.83s; all on CI', code: 'clock source changed to wall time' },
  questions: [
    { id: 'skew', kind: 'noul' as const, ask: 'Is a wall-clock adjustment sufficient on its own to explain `measured` given `code`?' },
    { id: 'which', kind: 'choice' as const, ask: 'Which explanation does the evidence favour?', options: { skew: 'wall-clock adjustment', race: 'retry race' }, allow_none: true, none_means: 'the evidence favours neither' },
  ],
}
const subagent = { agentType: 'subagent' as const, agentId: 'agent-a1' }
const firstLines = new Map<string, string>()
const texts: string[] = []
const record = (result: { status: string; text: string }): string => {
  texts.push(result.text)
  const first = result.text.split('\n')[0]!
  if (!firstLines.has(result.status)) firstLines.set(result.status, first)
  return first
}
const headwordOf = (kind: string): string => JEV_STATUS_HEADWORDS[kind as keyof typeof JEV_STATUS_HEADWORDS]

section('§1 switch off ⇒ the tool is absent and nothing is sent')
setJevEnabled(false)
storeJevApiKey(PROOF_KEY)
resetJevLedger()
check('jevEvalEnabled() is false with the switch off even with a key stored', jevEvalEnabled() === false && JevEvalTool.isEnabled() === false)
check('absent from the catalogue, the roster and the pool', !getAllBaseTools().some(t => t.name === 'JevEval') && !rosterNames().includes('JevEval') && !poolNames().includes('JevEval'))
const offResult = await jevEvalCall(input)
const offLine = record(offResult)
check('a direct call answers off in the resolver\'s words, at zero spend', offResult.status === 'off' && offLine === `JEV — | status=off | ${jevStatus().words}` && offLine.startsWith(`JEV — | status=off | ${headwordOf('off')}`), offLine)
check('the notice rides the first off result', /notice: no further call will succeed this session for this reason; do not retry; carry on unaided/.test(offResult.text))
check('the stand-in received nothing', standin.received.length === 0)
check('nothing counted', jevLedgerSnapshot().attempts === 0 && jevLedgerSnapshot().spendUsd === 0)

section('§2 on with no key ⇒ absent and nothing sent')
setJevEnabled(true)
storeJevApiKey(null)
resetJevLedger()
check('jevEvalEnabled() is false without a key', jevEvalEnabled() === false)
check('absent from the roster and the pool', !rosterNames().includes('JevEval') && !poolNames().includes('JevEval'))
const noKey = await jevEvalCall(input)
const noKeyLine = record(noKey)
check('a direct call answers no key in the resolver\'s words', noKey.status === 'no-key' && noKeyLine === `JEV — | status=no-key | ${jevStatus().words}` && /ships none/.test(noKeyLine), noKeyLine)
check('the stand-in received nothing', standin.received.length === 0)

section('§3 on with a key: present; every local reason is named in the resolver\'s words with nothing sent')
storeJevApiKey(PROOF_KEY)
resetJevLedger()
check('present in the roster and the pool', rosterNames().includes('JevEval') && poolNames().includes('JevEval'))
check('the roster is name-sorted with JevEval in place', (() => {
  const names = poolNames()
  return JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b)))
})())

setJevAllowanceUsd(0.001)
const allowance = await jevEvalCall(input)
const allowanceLine = record(allowance)
check('allowance hit: the resolver\'s words, Mercury\'s own count', allowance.status === 'allowance-hit' && allowanceLine === `JEV — | status=allowance-hit | ${jevStatus().words}` && /Mercury counts/.test(allowanceLine), allowanceLine)
check('  final: the notice says no further call this session', /notice: no further call will succeed this session/.test(allowance.text))
setJevAllowanceUsd(20)

setJevPacePerMinute(1)
noteJevAttempt(Date.now())
const pace = await jevEvalCall(input)
const paceLine = record(pace)
check('pace hit: the resolver\'s words with the wait', pace.status === 'pace-hit' && paceLine.startsWith(`JEV — | status=pace-hit | ${headwordOf('pace-hit')} — 1 requests in the last minute`) && /admitted in (\d+m( \d+s)?|\d+s)$/.test(paceLine), paceLine)
check('  a wait: the notice names when the next attempt is admitted', /notice: the next attempt is admitted in (\d+m( \d+s)?|\d+s); do not retry before then/.test(pace.text), pace.text)
setJevPacePerMinute(10)
resetJevLedger()

setJevRequestCeiling(1)
noteJevAttempt(Date.now())
const ceiling = await jevEvalCall(input)
const ceilingLine = record(ceiling)
check('request ceiling hit: the resolver\'s words', ceiling.status === 'ceiling-hit' && ceilingLine === `JEV — | status=ceiling-hit | ${jevStatus().words}` && /1 of 1 requests/.test(ceilingLine), ceilingLine)
setJevRequestCeiling(null)
resetJevLedger()

setJevSubagents(false)
const subOff = await runWithAgentContext(subagent, () => jevEvalCall(input))
const subOffLine = record(subOff)
check('a sub-agent with the setting off reads off, in the sub-agent words', subOff.status === 'off' && /not offered to sub-agents/.test(subOffLine), subOffLine)
check('  and the tool is not enabled for it', runWithAgentContext(subagent, () => JevEvalTool.isEnabled()) === false && runWithAgentContext(subagent, () => rosterNames().includes('JevEval')) === false)
check('  while the main model still has it', JevEvalTool.isEnabled() === true)

setJevSubagents(true)
noteJevAttempt(Date.now(), subagent.agentId)
noteJevAttempt(Date.now(), subagent.agentId)
const subBudget = await runWithAgentContext(subagent, () => jevEvalCall(input))
const subBudgetLine = record(subBudget)
check('sub-agent budget hit after two calls: the resolver\'s words', subBudget.status === 'subagent-budget-hit' && subBudgetLine === `JEV — | status=subagent-budget-hit | ${runWithAgentContext(subagent, () => jevStatus({ id: subagent.agentId, subagent: true }).words)}` && /2 JEV calls/.test(subBudgetLine), subBudgetLine)
check('  with the setting on the tool is enabled for a sub-agent', runWithAgentContext(subagent, () => JevEvalTool.isEnabled()) === true)
setJevSubagents(false)
resetJevLedger()
check('through every local reason the stand-in received nothing', standin.received.length === 0)

section('§4 every wire reason: exactly one request, then refused locally with nothing sent; the notice once')
type WireCase = { label: string; script: Parameters<typeof standin.next>[0]; kind: string; final: boolean; words: RegExp }
const wireCases: WireCase[] = [
  { label: '401', script: { status: 401, body: { error: { message: 'Invalid API key' } } }, kind: 'invalid-key', final: true, words: /the provider answered 401 at \d\d:\d\d; replace the key in \/jev/ },
  { label: '429 with retry-after-ms', script: { status: 429, body: { error: { message: 'Too Many Requests' } }, headers: { 'retry-after-ms': '5000' } }, kind: 'rate-limited', final: false, words: /429 at \d\d:\d\d, it asked for 5s; the next attempt is admitted in (\d+m( \d+s)?|\d+s)/ },
  { label: '429 without a wait', script: { status: 429, body: { error: { message: 'Too Many Requests' } } }, kind: 'rate-limited', final: false, words: /it named no wait/ },
  { label: '529', script: { status: 529, body: { error: { message: 'Overloaded' } } }, kind: 'provider-down', final: false, words: /529 "Overloaded" at \d\d:\d\d/ },
  { label: '503', script: { status: 503, raw: 'Service Unavailable' }, kind: 'provider-down', final: false, words: /503 "Service Unavailable"/ },
  { label: '402 naming credit', script: { status: 402, body: { error: { message: 'Insufficient credits on this account' } } }, kind: 'provider-credit', final: true, words: /it said "Insufficient credits on this account" \(402\)/ },
  { label: '418 naming nothing known', script: { status: 418, raw: 'I am a teapot' }, kind: 'provider-refused', final: false, words: /418 "I am a teapot"/ },
  { label: 'a 200 Mercury cannot read', script: { status: 200, raw: '{"model":"jev-1.13.0","answers":{},"usage":{"input_tokens":1,"output_tokens":0}}' }, kind: 'provider-down', final: false, words: /could not read \("answers\.skew: missing or not an object"\)/ },
]
for (const c of wireCases) {
  resetJevLedger()
  standin.reset()
  standin.next(c.script)
  const first = await jevEvalCall(input)
  const firstLine = record(first)
  check(`${c.label} ⇒ ${c.kind}`, first.status === c.kind && firstLine.startsWith(`JEV — | status=${c.kind} | ${headwordOf(c.kind)}`), firstLine)
  check('  the words are the resolver\'s, with the wire\'s own evidence', c.words.test(firstLine), firstLine)
  check('  exactly one request reached the stand-in', standin.received.length === 1, String(standin.received.length))
  check(c.final ? '  the notice: final for the session' : '  the notice: names when the next attempt is admitted', c.final ? /\nnotice: no further call will succeed this session for this reason; do not retry; carry on unaided$/.test(first.text) : /\nnotice: the next attempt is admitted in (\d+m( \d+s)?|\d+s); do not retry before then$/.test(first.text), first.text)
  const second = await jevEvalCall(input)
  record(second)
  check('  the next call is refused locally with the same reason — nothing sent', second.status === c.kind && standin.received.length === 1, `${second.status} / ${standin.received.length}`)
  check('  the notice appears on the first result only', !/notice:/.test(second.text) && second.text.split('\n').length === 1, second.text)
}
resetJevLedger()
standin.reset()
standin.next({ status: 200, raw: '{"model":"jev-1.13.0","answers":{},"usage":{"input_tokens":1,"output_tokens":0}}' })
await jevEvalCall(input)
check('an unreadable 200 is an unconfirmed charge at the per-call ceiling', jevLedgerSnapshot().unconfirmedCharges === 1 && Math.abs(jevLedgerSnapshot().spendUsd - JEV_MAX_CALL_USD) < 1e-12)

section('§5 a 422 is a typed refusal quoting the provider\'s field, never a hold')
resetJevLedger()
standin.reset()
standin.next({ status: 422, body: { error: { message: 'questions.which.criteria: an option description must be a string or null' } } })
const bad = await jevEvalCall(input)
const badLine = record(bad)
check('status bad-request with the field quoted', bad.status === 'bad-request' && /status=bad-request/.test(badLine) && /\(422\): questions\.which\.criteria/.test(badLine) && /fix the named field/.test(badLine), badLine)
check('no notice, no hold', !/notice:/.test(bad.text) && jevLedgerSnapshot().holdUntil === 0)
const fixed = await jevEvalCall(input)
check('the next call is sent (the model fixed its question) and answered', fixed.status === 'ok' && standin.received.length === 2, fixed.text)

section('§6 an abort after send is recorded as an unconfirmed charge and the result says so')
resetJevLedger()
standin.reset()
standin.next({ status: 200, body: {}, delayMs: 1500 })
const controller = new AbortController()
const pending = jevEvalCall(input, controller.signal)
setTimeout(() => controller.abort(), 60)
const aborted = await pending
const abortedLine = record(aborted)
check('status aborted, the charge unconfirmed', aborted.status === 'aborted' && /status=aborted/.test(abortedLine) && /unconfirmed/.test(abortedLine) && /nothing was retried/.test(abortedLine), abortedLine)
check('one request had been sent; the ledger counts one unconfirmed charge', standin.received.length === 1 && jevLedgerSnapshot().unconfirmedCharges === 1)
const afterAbort = await jevEvalCall(input)
check('the next call is admitted (an abort was ours, not the provider\'s)', afterAbort.status === 'ok' && standin.received.length === 2)

section('§7 the reasons stay distinct and nothing is attributed to Jev')
const reasonKinds = JEV_STATUS_KINDS.filter(k => k !== 'ready')
check('every unavailable reason was seen', reasonKinds.every(k => firstLines.has(k)), reasonKinds.filter(k => !firstLines.has(k)).join(','))
const lines = reasonKinds.map(k => firstLines.get(k)!)
check('no two reasons produce the same first line', new Set(lines).size === lines.length)
check('every first line is JEV — | status=<kind> | <headword>', reasonKinds.every(k => firstLines.get(k)!.startsWith(`JEV — | status=${k} | ${headwordOf(k)}`)))
check('no result carries approve/allow/verdict/safe/gate', !texts.some(t => /\b(approve|allow|verdict|safe|gate)\b/i.test(t)), texts.find(t => /\b(approve|allow|verdict|safe|gate)\b/i.test(t)))
check('nothing in any result is a reason attributed to Jev', !texts.some(t => /\bbecause\b|\brationale\b|Jev (says|thinks|believes|recommends|explains)/i.test(t)))
check('no result names the key', !texts.some(t => t.includes(PROOF_KEY)))
const propertyNames: string[] = []
const walk = (node: unknown): void => {
  if (typeof node !== 'object' || node === null) return
  const o = node as Record<string, unknown>
  if (typeof o.properties === 'object' && o.properties !== null) propertyNames.push(...Object.keys(o.properties as Record<string, unknown>))
  for (const value of Object.values(o)) walk(value)
}
walk(zodToJsonSchema(JevEvalTool.inputSchema as never))
check('the schema carries none of the forbidden fields', !propertyNames.some(n => JEV_EVAL_FORBIDDEN_FIELDS.includes(n)))
check('no text the model reads says experimental', !texts.some(t => /experimental/i.test(t)))

await standin.close()
resetJevLedger()
setJevEnabled(false)
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
