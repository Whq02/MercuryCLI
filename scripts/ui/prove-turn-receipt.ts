#!/usr/bin/env bun

;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { injectTurnReceipts, isScratchpadPath, isTurnReceiptEnabled, delegatedSpendLine, formatDelegatedTokens, formatDelegatedCost, createdLineCount, hasActivity, NO_TOOLS_RAN_WORDS, otherToolsLine } = await import(
  '../../src/utils/cockpit/turnReceipt.js'
)
const TEMP_ROOT = '/tmp/claude-1/'
const inject = (rows: never[]) => injectTurnReceipts(rows, TEMP_ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')
function withEnv<T>(v: string | undefined, fn: () => T): T {
  const prev = process.env.MERCURY_TURN_RECEIPT
  if (v === undefined) delete process.env.MERCURY_TURN_RECEIPT
  else process.env.MERCURY_TURN_RECEIPT = v
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.MERCURY_TURN_RECEIPT
    else process.env.MERCURY_TURN_RECEIPT = prev
  }
}

const prompt = (text: string, uuid = 'u1') =>
  ({ type: 'user', uuid, message: { role: 'user', content: text } }) as never
const toolUse = (name: string, input: Record<string, unknown> = {}, uuid = 'a1') =>
  ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${uuid}`, name, input }] },
  }) as never
const editResult = (filePath: string, lines: string[], uuid = 'r1', forUse = 'x') =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${forUse}` }] },
    toolUseResult: { filePath, structuredPatch: [{ lines }] },
  }) as never

const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null }

const agentResult = (totalTokens: number, costUSD: number | undefined, uuid = 'ar1', status: 'completed' | 'failed' = 'completed') =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x' }] },
    toolUseResult: {
      agentId: `agent-${uuid}`,
      outcome: status === 'completed' ? { status, promotedNarration: false } : { status, reason: 'provider-declined', error: 'declined' },
      agentType: 'mercury-crew',
      content: [{ type: 'text', text: 'done' }],
      totalToolUseCount: 1,
      totalDurationMs: 1,
      totalTokens,
      ...(costUSD !== undefined ? { costUSD, unpricedTurns: 0 } : {}),
      usage: EMPTY_USAGE,
    },
  }) as never

const olderAgentResult = (totalTokens: number, uuid = 'ar0') =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x' }] },
    toolUseResult: { agentId: `agent-${uuid}`, content: [{ type: 'text', text: 'done' }], totalToolUseCount: 1, totalDurationMs: 1, totalTokens, usage: EMPTY_USAGE },
  }) as never

const launchResult = (toolUseResult: Record<string, unknown>, uuid = 'lr1') =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x' }] },
    toolUseResult,
  }) as never
type Receipt = { type: string; counts: Record<string, number> }
const receipts = (rows: unknown[]): Receipt[] =>
  (rows as Array<{ type?: string }>).filter(r => r?.type === 'turn_receipt') as Receipt[]

console.log('============================================================')
console.log(' turn receipt — pure derive/injector contract')
console.log('============================================================')

section('gate honesty (OFF ⇒ input array IDENTITY)')
const someRows = [prompt('do work'), toolUse('Bash', { command: 'ls' })]
withEnv('0', () => {
  check('=0 ⇒ the very same array object returns (byte-identical render)', injectTurnReceipts(someRows, TEMP_ROOT) === someRows)
})
withEnv(undefined, () => {
  check('unset ⇒ enabled on the stamped build', isTurnReceiptEnabled() === true)
})

