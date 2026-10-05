#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'rollup-repaints-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
delete process.env.MERCURY_HOME
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/utils/staticRender.tsx'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const rollup = (await import(join(ROOT, 'src/components/MercuryTurnRollup.tsx'))) as {
  MercuryTurnRollup: React.ComponentType<Record<string, unknown>>
  rollupSpineOf?: (messages: readonly unknown[]) => { fileCount: number; toolCount: number; typeBreakdown: string | null }
}

const T0 = 1_760_000_000_000
const iso = (at: number): string => new Date(at).toISOString()
type Rec = Record<string, unknown>
const assistantRow = (uuid: string, content: unknown[]): Rec => ({
  type: 'assistant',
  uuid,
  timestamp: iso(T0),
  requestId: `req_${uuid}`,
  message: { id: `msg_${uuid}`, type: 'message', role: 'assistant', model: 'fixture-model', content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})
const resultRow = (uuid: string, toolUseId: string, over: Rec = {}): Rec => ({
  type: 'user',
  uuid,
  timestamp: iso(T0),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', ...over }] },
  toolUseResult: {},
})
const messages: Rec[] = [
  { type: 'user', uuid: 'u-1', timestamp: iso(T0), message: { role: 'user', content: 'fix the two files' } },
  assistantRow('a-1', [{ type: 'tool_use', id: 'r-1', name: 'Read', input: { file_path: '/w/a.ts' } }]),
  resultRow('u-r1', 'r-1'),
  assistantRow('a-2', [{ type: 'tool_use', id: 'e-1', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }]),
  resultRow('u-e1', 'e-1'),
  assistantRow('a-3', [{ type: 'tool_use', id: 'e-2', name: 'Edit', input: { file_path: '/w/b.ts', old_string: 'a', new_string: 'b' } }]),
  resultRow('u-e2', 'e-2', { is_error: true }),
  assistantRow('a-4', [{ type: 'tool_use', id: 'b-1', name: 'Bash', input: { command: 'bun run build.ts' } }]),
  resultRow('u-b1', 'b-1'),
]

section('§1 the spine counts: a failed edit changes no file; the breakdown names the kinds')
const spine = rollup.rollupSpineOf?.(messages) ?? null
check('the tip exports the spine derivation (absent on the base)', spine !== null)
check('one file changed (the errored edit of b.ts changed nothing)', spine !== null && spine.fileCount === 1, JSON.stringify(spine))
check('four tools, three kinds', spine !== null && spine.toolCount === 4 && spine.typeBreakdown === '1 read · 2 edit · 1 run', JSON.stringify(spine))

section('§2 the spine repaints only when the messages array moves')
const resting: Rec = { messages, tools: [], model: 'fixture-model', isLoading: false, streamingThinking: null, isThinking: false }
const frame = (await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() }, React.createElement(rollup.MercuryTurnRollup, resting)))).replace(/\s+/g, ' ')
check('the spine painted its session line', frame.includes('session') && frame.includes('1 file changed') && frame.includes('4 tools (1 read · 2 edit · 1 run)'), frame.slice(0, 200))
const memo = rollup.MercuryTurnRollup as unknown as { compare?: ((prev: Rec, next: Rec) => boolean) | null }
const bails = (prev: Rec, next: Rec): boolean => (typeof memo.compare === 'function' ? memo.compare(prev, next) : Object.keys({ ...prev, ...next }).every(key => prev[key] === next[key]))
check('RED ON THE BASE: a loading flip and a thinking tick leave the spine as painted (the memo bails)', bails(resting, { ...resting, isLoading: true, isThinking: true }))
check('a model or tool-list change leaves it as painted too (the spine reads neither)', bails(resting, { ...resting, model: 'other-model', tools: [{}] }))
check('a new messages array repaints it', !bails(resting, { ...resting, messages: [...messages] }))

console.log(`\n${'─'.repeat(76)}`)
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
