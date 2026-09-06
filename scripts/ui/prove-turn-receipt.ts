#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { injectTurnReceipts, isScratchpadPath, isTurnReceiptEnabled, delegatedSpendLine, formatDelegatedTokens, formatDelegatedCost } = await import(
  '../../src/utils/cockpit/turnReceipt.js'
)

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
const editResult = (filePath: string, lines: string[], uuid = 'r1') =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x' }] },
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
      agentType: 'general-purpose',
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
  check('=0 ⇒ the very same array object returns (byte-identical render)', injectTurnReceipts(someRows) === someRows)
})
withEnv(undefined, () => {
  check('unset ⇒ enabled on the stamped build', isTurnReceiptEnabled() === true)
})

section('counting + classification')
withEnv('1', () => {
  const rows = injectTurnReceipts([
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

section('turn boundaries')
withEnv('1', () => {
  const rows = injectTurnReceipts([
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
  const rows = injectTurnReceipts([prompt('no tools at all', 'p1'), prompt('another', 'p2')])
  check('a turn with zero tool activity injects NOTHING', receipts(rows).length === 0)
  const grouped = injectTurnReceipts([
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

section('the delegated spend (a supercode turn\'s cost, visible in the transcript)')
withEnv('1', () => {
  const rows = injectTurnReceipts([
    prompt('delegate the sweep', 'p1'),
    toolUse('Agent', { description: 'reader one', prompt: 'read' }, 'a1'),
    toolUse('Agent', { description: 'reader two', prompt: 'read' }, 'a2'),
    agentResult(60_000, 0.61, 'r1'),
    agentResult(24_200, 0.3, 'r2', 'failed'),
  ])
  const c = receipts(rows)[0]!.counts
  check('two Agent launches are counted', c['agents'] === 2)
  check('the settled results\' tokens are summed (a failed run\'s spend is spend)', c['delegatedTokens'] === 84_200)
  check('the list prices are summed and nothing was unpriced', Math.abs((c['delegatedCostUSD'] ?? 0) - 0.91) < 1e-9 && c['delegatedUnpriced'] === 0)
  check('the line reads `2 sub-agents · 84.2k tokens · $0.91`', delegatedSpendLine(c as never) === '2 sub-agents · 84.2k tokens · $0.91', String(delegatedSpendLine(c as never)))
  const legacy = injectTurnReceipts([
    prompt('one old agent', 'p1'),
    toolUse('Task', { description: 'legacy spelling', prompt: 'x' }, 'a1'),
    agentResult(900, undefined, 'r1'),
  ])
  const lc = receipts(legacy)[0]!.counts
  check('the earlier tool spelling counts as a launch; a result without a price is unpriced, never free', lc['agents'] === 1 && lc['delegatedTokens'] === 900 && lc['delegatedCostUSD'] === 0 && lc['delegatedUnpriced'] === 1)
  check('the line says so: `1 sub-agent · 900 tokens (1 unpriced)`', delegatedSpendLine(lc as never) === '1 sub-agent · 900 tokens (1 unpriced)', String(delegatedSpendLine(lc as never)))
  const solo = injectTurnReceipts([prompt('no delegation', 'p1'), toolUse('Bash', { command: 'ls' }, 'a1')])
  check('a turn that delegated nothing carries no spend line (null) and its counts stay zero', delegatedSpendLine(receipts(solo)[0]!.counts as never) === null && receipts(solo)[0]!.counts['agents'] === 0)
  check('an Agent launch alone is activity (a receipt exists even with no other tool)', receipts(injectTurnReceipts([prompt('just launch', 'p1'), toolUse('Agent', {}, 'a1')])).length === 1)
  check('the token words: 84200 → 84.2k · 1500000 → 1.5M · 900 → 900', formatDelegatedTokens(84_200) === '84.2k' && formatDelegatedTokens(1_500_000) === '1.5M' && formatDelegatedTokens(900) === '900')
  check('the cost words: 0.91 → $0.91 · 0.004 → <$0.01 · 12 → $12.00', formatDelegatedCost(0.91) === '$0.91' && formatDelegatedCost(0.004) === '<$0.01' && formatDelegatedCost(12) === '$12.00')
  const grouped = injectTurnReceipts([
    prompt('grouped delegation', 'p1'),
    { type: 'grouped_tool_use', uuid: 'g1', messages: [toolUse('Agent', {}, 'a1')], results: [agentResult(1_000, 0.02, 'r1')] } as never,
  ])
  const gc = receipts(grouped)[0]!.counts
  check('grouped rows contribute their launches and settled results', gc['agents'] === 1 && gc['delegatedTokens'] === 1_000)
  const older = injectTurnReceipts([prompt('an old row', 'p1'), toolUse('Agent', {}, 'a1'), olderAgentResult(500, 'r1')])
  const oc = receipts(older)[0]!.counts
  check('a row persisted before the outcome and the price existed still counts: its tokens fold, unpriced', oc['agents'] === 1 && oc['delegatedTokens'] === 500 && oc['delegatedUnpriced'] === 1)
  const background = injectTurnReceipts([
    prompt('background launch', 'p1'),
    toolUse('Agent', { run_in_background: true }, 'a1'),
    launchResult({ isAsync: true, status: 'async_launched', agentId: 'agent-bg', description: 'later', prompt: 'x', outputFile: '/x', canReadOutputFile: true }, 'r1'),
  ])
  const bc = receipts(background)[0]!.counts
  check('a background launch is a launch with no spend yet (its report lands in a later turn): `1 sub-agent`, no tokens', bc['agents'] === 1 && bc['delegatedTokens'] === 0 && bc['delegatedUnpriced'] === 0 && delegatedSpendLine(bc as never) === '1 sub-agent')
  const workflow = injectTurnReceipts([
    prompt('a workflow', 'p1'),
    toolUse('Workflow', { script: 'x' }, 'a1'),
    launchResult({ status: 'async_launched', taskId: 'w1', taskType: 'local_workflow', runId: 'run-1' }, 'r1'),
  ])
  check('a workflow launch is not a sub-agent and carries no spend at launch: no line', receipts(workflow).length === 0 || delegatedSpendLine(receipts(workflow)[0]!.counts as never) === null)
  const agentResultSrc = src('tools', 'AgentTool', 'agentToolUtils.ts')
  check('the Agent tool\'s result carries the ledger\'s list price beside its token total (the row the receipt reads)', /costUSD: ledger\.costUSD,\s*unpricedTurns: ledger\.unpricedTurns,/.test(agentResultSrc) && /costUSD: z\.number\(\)\.optional\(\)/.test(agentResultSrc))
  check('the receipt reads the record by the fields the schema declares (agentId beside totalTokens), never a status the record does not carry at its top', /agentId: z\.string\(\)/.test(agentResultSrc) && /totalTokens: z\.number\(\)/.test(agentResultSrc) && /typeof r\.agentId !== 'string' \|\| typeof r\.totalTokens !== 'number'/.test(src('utils', 'cockpit', 'turnReceipt.ts')))
  check('the row prints the derive owner\'s words', /delegatedSpendLine\(c\)/.test(src('components', 'messages', 'TurnReceiptRow.tsx')))
})

section('scratchpad path classification')
check('…/scratchpad/… is scratchpad', isScratchpadPath('/tmp/claude-1/s1/scratchpad/x.py'))
check('a repo path is not', !isScratchpadPath('/repo/src/scratchpadLike.ts'))
check('bare dir form counts', isScratchpadPath('/x/scratchpad'))

section('render wiring (source + dist needles)')
check(
  'Messages.tsx chain runs injectTurnReceipts before the collapse passes',
  /collapsed = injectTurnReceipts\(collapsed\)\s*collapsed = collapseReadSearchGroups\(/.test(src('components', 'Messages.tsx')),
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