section('counting + classification')
withEnv('1', () => {
  const rows = inject([
    prompt('build the thing', 'p1'),
    toolUse('Read', { file_path: '/repo/a.ts' }, 'a1'),
    toolUse('Grep', { pattern: 'x' }, 'a2'),
    toolUse('Bash', { command: 'make' }, 'a3'),
    editResult('/tmp/claude-1/xyz/scratchpad/notes.md', ['+one', '+two', '-old'], 'r1'),
    editResult('/repo/src/app.ts', ['+added', '-gone', '-gone2'], 'r2'),
  ])
  const rcpt = receipts(rows)
  check('one receipt for the (still-open) turn at end-of-list', rcpt.length === 1)
  const c = rcpt[0]!.counts
  check('1 scratchpad edit vs 1 file edit (path-segment classification)', c['scratchpadEdits'] === 1 && c['fileEdits'] === 1)
  check('+3 −3 line delta summed across both patches', c['adds'] === 3 && c['dels'] === 3)
  check('1 read · 1 search · 1 shell command', c['reads'] === 1 && c['searches'] === 1 && c['commands'] === 1)
})
withEnv('1', () => {
  const rows = inject([
    prompt('read three pages', 'p1'),
    toolUse('WebFetch', { url: 'https://docs.python.org/3/library/stdtypes.html' }, 'a1'),
    toolUse('WebFetch', { url: 'https://excalidraw.com/' }, 'a2'),
    toolUse('WebFetch', { url: 'http://wiki.lan/page' }, 'a3'),
    toolUse('WebSearch', { query: 'npm turndown' }, 'a4'),
  ])
  const c = receipts(rows)[0]!.counts
  check('three WebFetch calls count as 3 fetches, never searches (F35A-20; RED on the base: 4 searches)', c['fetches'] === 3 && c['searches'] === 1)
  const row = src('components', 'messages', 'TurnReceiptRow.tsx')
  check('the row prints fetches beside searches, singular and plural', /plural\(c\.fetches, 'fetch', 'fetches'\)/.test(row))
})
withEnv('1', () => {
  const rows = inject([
    prompt('drive the page', 'p1'),
    toolUse('Bash', { command: 'echo shell-tally-check' }, 'a1'),
    toolUse('Browser', { op: 'open', url: 'http://127.0.0.1:8765/slow.html' }, 'a2'),
    toolUse('Browser', { op: 'waitFor', text: 'SLOW CONTENT ARRIVED' }, 'a3'),
    toolUse('Browser', { op: 'extract', mode: 'text' }, 'a4'),
    toolUse('Browser', { op: 'console', limit: 3 }, 'a5'),
  ])
  const c = receipts(rows)[0]!.counts
  check('the mixed field turn counts the shell command AND the four browser actions', c['commands'] === 1 && c['browser'] === 4, JSON.stringify(c))
  const only = inject([prompt('browser only', 'p1'), toolUse('Browser', { op: 'open', url: 'http://127.0.0.1:8765/' }, 'a1'), toolUse('Browser', { op: 'screenshot' }, 'a2')])
  check('a Browser-only turn gets a receipt of its own (the field saw none in 18 such turns)', receipts(only).length === 1 && receipts(only)[0]!.counts['browser'] === 2, JSON.stringify(receipts(only).map(r => r.counts)))
})

section('every tool_use counts, by name (F37A-1D-02: a 21-call memory turn read "no tools ran this turn")')
type NamedReceipt = { type: string; counts: Record<string, number> & { tools: Record<string, number> } }
const named = (rows: unknown[]): NamedReceipt[] => receipts(rows) as NamedReceipt[]
const resultFor = (uuid: string, toolUseResult?: Record<string, unknown>) =>
  ({ type: 'user', uuid: `r-${uuid}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${uuid}`, content: 'ok' }] }, ...(toolUseResult ? { toolUseResult } : {}) }) as never
