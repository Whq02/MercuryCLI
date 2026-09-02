#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-turn-receipt.ts
//  PROOF: the per-turn work-receipt row (MERCURY_TURN_RECEIPT) — the pure
//  derive/injector contract + the render wiring. Fixture-driven: real-shaped
//  renderable rows in → receipt rows (or byte-identical passthrough) out.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-turn-receipt.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { injectTurnReceipts, isScratchpadPath, isTurnReceiptEnabled } = await import(
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

// ── fixtures (the render-stream shapes the injector actually sees) ──────────
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
  // Property names + the discriminant literal survive minification (JSX text
  // is split across expressions, so prose fragments do NOT).
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
