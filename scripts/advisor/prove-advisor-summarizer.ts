#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const ambient of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_ADVISOR_MODEL', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[ambient]
const home = mkdtempSync(join(tmpdir(), 'advisor-summarizer-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const ROOT = resolve(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const { startOverflowFixture, OVERFLOW_LANES } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const summarizer = await import('../../src/services/advisor/advisorSummarizer.ts')
const advisor = await import('../../src/services/advisor/advisorContext.ts')

const SYSTEM = 'You are summarizing the older portion of a memory. Write three numbered sections.'
const TRANSCRIPT = "[the agent's conversation, as shown to you] the parser accepts quoted commas\n[your note to the agent] run the fourteen checks before the commit"
const SUMMARY = '1. The parser work. 2. Run the checks. 3. Nothing open.'
const ceilingOf = (body: Record<string, unknown>): unknown => body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? (body.generationConfig as { maxOutputTokens?: unknown } | undefined)?.maxOutputTokens ?? null
const toolsOf = (body: Record<string, unknown>): unknown[] => (Array.isArray(body.tools) ? body.tools : [])

try {
  section('§1 THE CALL — one request a road, the fold prompt as the system text, the rows inside one user message, no tool, no cache mark, a ceiling of 1,500 where the wire states one')
  for (const road of OVERFLOW_LANES) {
    const before = fixture.captured.length
    fixture.script(() => ({ text: SUMMARY }))
    let answer = ''
    let error = ''
    try {
      answer = await summarizer.liveAdvisorSummarizer({ systemPrompt: SYSTEM, transcript: TRANSCRIPT, modelId: road.model })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const requests = fixture.captured.slice(before)
    const body = requests[0]?.body ?? {}
    const wire = JSON.stringify(body)
    const ceiling = ceilingOf(body)
    check(`${road.lane}: one request on its declared wire, answered with the summary`, requests.length === 1 && requests[0]?.dialect === road.dialect && answer === SUMMARY, j({ n: requests.length, dialect: requests[0]?.dialect, answer, error }))
    check(`${road.lane}: the system text and the rows, wrapped once`, wire.includes(JSON.stringify(SYSTEM).slice(1, -1)) && wire.split('<conversation_to_fold>').length === 2 && wire.includes(JSON.stringify(`<conversation_to_fold>\n${TRANSCRIPT}\n</conversation_to_fold>`).slice(1, -1)), wire.slice(0, 300))
    check(`${road.lane}: no tool is offered and nothing is marked for the cache`, toolsOf(body).length === 0 && !wire.includes('cache_control'), j(toolsOf(body)).slice(0, 200))
    check(`${road.lane}: the output ceiling is 1,500 or the wire states none`, ceiling === 1500 || ceiling === null, j(ceiling))
  }

  section('§2 THE DEFAULT ROAD — a fold with no summarizer handed in makes that call and replaces the folded rows')
  {
    const context = await advisor.loadAdvisorContext('agent-default-fold', { dir: join(home, 'advisor-rows') })
    for (let i = 0; i < 8; i++) await advisor.appendAdvisorRow(context, { kind: i % 2 === 0 ? 'digest' : 'note', at: `t${i}`, text: `row ${i} of the memory` })
    const before = fixture.captured.length
    fixture.script(() => ({ text: SUMMARY }))
    const folded = await advisor.compactAdvisorContext(context, { model: OVERFLOW_LANES[0]!.model })
    const requests = fixture.captured.slice(before)
    const wire = JSON.stringify(requests[0]?.body ?? {})
    check('one request went out, carrying the advisor\'s own fold prompt and the two oldest rows', requests.length === 1 && wire.includes("advisor's own memory") && wire.includes('row 0 of the memory') && wire.includes('row 1 of the memory') && !wire.includes('row 2 of the memory'), j({ n: requests.length, wire: wire.slice(0, 200) }))
    check('the two oldest rows are one summary row, the newest six stand verbatim', folded.compacted === 2 && folded.refused === undefined && context.rows.length === 7 && context.rows[0]!.kind === 'summary' && context.rows[0]!.text === SUMMARY && context.rows[6]!.text === 'row 7 of the memory', j({ folded, kinds: context.rows.map(r => r.kind) }))
    const refusedBefore = context.rows.length
    fixture.script(() => ({ error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the fixture refuses this fold' } } } }))
    for (let i = 0; i < 4; i++) await advisor.appendAdvisorRow(context, { kind: 'note', at: `u${i}`, text: `later row ${i}` })
    const refused = await advisor.compactAdvisorContext(context, { model: OVERFLOW_LANES[0]!.model })
    check('a call the provider refuses folds nothing and says why in the fold\'s own sentence', refused.compacted === 0 && typeof refused.refused === 'string' && refused.refused.startsWith('the summary call failed — ') && refused.refused.endsWith('; nothing was folded') && context.rows.length === refusedBefore + 4, j(refused))
    fixture.script(() => ({ text: '' }))
    const empty = await advisor.compactAdvisorContext(context, { model: OVERFLOW_LANES[0]!.model })
    check('an empty answer folds nothing and is named', empty.compacted === 0 && String(empty.refused).includes('the summarizer returned no text') && context.rows.length === refusedBefore + 4, j(empty))
  }

  section('§3 THE DEADLINE — an expired budget is named as the budget, a caller\'s cancel keeps its own words')
  {
    const expired = AbortSignal.timeout(1)
    await new Promise(r => setTimeout(r, 20))
    const cancelled = new AbortController()
    cancelled.abort(new Error('the operator pressed esc'))
    const providerAbort = new Error('Request was aborted.')
    check('the summary call\'s wall is sixty seconds', summarizer.ADVISOR_SUMMARY_WALL_MS === 60_000, String(summarizer.ADVISOR_SUMMARY_WALL_MS))
    check('a fired AbortSignal.timeout reads as the deadline (its reason is a TimeoutError)', expired.aborted && summarizer.deadlineExpired(expired))
    check('a caller abort is NOT the deadline', cancelled.signal.aborted && !summarizer.deadlineExpired(cancelled.signal))
    check('a live signal is neither', !summarizer.deadlineExpired(AbortSignal.timeout(60_000)))
    check('the words name the budget when the deadline fired, whatever the provider error said', summarizer.deadlineWords(expired, summarizer.ADVISOR_SUMMARY_WALL_MS, 'the summary call', providerAbort) === 'the summary call hit its 60 s budget before the provider finished')
    check('a caller cancel keeps the error\'s own words', summarizer.deadlineWords(cancelled.signal, summarizer.ADVISOR_SUMMARY_WALL_MS, 'the summary call', providerAbort) === 'Request was aborted.')
    check('a failure with no signal behind it keeps its own words', summarizer.deadlineWords(AbortSignal.timeout(60_000), summarizer.ADVISOR_SUMMARY_WALL_MS, 'the summary call', new Error('no account')) === 'no account')
    const source = read('src/services/advisor/advisorSummarizer.ts')
    check('the call holds its one signal, names its budget on a throw and on an empty answer after expiry', source.includes('const signal = AbortSignal.timeout(ADVISOR_SUMMARY_WALL_MS)') && source.includes("throw new Error(deadlineWords(signal, ADVISOR_SUMMARY_WALL_MS, 'the summary call', err))") && source.includes("deadlineExpired(signal) ? deadlineWords(signal, ADVISOR_SUMMARY_WALL_MS, 'the summary call', undefined) : 'the summarizer returned no text'"))
  }

  section('§4 THE OWNER — the advisor folds through a module of its own')
  {
    const context = read('src/services/advisor/advisorContext.ts')
    check('the fold\'s default is the advisor\'s summarizer, loaded when a fold needs it', context.includes("opts.summarize ?? (await import('./advisorSummarizer.js')).liveAdvisorSummarizer"))
    check('the advisor\'s memory names no concourse module', !/\.\.\/concourse\//.test(context) && !/\.\.\/concourse\//.test(read('src/services/advisor/advisorSummarizer.ts')))
    check('the call is filed as a fold: its query source stands in the compaction sources', read('src/services/advisor/advisorSummarizer.ts').includes("querySource: 'concourse_coordinator_compact'") && read('src/constants/querySource.ts').includes("'concourse_coordinator_compact'] as const"))
  }
  section('§5 A PROVIDER ERROR AFTER PARTIAL TEXT — the error row is never the summary, and the words before it are not one either')
  {
    const router = await import('../../src/services/providers/callModelRouter.js')
    mock.module('../../src/services/providers/callModelRouter.js', () => ({
      ...router,
      async *routedCallModel() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial summary' }] } }
        yield { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529 overloaded_error' }] } }
      },
    }))
    let answer = ''
    let error = ''
    try {
      answer = await summarizer.liveAdvisorSummarizer({ systemPrompt: SYSTEM, transcript: TRANSCRIPT, modelId: OVERFLOW_LANES[0]!.model })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    check('the call throws the provider\'s own words and returns no summary', answer === '' && error.includes('529 overloaded_error') && !error.includes('partial summary'), j({ answer, error }))
    const context = await advisor.loadAdvisorContext('agent-error-after-text', { dir: join(home, 'advisor-rows') })
    for (let i = 0; i < 8; i++) await advisor.appendAdvisorRow(context, { kind: 'note', at: `e${i}`, text: `kept row ${i}` })
    const refused = await advisor.compactAdvisorContext(context, { model: OVERFLOW_LANES[0]!.model })
    check('the fold refuses with those words and keeps every row', refused.compacted === 0 && String(refused.refused).includes('529 overloaded_error') && context.rows.length === 8 && context.rows.every(r => r.kind === 'note'), j({ refused, rows: context.rows.length }))
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