withEnv('1', () => {
  const memory = inject([
    prompt('what does memory hold?', 'p1'),
    toolUse('ToolSearch', { query: 'select:Recall' }, 'a0'), resultFor('a0'),
    ...Array.from({ length: 20 }, (_, i) => [toolUse('Recall', { read: `seq:${i}` }, `a${i + 1}`), resultFor(`a${i + 1}`)]).flat(),
  ])
  const mc = named(memory)[0]?.counts
  check('ToolSearch ×1 + Recall ×20 count by name and read as activity (RED on the base: no receipt at all)', mc !== undefined && named(memory).length === 1 && mc.tools['Recall'] === 20 && mc.tools['ToolSearch'] === 1 && hasActivity(mc as never), JSON.stringify(mc?.tools))
  check('the line names the most-called first, then alphabetical: "Recall ×20 · ToolSearch ×1"', mc !== undefined && otherToolsLine(mc as never) === 'Recall ×20 · ToolSearch ×1', String(mc && otherToolsLine(mc as never)))
  const sets = inject([prompt('named sets stay named', 'p1'), toolUse('Read', {}, 'a1'), toolUse('Grep', {}, 'a2'), toolUse('WebFetch', {}, 'a3'), toolUse('Bash', {}, 'a4'), toolUse('Browser', {}, 'a5'), toolUse('Crewmate', {}, 'a6')])
  check('a tool in a named set is never counted twice: its category counts, the by-name map stays empty', Object.keys(named(sets)[0]!.counts.tools).length === 0 && otherToolsLine(named(sets)[0]!.counts as never) === null, JSON.stringify(named(sets)[0]!.counts.tools))
  const edited = inject([prompt('an edit that wrote', 'p1'), toolUse('Edit', { file_path: '/repo/a.ts' }, 'a1'), resultFor('a1', { filePath: '/repo/a.ts', structuredPatch: [{ lines: ['+a'] }] })])
  check('an Edit whose result counted a file is "1 file edit" alone — not an Edit ×1 beside it', named(edited)[0]!.counts['fileEdits'] === 1 && Object.keys(named(edited)[0]!.counts.tools).length === 0, JSON.stringify(named(edited)[0]!.counts))
  const unchanged = inject([prompt('an edit that changed nothing', 'p1'), toolUse('Edit', { file_path: '/repo/a.ts' }, 'a1'), resultFor('a1', { filePath: '/repo/a.ts', structuredPatch: [], noChange: true })])
  check('an Edit whose result wrote nothing is still a call the turn made: "Edit ×1", never the no-tools words', named(unchanged).length === 1 && named(unchanged)[0]!.counts['fileEdits'] === 0 && named(unchanged)[0]!.counts.tools['Edit'] === 1, JSON.stringify(named(unchanged)[0]?.counts))
  const preview = inject([prompt('a ChangeSet preview', 'p1'), toolUse('ChangeSet', { op: 'preview' }, 'a1'), resultFor('a1', { op: 'preview', outcome: 'no-change', changeView: { state: 'prepared', files: [{ file: 'src/a.ts', hunks: [] }] } })])
  check('a ChangeSet preview writes nothing and counts as a call: "ChangeSet ×1"', named(preview)[0]!.counts['fileEdits'] === 0 && named(preview)[0]!.counts.tools['ChangeSet'] === 1, JSON.stringify(named(preview)[0]?.counts))
  const noResult = inject([prompt('a call still waiting', 'p1'), toolUse('Skill', { skill: 'commit' }, 'a1')])
  check('a call with no result yet counts by name at the turn\'s end', named(noResult)[0]!.counts.tools['Skill'] === 1)
  const many = inject([prompt('many tools', 'p1'), ...['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'].map((name, i) => toolUse(name, {}, `a${i}`)), toolUse('Alpha', {}, 'a9')])
  check('the line names six tools at most and counts the rest: "Alpha ×2 · Beta ×1 · … · Gamma ×1 · +2 more tools"', otherToolsLine(named(many)[0]!.counts as never) === 'Alpha ×2 · Beta ×1 · Delta ×1 · Epsilon ×1 · Eta ×1 · Gamma ×1 · +2 more tools', String(otherToolsLine(named(many)[0]!.counts as never)))
  const grouped = inject([prompt('grouped memory calls', 'p1'), { type: 'grouped_tool_use', uuid: 'g1', messages: [toolUse('Recall', {}, 'a1'), toolUse('Recall', {}, 'a2')], results: [resultFor('a1'), resultFor('a2')] } as never])
  check('grouped rows contribute their inner calls by name', named(grouped)[0]!.counts.tools['Recall'] === 2)
  const row = src('components', 'messages', 'TurnReceiptRow.tsx')
  check('the row prints the derive owner\'s by-name words before the delegated spend', row.indexOf('otherToolsLine(c)') !== -1 && row.indexOf('otherToolsLine(c)') < row.indexOf('delegatedSpendLine(c)'))
  check('the folded-work line of a compaction carries the same words', /otherToolsLine\(c\)/.test(src('services', 'compact', 'prompt.ts')))
})

