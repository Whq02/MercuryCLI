#!/usr/bin/env bun
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'unresolved-tool-use-home-'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'unresolved-tool-use-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

const vnext = await import(join(SRC, 'sessions/transcripts/vnext.ts'))
const logs = await import(join(SRC, 'sessions/transcripts/sessionListings.ts'))
const paths = await import(join(SRC, 'sessions/transcripts/paths.ts'))
const state = await import(join(SRC, 'boot/process-state/processState.ts'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const W = 'findUnresolvedToolUse in src/sessions/transcripts/sessionListings.ts'
const SID = '00000000-bbbb-4000-8000-00000000beef'
let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
const at = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString()
const projectDir = paths.getProjectDir(SCRATCH)
mkdirSync(projectDir, { recursive: true })
state.switchSession(SID, projectDir)
const file = paths.getTranscriptPath()
check('the transcript path follows the switched session', file === join(projectDir, `${SID}.jsonl`), `${file}; getTranscriptPath in src/sessions/transcripts/paths.ts should follow the session set by switchSession`)
let i = 0
let parent: string | null = null
const row = (entry: Record<string, unknown>): string => {
  const uuid = uid()
  appendFileSync(file, (vnext.encodeTranscriptLine(file, { uuid, parentUuid: parent, isSidechain: false, cwd: SCRATCH, sessionId: SID, version: '1.0.0', timestamp: at(i++), ...entry }) as { line: string }).line)
  parent = uuid
  return uuid
}
const call = (id: string, name = 'Bash') => row({
  type: 'assistant',
  message: { id: `msg_${id}`, role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id, name, input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
})
const answer = (id: string) => row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, toolUseResult: {} })

try {
  row({ type: 'user', message: { role: 'user', content: 'start' } })
  call('toolu_answered')
  answer('toolu_answered')
  answer('toolu_early')
  call('toolu_early')
  const firstOpen = call('toolu_open')
  const lastOpen = call('toolu_open')
  row({ type: 'user', message: { role: 'user', content: 'a plain user row between' } })

  check('a call with its result anywhere after it is resolved', (await logs.findUnresolvedToolUse('toolu_answered')) === null, `${W} should return null when a tool_result for the id follows the call`)
  check('a call whose result sits before it is resolved too', (await logs.findUnresolvedToolUse('toolu_early')) === null, `${W} should return null when a tool_result for the id sits anywhere in the transcript, before the call too`)
  const open = await logs.findUnresolvedToolUse('toolu_open')
  check('an open call answers the last assistant row that made it', open !== null && open.type === 'assistant' && open.uuid === lastOpen && open.uuid !== firstOpen, `${open ? open.uuid : 'null'}; ${W} should return the last assistant row that made the unanswered call`)
  check('an id nobody called is null', (await logs.findUnresolvedToolUse('toolu_nobody')) === null, `${W} should return null for an id no assistant row called`)

  state.switchSession('00000000-cccc-4000-8000-00000000dead', projectDir)
  check('a session without a transcript file answers null', (await logs.findUnresolvedToolUse('toolu_open')) === null, `${W} should return null when the current session has no transcript file`)
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}
console.log(failures ? `FAIL unresolved tool use: ${failures} failures` : 'PASS unresolved tool use')
process.exit(failures ? 1 : 0)
