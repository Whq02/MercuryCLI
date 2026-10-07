#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, recordedErrorExcerpt, runBenchmark, HERE } from './benchmark.ts'
import { pickTurn, MECHANICAL_FAMILIES } from './lib/fixture.ts'
import { parseEnvelopes, type RunRecord } from './lib/runner.ts'
import { scoreRun } from './lib/score.ts'
import { openerText, toolResultCount, userTexts, systemPromptText, toolRoster } from './lib/wire.ts'
import type { FamilyTable } from './lib/report.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the agent-experience suite exceeded 20 minutes')
  process.exit(1)
}, 20 * 60_000)
guard.unref?.()

section('§1 — dialect readers · step clock · scorer arithmetic')
{
  const fixtureRoot = '/fixture/private-recording-root'
  check('saved error excerpts replace only the measured output root', recordedErrorExcerpt(`Read ${fixtureRoot}/task/file.ts before editing`, fixtureRoot) === 'Read <fixture>/task/file.ts before editing')
  check('a clipped root at the end of an excerpt is private too', recordedErrorExcerpt('at file:///fixture/private-record', fixtureRoot) === 'at <fixture>')
  check('unrelated paths and numbers stay untouched', recordedErrorExcerpt('Read /different/file.ts, exit 1 after 17ms', fixtureRoot) === 'Read /different/file.ts, exit 1 after 17ms')
  const anthropic = {
    system: [{ type: 'text', text: 'SYS-A' }],
    tools: [{ name: 'Read', input_schema: {} }],
    messages: [
      { role: 'user', content: '[ax:fix-bug] do it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }, { type: 'tool_use', id: 't3', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'a' }, { type: 'tool_result', tool_use_id: 't3', content: 'b' }] },
    ],
  }
  const responses = {
    instructions: 'SYS-R',
    tools: [{ type: 'function', name: 'Read', parameters: {} }],
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '[ax-seat:count] count' }] },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  }
  const chat = {
    tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }],
    messages: [
      { role: 'system', content: 'SYS-C' },
      { role: 'user', content: '[ax:resume-a] remember' },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: '[ax:resume-b] recall' },
    ],
  }
  check('anthropic: three tool results counted across two rounds', toolResultCount(anthropic, 'anthropic') === 3)
  check('anthropic: the opener is the first user message', openerText(anthropic, 'anthropic') === '[ax:fix-bug] do it')
  check('anthropic: the system prompt text reads back', systemPromptText(anthropic, 'anthropic') === 'SYS-A')
  check('responses: one function_call_output counted', toolResultCount(responses, 'responses') === 1)
  check('responses: the opener carries the seat marker', openerText(responses, 'responses').includes('[ax-seat:count]'))
  check('responses: instructions are the system prompt', systemPromptText(responses, 'responses') === 'SYS-R')
  check('chat: zero tool results on a text-only conversation', toolResultCount(chat, 'chat') === 0)
  check('chat: user texts list both turns (the resumed conversation)', userTexts(chat, 'chat').length === 2 && userTexts(chat, 'chat')[1] === '[ax:resume-b] recall')
  check('chat: the tool roster reads function names', toolRoster(chat, 'chat').names.join() === 'Read')

  const script = [
    { calls: [{ name: 'A', input: {} }] },
    { calls: [{ name: 'B', input: {} }, { name: 'C', input: {} }] },
    { final: 'done' },
  ]
  check('step clock: 0 results ⇒ step 1', 'calls' in pickTurn(script, 0) && (pickTurn(script, 0) as { calls: { name: string }[] }).calls[0]!.name === 'A')
  check('step clock: 1 result ⇒ the parallel round', 'calls' in pickTurn(script, 1) && (pickTurn(script, 1) as { calls: unknown[] }).calls.length === 2)
  check('step clock: 3 results ⇒ the final', 'final' in pickTurn(script, 3) && (pickTurn(script, 3) as { final: string }).final === 'done')
  check('step clock: the final replays on a continuation (3 again)', 'final' in pickTurn(script, 3))
  check('step clock: a half-delivered parallel round (2) is a loud mismatch', 'final' in pickTurn(script, 2) && (pickTurn(script, 2) as { final: string }).final.startsWith('ax-mismatch'))

  const envelopes = [
    { type: 'session', session_id: 's1', tools: ['Read', 'Edit'] },
    { type: 'tool_call', message_id: 'm1', block: 0, call_id: 't1', tool: 'Edit', input: { a: 1 } },
    { type: 'step', message_id: 'm1', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
    { type: 'tool_result', call_id: 't1', status: 'error', output: 'old_string not found in file — read the file first' },
    { type: 'tool_call', message_id: 'm2', block: 0, call_id: 't2', tool: 'Read', input: { a: 1 } },
    { type: 'tool_call', message_id: 'm2', block: 0, call_id: 't2', tool: 'Read', input: { a: 1 } },
    { type: 'tool_call', message_id: 'm2', block: 1, call_id: 't2b', tool: 'Glob', input: { b: 2 } },
    { type: 'tool_result', call_id: 't2', status: 'ok', output: 'x'.repeat(400) + '\n[image]' },
    { type: 'tool_result', call_id: 't2b', status: 'ok', output: '' },
    { type: 'tool_call', parent_call_id: 't2b', message_id: 'sub1', block: 0, call_id: 's1', tool: 'Read', input: {} },
    { type: 'tool_result', parent_call_id: 't2b', call_id: 's1', status: 'ok', output: 'y'.repeat(900) },
    { type: 'tool_call', message_id: 'm3', block: 0, call_id: 't3', tool: 'Read', input: { a: 1 } },
    { type: 'tool_result', call_id: 't3', status: 'ok', output: 'Permission for this action has been denied.' },
    { type: 'text', message_id: 'm4', block: 0, text: 'done.' },
    { type: 'outcome', status: 'completed', steps: 4, answer: 'done.', denials: [{ tool: 'Read', call_id: 't3', input: {} }], usage: { input_tokens: 1 } },
  ]
  const parsed = parseEnvelopes(envelopes)
  const run: RunRecord = { spec: {} as never, envelopes, ...parsed, exitCode: 0, stderr: '', unparseable: 0, wallMs: 10, timedOut: false, sessionId: 's1' }
  check('parser: one assistant message per message id (two rows of one round merge)', parsed.assistantMessages.length === 4, String(parsed.assistantMessages.length))
  check('parser: a round\'s blocks are deduped by call id (t2 once, t2b once)', parsed.toolUses.filter(u => u.messageId === 'm2').length === 2 && parsed.toolUses.length === 4)
  check('parser: subagent traffic stays off the main thread (its Read and its 900-char result)', parsed.subagentAssistantMessages === 1 && parsed.subagentToolUses.length === 1 && parsed.subagentToolResults.length === 1 && parsed.toolResults.length === 4)
  const score = scoreRun(run, { pass: true, detail: 'canned' }, [{ tool: 'Edit', probe: true }])
  check('scorer: turns from the outcome row (steps)', score.turns === 4)
  check('scorer: four main-thread tool calls (the subagent\'s Read is not the model\'s)', score.toolCalls === 4)
  check('scorer: the error result is wasted and matched to its probe', score.wasted === 2 && score.errors.length === 1 && score.errors[0]!.probe === true, JSON.stringify({ wasted: score.wasted, errors: score.errors }))
  check('scorer: the repeated identical Read is a duplicate (unexpected)', score.duplicates === 1 && score.unexpectedErrors === 1)
  check('scorer: the error text names a fix', score.errors[0]!.namesFix === true)
  check('scorer: result chars count main-thread text only (the subagent\'s 900 chars excluded); an image rides as its placeholder word', score.toolResultChars === 400 + '\n[image]'.length + 'old_string not found in file — read the file first'.length + 'Permission for this action has been denied.'.length && score.imageChars === 0, String(score.toolResultChars))
  check('scorer: asks = denials + ask-class results', score.asks === 2 && score.denials === 1)
  check('scorer: the rows echo no input, so injected text reads 0; the subagent\'s reads counted apart (900 chars ≈ 225)', score.injectedTokensEst === 0 && score.subagentResultTokensEst === 225, JSON.stringify({ inj: score.injectedTokensEst, sub: score.subagentResultTokensEst }))
  const poison = scoreRun(run, { pass: false, detail: 'poison' }, [])
  check('poison control: with no probe declared the error is UNEXPECTED', poison.unexpectedErrors === 2 && poison.errors[0]!.probe === false)
}