section('turn boundaries')
withEnv('1', () => {
  const rows = inject([
    prompt('turn one', 'p1'),
    toolUse('Bash', { command: 'ls' }, 'a1'),
    prompt('turn two', 'p2'),
    toolUse('Read', { file_path: '/x' }, 'a2'),
  ])
  const rcpt = receipts(rows)
  check('two turns ⇒ two receipts (one per boundary + the open tail)', rcpt.length === 2)
  const idxReceipt1 = (rows as Array<{ type?: string }>).findIndex(r => r?.type === 'turn_receipt')
  const idxPrompt2 = (rows as Array<{ uuid?: string }>).findIndex(r => r?.uuid === 'p2')
  check('the first receipt sits BEFORE the next prompt row', idxReceipt1 !== -1 && idxReceipt1 < idxPrompt2)
  check('receipt 1 = the Bash turn; receipt 2 = the Read turn', rcpt[0]!.counts['commands'] === 1 && rcpt[1]!.counts['reads'] === 1)
})
withEnv('1', () => {
  const rows = inject([prompt('no tools at all', 'p1'), prompt('another', 'p2')])
  check('a turn with no reply and no tool activity injects NOTHING', receipts(rows).length === 0)
  const replyRow = (text: string, uuid = 'r-text') => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) as never
  const claimed = inject([prompt('run the tests and tell me how many pass', 'p1'), replyRow('All 23 tests pass. Verified with pnpm vitest run — exit code 0.'), prompt('next', 'p2')])
  check('a REPLY turn that ran no tool injects a receipt with every count zero (the no-tools mark; red on the base)', receipts(claimed).length === 1 && !hasActivity(receipts(claimed)[0]!.counts as never), JSON.stringify(receipts(claimed).map(r => r.counts)))
  const settledTail = inject([prompt('tell me', 'p1'), replyRow('a plain answer')])
  check('the same at end-of-list once the reply has landed', receipts(settledTail).length === 1 && !hasActivity(receipts(settledTail)[0]!.counts as never))
  check('a prompt still waiting for its reply injects nothing (the in-flight turn)', receipts(inject([prompt('waiting', 'p1')])).length === 0)
  check('rows before the first prompt never mint a no-tools receipt', receipts(inject([replyRow('a greeting before any prompt'), prompt('first', 'p1')])).length === 0)
  check('a reply row of empty text is not a reply', receipts(inject([prompt('x', 'p1'), replyRow('   ')])).length === 0)
  check('the words the row prints come from the derive owner', NO_TOOLS_RAN_WORDS === 'no tools ran this turn' && /NO_TOOLS_RAN_WORDS/.test(src('components', 'messages', 'TurnReceiptRow.tsx')))
  const withUsage = (uuid: string, prompt: number) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: prompt, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }) as never
  const deltas = inject([prompt('a', 'p1'), withUsage('u1', 20000), prompt('b', 'p2'), toolUse('Bash', { command: 'ls' }, 'a2'), withUsage('u2', 21500), prompt('c', 'p3'), replyRow('no usage here', 'u3')])
  const deltaRows = (deltas as Array<{ type?: string; contextDelta?: number }>).filter(r => r?.type === 'turn_receipt').map(r => r.contextDelta)
  check('each receipt carries the turn\'s context delta from the rows\' own usage (20,000 · +1,500 · none)', deltaRows.length === 3 && deltaRows[0] === 20000 && deltaRows[1] === 1500 && deltaRows[2] === undefined, JSON.stringify(deltaRows))
  const folded = inject([prompt('a', 'p1'), withUsage('u1', 90000), { type: 'system', subtype: 'compact_boundary', uuid: 'cb' } as never, prompt('b', 'p2'), withUsage('u2', 12000)])
  const foldedDeltas = (folded as Array<{ type?: string; contextDelta?: number }>).filter(r => r?.type === 'turn_receipt').map(r => r.contextDelta)
  check('a compaction boundary forgets the prompt sizes before it: the next turn measures from nothing, never from the folded prompt', foldedDeltas.length === 2 && foldedDeltas[0] === undefined && foldedDeltas[1] === 12000, JSON.stringify(foldedDeltas))
  const keptTail = inject([
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb2', compactMetadata: { preservedSegment: { headUuid: 'kp', anchorUuid: 'cb2', tailUuid: 'kr' } } } as never,
    { type: 'user', uuid: 'sum', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'The summary of what was folded.' } } as never,
    prompt('the kept prompt', 'kp'), withUsage('kr', 60000),
    prompt('the first new prompt', 'np'), withUsage('nr', 15000),
  ])
  const keptDeltas = (keptTail as Array<{ type?: string; uuid?: string; contextDelta?: number }>).filter(r => r?.type === 'turn_receipt').map(r => [r.uuid, r.contextDelta])
  check('a fold that keeps a verbatim tail: the kept turn re-paints no pre-fold size, the first new turn reads its own full size (RED before the latch: +60.0k then −45.0k)', keptDeltas.some(([id, d]) => id === 'kp-turn-receipt' && d === undefined) && keptDeltas.some(([id, d]) => id === 'np-turn-receipt' && d === 15000), JSON.stringify(keptDeltas))
  const recounted = inject([{ type: 'system', subtype: 'compact_boundary', uuid: 'cb3', compactMetadata: { postTokens: 65500 } } as never, prompt('after the fold', 'p4'), withUsage('u4', 66100)])
  const recountedDelta = (recounted as Array<{ type?: string; contextDelta?: number }>).find(row => row.type === 'turn_receipt')?.contextDelta
  check('F44R-39: the post-fold recount measures growth from the landing size, not zero', recountedDelta === 600, String(recountedDelta))
  const grouped = inject([
    prompt('grouped turn', 'p1'),
    {
      type: 'grouped_tool_use',
      uuid: 'g1',
      messages: [toolUse('Bash', { command: 'a' }), toolUse('Bash', { command: 'b' })],
      results: [editResult('/repo/z.ts', ['+z'])],
    } as never,
  ])
  const gc = receipts(grouped)[0]!.counts
  check('grouped_tool_use rows contribute inner tool_uses + results', gc['commands'] === 2 && gc['fileEdits'] === 1 && gc['adds'] === 1)
})

