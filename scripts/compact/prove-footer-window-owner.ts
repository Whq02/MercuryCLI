#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${cond ? '' : ' — fix: the window the number is measured against: calculateTokenWarningState (src/engine/compaction-window/autoFoldWindow.ts), contextFillView (src/engine/context-window/contextFill.ts), or the model handed to TokenWarning (src/screen/composer/TokenWarning.tsx)'}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
for (const key of [
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_LOCAL_PROBE_TARGETS',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-footer-window-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const compact = await import('../../src/engine/compaction/autoFold.ts')
const { contextFillView } = await import('../../src/engine/context-window/contextFill.ts')
const { resolveContextWindow } = await import('../../src/models/facts/capabilities.ts')

const USED = 200_000
const SEAT_1M = 'claude-fable-5-1'
const SEAT_PLAIN = 'compat/my-model'
const NO_MODEL = ''

console.log('============================================================')
console.log(' footer window owner — the session\'s tokens against the session\'s window')
console.log('============================================================')

section('W1 · the ladder over a 1M seat vs a model-less id at 200k used')
const window1m = resolveContextWindow(SEAT_1M, []).effectiveWindow
check('the 1M seat resolves a 1M window', window1m === 1_000_000, String(window1m))
const room1m = compact.calculateTokenWarningState(USED, SEAT_1M)
check('200k used on the 1M seat: a large positive room, an ok level (the band\'s 20 % used)', room1m.level === 'ok' && (room1m.pctLeft ?? 0) >= 70, JSON.stringify(room1m))
const roomNone = compact.calculateTokenWarningState(USED, NO_MODEL)
check('the same count with NO model id reads 0 % — the field\'s footer, from the wrong window', (roomNone.pctLeft ?? -1) === 0, JSON.stringify(roomNone))
const roomPlain = compact.calculateTokenWarningState(USED, SEAT_PLAIN)
check('a plain 200k seat at 200k used is at its edge — the honest reading for THAT seat', roomPlain.level !== 'ok' && (roomPlain.pctLeft ?? -1) === 0, JSON.stringify(roomPlain))

section('W2 · one owner: the band\'s fill view and the ladder agree per model')
let n = 0
const asst = (model: string, total: number): unknown => ({
  type: 'assistant',
  uuid: `a-${++n}`,
  timestamp: new Date().toISOString(),
  message: { id: `m${n}`, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: total - 600, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' },
})
type Message = import('../../src/engine/message-shapes/message.ts').Message
const transcript1m = [asst(SEAT_1M, USED)] as Message[]
const view1m = contextFillView(transcript1m, SEAT_1M)
check('the 1M seat\'s fill view: 20 % used of 1000k, and the room IS the ladder\'s number', view1m.window === 1_000_000 && view1m.usedPct === 20 && view1m.leftUntilCompactPct === room1m.pctLeft, JSON.stringify({ window: view1m.window, used: view1m.usedPct, left: view1m.leftUntilCompactPct, ladder: room1m.pctLeft }))
const viewPlain = contextFillView([asst(SEAT_PLAIN, USED)] as Message[], SEAT_PLAIN)
check('the plain seat\'s fill view measures the same count against ITS window', viewPlain.window === 200_000 && viewPlain.usedPct === 100 && viewPlain.leftUntilCompactPct === roomPlain.pctLeft, JSON.stringify({ window: viewPlain.window, used: viewPlain.usedPct, left: viewPlain.leftUntilCompactPct }))

section('W3 · the warning line paints the number for the model it is handed')
const React = (await import('react')).default
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { TokenWarning } = await import('../../src/screen/composer/TokenWarning.tsx')
const painted1m = await renderToString(React.createElement(TokenWarning, { tokenUsage: USED, model: SEAT_1M }), 100)
check('the 1M seat at 200k paints nothing (an ok level has no warning row)', painted1m.trim() === '', painted1m.slice(0, 120))
const paintedNone = await renderToString(React.createElement(TokenWarning, { tokenUsage: USED, model: NO_MODEL }), 100)
check('the model-less id paints the field\'s row — "Context left until auto-compact: 0%"', paintedNone.includes('Context left until auto-compact: 0%'), paintedNone.slice(0, 120))
const paintedNear = await renderToString(React.createElement(TokenWarning, { tokenUsage: 940_000, model: SEAT_1M }), 100)
check('the 1M seat near its fold paints the ladder\'s own room', /Context left until auto-compact: \d+%/.test(paintedNear) && !paintedNear.includes(': 0%'), paintedNear.slice(0, 120))


console.log(failures === 0 ? '\nprove-footer-window-owner: ALL LAWS HOLD' : `\nprove-footer-window-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
