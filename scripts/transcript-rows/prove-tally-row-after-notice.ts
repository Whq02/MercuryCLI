#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { injectTurnReceipts } = await import('../../src/screen/cockpit/turnReceipt.ts')

const user = (uuid: string, text: string, extra: object = {}) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra })
const reply = (uuid: string, text: string) => ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 10 } } })
const working = (uuid: string) => ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool-${uuid}`, name: 'Read', input: { file_path: '/x' } }], usage: { input_tokens: 1000, output_tokens: 10 } } })
const result = (uuid: string, of: string) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${of}`, content: 'ok' }] } })
const notice = (uuid: string) => ({ type: 'attachment', uuid, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<system-reminder>\nThe operator set the mode to plan.\n</system-reminder>' } })
const other = (uuid: string) => ({ type: 'attachment', uuid, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'a queued prompt' } })

const HINT = 'check injectTurnReceipts in src/screen/cockpit/turnReceipt.ts so a turn tally stands before task-notification notices arriving after a closed reply'
let bad = 0
const check = (name: string, rows: unknown[], want: string) => {
  const out = injectTurnReceipts(rows as never, '/tmp/none') as Array<{ type: string; uuid: string }>
  const got = out.map(row => (row.type === 'turn_receipt' ? `TALLY(${row.uuid.replace('-turn-receipt', '')})` : row.uuid)).join(' → ')
  const ok = got === want
  if (!ok) bad++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — got ${got} · want ${want}; ${HINT}`}`)
}

check("S35: a mode notice written before the next prompt stands under the earlier turn's tally", [user('p1', 'first'), reply('a1', 'answer one'), notice('n1'), user('p2', 'second'), reply('a2', 'answer two')], 'p1 → a1 → TALLY(p1) → n1 → p2 → a2 → TALLY(p2)')
check('two notices before one prompt both stand under the tally, and the stretch of notices gets no tally of its own', [user('p1', 'first'), reply('a1', 'answer one'), notice('n1'), notice('n2'), user('p2', 'second'), reply('a2', 'answer two')], 'p1 → a1 → TALLY(p1) → n1 → n2 → p2 → a2 → TALLY(p2)')
check('a notice that arrives while the turn still works (no closed reply) stays inside its turn', [user('p1', 'first'), working('w1'), result('r1', 'w1'), notice('n1'), reply('a1', 'answer one'), user('p2', 'second'), reply('a2', 'answer two')], 'p1 → w1 → r1 → n1 → a1 → TALLY(p1) → p2 → a2 → TALLY(p2)')
check('a queued row of another lane after a closed reply is not taken for a notice', [user('p1', 'first'), reply('a1', 'answer one'), other('q1'), user('p2', 'second'), reply('a2', 'answer two')], 'p1 → a1 → q1 → TALLY(p1) → p2 → a2 → TALLY(p2)')
check('a virtual user notice after a closed reply opens the new stretch, as before', [user('p1', 'first'), reply('a1', 'answer one'), user('v1', '<system-reminder>\nwoken\n</system-reminder>', { isVirtual: true }), reply('a2', 'woken answer')], 'p1 → a1 → TALLY(p1) → v1 → a2 → TALLY(v1)')
check('no notice at all: the tally stands before the next prompt, as before', [user('p1', 'first'), reply('a1', 'answer one'), user('p2', 'second'), reply('a2', 'answer two')], 'p1 → a1 → TALLY(p1) → p2 → a2 → TALLY(p2)')
check('a notice before the very first prompt draws no tally', [notice('n0'), user('p1', 'first'), reply('a1', 'answer one')], 'n0 → p1 → a1 → TALLY(p1)')

console.log(bad === 0 ? 'prove-tally-row-after-notice: 7 of 7' : `prove-tally-row-after-notice: ${bad} differ`)
process.exit(bad === 0 ? 0 : 1)
export {}