section('the delegated spend (a delegating turn\'s cost, visible in the transcript)')
withEnv('1', () => {
  const rows = inject([
    prompt('delegate the sweep', 'p1'),
    toolUse('Crewmate', { description: 'reader one', prompt: 'read' }, 'a1'),
    toolUse('Crewmate', { description: 'reader two', prompt: 'read' }, 'a2'),
    agentResult(60_000, 0.61, 'r1'),
    agentResult(24_200, 0.3, 'r2', 'failed'),
  ])
  const c = receipts(rows)[0]!.counts
  check('two Agent launches are counted', c['agents'] === 2)
  check('the settled results\' tokens are summed (a failed run\'s spend is spend)', c['delegatedTokens'] === 84_200)
  check('the list prices are summed and nothing was unpriced', Math.abs((c['delegatedCostUSD'] ?? 0) - 0.91) < 1e-9 && c['delegatedUnpriced'] === 0)
  check('the line reads `2 crewmates · 84.2k tokens · $0.91`', delegatedSpendLine(c as never) === '2 crewmates · 84.2k tokens · $0.91', String(delegatedSpendLine(c as never)))
  const unpriced = inject([
    prompt('one agent, no price', 'p1'),
    toolUse('Crewmate', { description: 'no price', prompt: 'x' }, 'a1'),
    agentResult(900, undefined, 'r1'),
  ])
  const lc = receipts(unpriced)[0]!.counts
  check('a result without a price is unpriced, never free', lc['agents'] === 1 && lc['delegatedTokens'] === 900 && lc['delegatedCostUSD'] === 0 && lc['delegatedUnpriced'] === 1)
  check('the line says so: `1 crewmate · 900 tokens (1 unpriced)`', delegatedSpendLine(lc as never) === '1 crewmate · 900 tokens (1 unpriced)', String(delegatedSpendLine(lc as never)))
  const solo = inject([prompt('no delegation', 'p1'), toolUse('Bash', { command: 'ls' }, 'a1')])
  check('a turn that delegated nothing carries no spend line (null) and its counts stay zero', delegatedSpendLine(receipts(solo)[0]!.counts as never) === null && receipts(solo)[0]!.counts['agents'] === 0)
  check('a Crewmate launch alone is activity (a receipt exists even with no other tool)', receipts(inject([prompt('just launch', 'p1'), toolUse('Crewmate', {}, 'a1')])).length === 1)
  check('the token words: 84200 → 84.2k · 1500000 → 1.5M · 900 → 900', formatDelegatedTokens(84_200) === '84.2k' && formatDelegatedTokens(1_500_000) === '1.5M' && formatDelegatedTokens(900) === '900')
  check('the cost words: 0.91 → $0.91 · 0.004 → <$0.01 · 12 → $12.00', formatDelegatedCost(0.91) === '$0.91' && formatDelegatedCost(0.004) === '<$0.01' && formatDelegatedCost(12) === '$12.00')
  const grouped = inject([
    prompt('grouped delegation', 'p1'),
    { type: 'grouped_tool_use', uuid: 'g1', messages: [toolUse('Crewmate', {}, 'a1')], results: [agentResult(1_000, 0.02, 'r1')] } as never,
  ])
  const gc = receipts(grouped)[0]!.counts
  check('grouped rows contribute their launches and settled results', gc['agents'] === 1 && gc['delegatedTokens'] === 1_000)
  const older = inject([prompt('an old row', 'p1'), toolUse('Crewmate', {}, 'a1'), olderAgentResult(500, 'r1')])
  const oc = receipts(older)[0]!.counts
  check('a row persisted before the outcome and the price existed still counts: its tokens fold, unpriced', oc['agents'] === 1 && oc['delegatedTokens'] === 500 && oc['delegatedUnpriced'] === 1)
  const background = inject([
    prompt('background launch', 'p1'),
    toolUse('Crewmate', { run_in_background: true }, 'a1'),
    launchResult({ isAsync: true, status: 'async_launched', agentId: 'agent-bg', description: 'later', prompt: 'x', outputFile: '/x', canReadOutputFile: true }, 'r1'),
  ])
  const bc = receipts(background)[0]!.counts
  check('a background launch is a launch with no spend yet (its report lands in a later turn): `1 crewmate`, no tokens', bc['agents'] === 1 && bc['delegatedTokens'] === 0 && bc['delegatedUnpriced'] === 0 && delegatedSpendLine(bc as never) === '1 crewmate')
  const workflow = inject([
    prompt('a workflow', 'p1'),
    toolUse('Workflow', { script: 'x' }, 'a1'),
    launchResult({ status: 'async_launched', taskId: 'w1', taskType: 'local_workflow', runId: 'run-1' }, 'r1'),
  ])
  check('a workflow launch is not a crewmate and carries no spend at launch: no line', receipts(workflow).length === 0 || delegatedSpendLine(receipts(workflow)[0]!.counts as never) === null)
  const agentResultSrc = src('tools', 'AgentTool', 'agentToolUtils.ts')
  check('the Crewmate tool\'s result carries the ledger\'s list price beside its token total (the row the receipt reads)', /costUSD: ledger\.costUSD,\s*unpricedTurns: ledger\.unpricedTurns,/.test(agentResultSrc) && /costUSD: z\.number\(\)\.optional\(\)/.test(agentResultSrc))
  check('the receipt reads the record by the fields the schema declares (agentId beside totalTokens), never a status the record does not carry at its top', /agentId: z\.string\(\)/.test(agentResultSrc) && /totalTokens: z\.number\(\)/.test(agentResultSrc) && /typeof r\.agentId !== 'string' \|\| typeof r\.totalTokens !== 'number'/.test(src('utils', 'cockpit', 'turnReceipt.ts')))
  check('the row prints the derive owner\'s words', /delegatedSpendLine\(c\)/.test(src('components', 'messages', 'TurnReceiptRow.tsx')))
})