section('§2 — the mechanical benchmark: every family, every task, on the built bundle')
const dist = join(HERE, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const out = mkdtempSync(join(tmpdir(), 'mercury-ax-suite-'))
const keep = process.env.MERCURY_AX_KEEP === '1'
const opts = parseArgs(['--out', out, '--families', 'all', '--port', process.env.MERCURY_AX_PORT?.trim() || '34210'])
opts.quiet = process.env.MERCURY_AX_VERBOSE !== '1'
const result = await runBenchmark(opts)
const tables = result.tables
check(`every mechanical family produced a table (${tables.map(t => t.header.family).join(', ')})`, MECHANICAL_FAMILIES.every(f => tables.some(t => t.header.family === f)))
const skips = new Map<string, string[]>()
for (const table of tables) {
  const f = table.header.family
  const rows = table.rows.filter(r => !r.skipped)
  check(`${f}: no run timed out or died without an outcome row`, rows.every(r => !r.timedOut && r.resultStatus !== 'no-result' && r.resultStatus !== 'timeout'), rows.filter(r => r.timedOut || r.resultStatus === 'no-result').map(r => `${r.task}:${r.resultStatus}`).join(', '))
  const daily = ['Agent', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill', 'Eval', 'ToolSearch']
  const rosterPresent = f === 'openai'
    ? (table.header.toolCount ?? 0) >= daily.length && daily.every(name => table.header.toolNames.includes(name))
    : (table.header.toolCount ?? 0) >= 15
  check(`${f}: the first request carries its complete tool set and a system prompt (> 2000 chars)`, (table.header.promptChars ?? 0) > 2000 && rosterPresent, `prompt ${table.header.promptChars} · tools ${table.header.toolCount}`)
  const two = table.rows.find(r => r.task === 'two-seats')
  check(`${f}: the two-seats round replayed whole — one assistant message, two Agent calls, both answered`, two?.success === true, two?.oracle)
  const resumed = table.rows.find(r => r.task === 'resume-b')
  check(`${f}: the resumed session carried the prior turn and recalled the codeword`, resumed?.success === true, resumed?.oracle)
  for (const r of table.rows.filter(r => r.skipped)) {
    const key = `${r.task} — ${r.skipped}`
    skips.set(key, [...(skips.get(key) ?? []), f])
  }
  const s = { pass: rows.filter(r => r.success === true).length, total: rows.length, wasted: rows.reduce((a, r) => a + r.wasted, 0), unexpected: rows.reduce((a, r) => a + r.unexpectedErrors, 0), asks: rows.reduce((a, r) => a + r.asks, 0), tokens: rows.reduce((a, r) => a + r.toolResultTokensEst, 0) }
  console.log(`  [INFO] ${f}: ${s.pass}/${s.total} pass · wasted ${s.wasted} (unexpected ${s.unexpected}) · asks ${s.asks} · result-tokens ≈${s.tokens} · prompt ${table.header.promptChars} chars · tools ${table.header.toolCount}`)
}

for (const [key, families] of skips) console.log(`  [SKIP] ${key} (not run on ${families.join(', ')})`)
console.log(`  [INFO] browser probe: ${result.browser.note}`)

section('§2b — the ratchet against baselines/mechanical (success never regresses; wasted and asks never grow)')
const baselineDir = join(HERE, 'baselines', 'mechanical')
if (!existsSync(baselineDir)) {
  console.log('  [INFO] no committed baseline yet — record one with `bash scripts/agent-experience/benchmark.sh --record mechanical`')
} else {
  for (const table of tables) {
    const path = join(baselineDir, `${table.header.family}.json`)
    if (!existsSync(path)) {
      console.log(`  [INFO] ${table.header.family}: no baseline table`)
      continue
    }
    const base = JSON.parse(readFileSync(path, 'utf8')) as FamilyTable
    for (const row of table.rows) {
      const b = base.rows.find(r => r.task === row.task)
      if (!b || b.skipped || row.skipped) continue
      const errorTexts = row.errors.map(e => `${e.tool}${e.probe ? ' (probe)' : ''}: ${e.text.replace(/\s+/g, ' ').slice(0, 240)}`).join(' | ')
      const stderrTail = row.stderrTail.trim().replace(/\s+/g, ' ').slice(-300)
      const evidence = `${row.oracle}${errorTexts ? ` · errors: ${errorTexts}` : ''}${stderrTail ? ` · stderr: ${stderrTail}` : ''}`
      if (b.success === true) check(`${table.header.family}/${row.task}: still passes (baseline PASS)`, row.success === true, evidence)
      check(`${table.header.family}/${row.task}: wasted ${row.wasted} ≤ baseline ${b.wasted}`, row.wasted <= b.wasted, evidence)
      check(`${table.header.family}/${row.task}: asks ${row.asks} ≤ baseline ${b.asks}`, row.asks <= b.asks)
    }
    if (base.header.promptChars && table.header.promptChars) {
      const delta = table.header.promptChars - base.header.promptChars
      console.log(`  [INFO] ${table.header.family}: prompt ${table.header.promptChars} chars (${delta >= 0 ? '+' : ''}${delta} vs baseline) · tools ${table.header.toolCount} (baseline ${base.header.toolCount})`)
    }
  }
}

console.log(`\nsummary: ${result.summaryPath}`)
if (!keep && failures === 0) rmSync(out, { recursive: true, force: true })
else console.log(`(kept ${out})`)
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL AGENT-EXPERIENCE PROOFS PASS' : `❌ ${failures} AGENT-EXPERIENCE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