section('every tool that writes files counts (RELEASE-29-AIR R29A-06): ChangeSet files and lines, a created file\'s lines; a preview, a refusal, a replay count nothing')
const resultRow = (toolUseResult: Record<string, unknown>, uuid: string, forUse = 'x') =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${forUse}` }] },
    toolUseResult,
  }) as never
const hunk = (lines: string[]) => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.filter(l => !l.startsWith('-')).length, lines })
const changeSetApplied = (files: Array<{ file: string; hunks: Array<{ lines: string[] }>; added?: number; removed?: number; omittedHunks?: number }>, uuid: string, outcome = 'succeeded', state = 'applied', forUse = 'x') =>
  resultRow(
    {
      op: 'apply',
      result: `Applied plan cs-6cfbba41b873 — ${files.length} file(s), verified by reread`,
      outcome,
      planId: 'cs-6cfbba41b873',
      changeView: {
        state,
        action: 'changeset',
        files: files.map(f => ({ file: f.file, hunks: f.hunks, changedLines: f.hunks.reduce((n, h) => n + h.lines.length, 0), ...(f.added !== undefined ? { added: f.added, removed: f.removed ?? 0 } : {}), ...(f.omittedHunks !== undefined ? { omittedHunks: f.omittedHunks } : {}) })),
        hunkCount: files.reduce((n, f) => n + f.hunks.length, 0),
        planMeta: { id: 'cs-6cfbba41b873', digest12: '6cfbba41b873', ageMs: 100, expiresInMs: 600000 },
        refs: [],
      },
    },
    uuid,
    forUse,
  )
withEnv('1', () => {
  const fieldTurn = inject([
    prompt('add --min-count N to the CLI', 'p1'),
    toolUse('Read', { file_path: '/repo/wordfreq.py' }, 'a1'),
    toolUse('Read', { file_path: '/repo/README.md' }, 'a2'),
    toolUse('Read', { file_path: '/repo/tests/test_wordfreq.py' }, 'a3'),
    toolUse('Edit', { file_path: '/repo/wordfreq.py' }, 'a4'),
    toolUse('Edit', { file_path: '/repo/wordfreq.py' }, 'a5'),
    editResult('/repo/wordfreq.py', [' ctx', '+l1', '+l2', '+l3', '+l4', '+l5', '+l6', '+l7', ' ctx'], 'r1', 'a4'),
    editResult('/repo/wordfreq.py', [' ctx', '+l8', ' ctx'], 'r2', 'a5'),
    toolUse('ChangeSet', { op: 'apply', changes: [{ file_path: '/repo/README.md' }, { file_path: '/repo/tests/test_wordfreq.py' }] }, 'a6'),
    changeSetApplied(
      [
        { file: 'README.md', hunks: [hunk([' ctx', '-old usage', '+new usage', ' ctx']), hunk([' ctx', '+**`--min-count N`** drops words', ' ctx'])], added: 2, removed: 1 },
        { file: 'tests/test_wordfreq.py', hunks: [hunk([' ctx', ...Array.from({ length: 12 }, (_, i) => `+    test line ${i}`), ' ctx'])], added: 12, removed: 0 },
      ],
      'r3',
      'succeeded',
      'applied',
      'a6',
    ),
  ])
  const c = receipts(fieldTurn)[0]!.counts
  check('the field turn counts every written file: 2 Edits + 2 ChangeSet files = 4 file edits (the release said 2)', c['fileEdits'] === 4, `fileEdits=${c['fileEdits']}`)
  check('…and every line git counts: +22 −1 (the release said +8)', c['adds'] === 22 && c['dels'] === 1, `+${c['adds']} −${c['dels']}`)
  check('…the reads stay 3', c['reads'] === 3)
  check('…and no written call is counted again by name (each Edit and the ChangeSet released by its own result)', Object.keys((c as unknown as { tools: Record<string, number> }).tools).length === 0, JSON.stringify((c as unknown as { tools: Record<string, number> }).tools))

  const onlyChangeSet = inject([
    prompt('one ChangeSet, nothing else', 'p1'),
    toolUse('ChangeSet', { op: 'apply' }, 'a1'),
    changeSetApplied([{ file: 'src/a.ts', hunks: [hunk(['+a'])], added: 1, removed: 0 }], 'r1'),
  ])
  check('a turn whose only work is a ChangeSet gets a line (the release gave none)', receipts(onlyChangeSet).length === 1 && receipts(onlyChangeSet)[0]!.counts['fileEdits'] === 1)

  const created = inject([
    prompt('write the report page', 'p1'),
    toolUse('Write', { file_path: '/repo/report.html' }, 'a1'),
    resultRow({ type: 'create', filePath: '/repo/report.html', content: '<html>\n<body>\n<table></table>\n</body>\n</html>\n', structuredPatch: [], originalFile: null }, 'r1'),
    toolUse('Bash', { command: 'python3 -m http.server' }, 'a2'),
    toolUse('Bash', { command: 'curl localhost' }, 'a3'),
  ])
  const cc = receipts(created)[0]!.counts
  check('a created file counts its lines: `1 file edit +5 · 2 shell commands` (the release gave no +N)', cc['fileEdits'] === 1 && cc['adds'] === 5 && cc['dels'] === 0 && cc['commands'] === 2, `fileEdits=${cc['fileEdits']} +${cc['adds']} −${cc['dels']}`)
  check('a created file without a final newline counts its last line; an empty file counts none', createdLineCount('a\nb') === 2 && createdLineCount('a\nb\n') === 2 && createdLineCount('') === 0 && createdLineCount('one\r\ntwo\r\n') === 2)

  const scratchSet = inject([
    prompt('scratch work', 'p1'),
    toolUse('ChangeSet', { op: 'apply' }, 'a1'),
    changeSetApplied([{ file: '/tmp/claude-1/s1/scratchpad/notes.md', hunks: [hunk(['+n'])], added: 1, removed: 0 }, { file: 'src/b.ts', hunks: [hunk(['-b'])], added: 0, removed: 1 }], 'r1'),
  ])
  const sc = receipts(scratchSet)[0]!.counts
  check('a ChangeSet member under the scratchpad is a scratchpad edit, the other a file edit', sc['scratchpadEdits'] === 1 && sc['fileEdits'] === 1 && sc['adds'] === 1 && sc['dels'] === 1)

  const bounded = inject([
    prompt('a large set', 'p1'),
    toolUse('ChangeSet', { op: 'apply' }, 'a1'),
    changeSetApplied([{ file: 'src/wide.ts', hunks: [hunk(Array.from({ length: 80 }, (_, i) => `+W${i}`))], added: 390, removed: 390, omittedHunks: 1 }], 'r1'),
  ])
  const bc = receipts(bounded)[0]!.counts
  check('the exact counts the plan carries win over the 80-line card diff: +390 −390, never the cut', bc['adds'] === 390 && bc['dels'] === 390, `+${bc['adds']} −${bc['dels']}`)
  const olderView = inject([
    prompt('a row persisted before the exact counts existed', 'p1'),
    toolUse('ChangeSet', { op: 'apply' }, 'a1'),
    changeSetApplied([{ file: 'src/old.ts', hunks: [hunk([' ctx', '+one', '+two', '-gone'])] }], 'r1'),
  ])
  const oc = receipts(olderView)[0]!.counts
  check('a row without the exact counts still counts from its hunks: +2 −1', oc['fileEdits'] === 1 && oc['adds'] === 2 && oc['dels'] === 1)

  const nothingWritten = inject([
    prompt('preview, refusal, replay', 'p1'),
    toolUse('ChangeSet', { op: 'preview' }, 'a1'),
    changeSetApplied([{ file: 'src/a.ts', hunks: [hunk(['+a'])], added: 1, removed: 0 }], 'r1', 'no-change', 'prepared'),
    toolUse('ChangeSet', { op: 'apply' }, 'a2'),
    resultRow({ op: 'apply', result: 'Plan cs-x is stale — nothing was written', outcome: 'failed', planId: 'cs-x' }, 'r2'),
    toolUse('ChangeSet', { op: 'apply' }, 'a3'),
    changeSetApplied([{ file: 'src/a.ts', hunks: [hunk(['+a'])], added: 1, removed: 0 }], 'r3', 'no-change', 'applied'),
    toolUse('AstEdit', { pattern: 'x', rewrite: 'y' }, 'a4'),
    resultRow({ state: 'no-change', pattern: 'x', rewrite: 'y', scope: '.', text: 'no change', matchCount: 1, fileCount: 1, changedPaths: [], changeView: { state: 'applied', action: 'astedit', files: [{ file: 'src/z.ts', hunks: [hunk(['+z'])], changedLines: 1 }], refs: [] } }, 'r4'),
  ])
  const nw = receipts(nothingWritten)[0]!.counts as Record<string, number> & { tools: Record<string, number> }
  check('a preview, a refusal, a replay and a no-change AstEdit write nothing — no file, no line — and count only as the calls they were: ChangeSet ×3 · AstEdit ×1', nw['fileEdits'] === 0 && nw['scratchpadEdits'] === 0 && nw['adds'] === 0 && nw['dels'] === 0 && nw.tools['ChangeSet'] === 3 && nw.tools['AstEdit'] === 1, JSON.stringify(nw))

  const astApplied = inject([
    prompt('an AstEdit that wrote', 'p1'),
    toolUse('AstEdit', { pattern: 'x', rewrite: 'y' }, 'a1'),
    resultRow({ state: 'applied', pattern: 'x', rewrite: 'y', scope: '.', text: 'applied', matchCount: 2, fileCount: 1, changedPaths: ['/repo/src/z.ts'], changeView: { state: 'applied', action: 'astedit', files: [{ file: 'src/z.ts', hunks: [hunk(['-x', '+y', '-x', '+y'])], changedLines: 4 }], refs: [] } }, 'r1'),
  ])
  const ac = receipts(astApplied)[0]!.counts
  check('an applied AstEdit counts its file and lines (+2 −2) from its change view', ac['fileEdits'] === 1 && ac['adds'] === 2 && ac['dels'] === 2, `fileEdits=${ac['fileEdits']} +${ac['adds']} −${ac['dels']}`)

  const changeSetSrc = src('tools', 'ChangeSetTool', 'ChangeSetTool.ts')
  check('the ChangeSet view carries the exact per-file counts the plan computed over the whole diff', /added: t\.diff\.added,\s*removed: t\.diff\.removed,/.test(changeSetSrc) && /added: number\s*removed: number/.test(src('services', 'changeTransaction', 'diffBudget.ts')))
})

section('scratchpad path classification')
check('…/scratchpad/… under the temp root is scratchpad', isScratchpadPath('/tmp/claude-1/s1/scratchpad/x.py', '/tmp/claude-1/'))
check('a repo path is not', !isScratchpadPath('/repo/src/scratchpadLike.ts', '/tmp/claude-1/'))
check('a project folder named scratchpad is not (it is outside the temp root)', !isScratchpadPath('/repo/scratchpad/notes.md', '/tmp/claude-1/'))
check('bare dir form counts', isScratchpadPath('/tmp/claude-1/s1/scratchpad', '/tmp/claude-1/'))
check('the Windows spelling counts', isScratchpadPath('C:\\Temp\\mercury\\p\\s1\\scratchpad\\a.txt', 'C:\\Temp\\mercury\\'))

section('render wiring (source + dist needles)')
check(
  'Messages.tsx chain runs injectTurnReceipts before the collapse passes',
  /collapsed = injectTurnReceipts\(collapsed, getMercuryTempDir\(\)\)\s*collapsed = collapseReadSearchGroups\(/.test(src('components', 'Messages.tsx')),
)
check(
  'Message.tsx dispatches turn_receipt → TurnReceiptRow',
  /case 'turn_receipt':/.test(src('components', 'Message.tsx')) &&
    /<TurnReceiptRow message=\{message\} \/>/.test(src('components', 'Message.tsx')),
)
check(
  'the row renders dim with success/error delta accents (tokens only)',
  /dimColor/.test(src('components', 'messages', 'TurnReceiptRow.tsx')) &&
    /color="success"/.test(src('components', 'messages', 'TurnReceiptRow.tsx')) &&
    /color="error"/.test(src('components', 'messages', 'TurnReceiptRow.tsx')),
)
const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist absent — run `bun run build.ts` for the dist needle')
} else {

  const dist = readFileSync(distPath, 'utf-8')
  check(
    'dist carries the receipt leg (needles `turn_receipt` + `scratchpadEdits`)',
    dist.includes('turn_receipt') && dist.includes('scratchpadEdits'),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ TURN-RECEIPT PROOFS PASS')
else console.log(`❌ ${failures} TURN-RECEIPT PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
