#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const NOTE = 'Reading the sum table before the arithmetic tool runs on it.'
const FINAL = 'The two numbers add to four and the table already listed that total.'

if (process.argv[2] === '--child') {
  const arm = process.argv[3]!
  const outDir = process.argv[4]!
  process.chdir(ROOT)
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'one-shot-home-'))
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  for (const pin of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
    process.env[pin] = '0'
  }
  process.env.FORCE_COLOR = '3'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { streamRenderedMessages } = await import('../../src/utils/exportRenderer.tsx')
  const uuidAt = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const stampAt = (n: number): string => `2026-06-19T12:00:${String(n).padStart(2, '0')}.000Z`
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const assistantRow = (n: number, content: unknown[], stop: 'tool_use' | 'end_turn'): Record<string, unknown> => ({
    type: 'assistant',
    uuid: uuidAt(n),
    timestamp: stampAt(n),
    requestId: undefined,
    message: { id: `msg_fixture_${n}`, type: 'message', role: 'assistant', model: 'fixture-model', content, stop_reason: stop, stop_sequence: null, usage },
  })
  const userRow = (n: number, content: unknown): Record<string, unknown> => ({ type: 'user', uuid: uuidAt(n), timestamp: stampAt(n), message: { role: 'user', content } })
  const turn = [
    userRow(1, 'add the two numbers'),
    assistantRow(2, [{ type: 'text', text: NOTE, citations: null }], 'tool_use'),
    assistantRow(3, [{ type: 'tool_use', id: 'call_fixture_1', name: 'EchoTool', input: { text: 'four' } }], 'tool_use'),
    userRow(4, [{ type: 'tool_result', tool_use_id: 'call_fixture_1', content: 'four' }]),
    assistantRow(5, [{ type: 'text', text: FINAL, citations: null }], 'end_turn'),
  ]
  const chunks: string[] = []
  await streamRenderedMessages(turn as never, [] as never, chunk => {
    chunks.push(chunk)
  }, { columns: 400, verbose: true, chunkSize: 100_000 })
  writeFileSync(join(outDir, 'frame.ansi'), chunks.join(''))
  process.exit(0)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'one-shot-'))

type Arm = { name: string; env: Record<string, string>; unset?: string[] }
const ARMS: Arm[] = [
  { name: 'force', env: { MERCURY_FORCE_SYNC_OUTPUT: '1' } },
  { name: 'off', env: { MERCURY_NO_SYNC_OUTPUT: '1' } },
  { name: 'tmux', env: { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,1,0' } },
  { name: 'harness', env: { NODE_ENV: 'test', MERCURY_NO_SYNC_OUTPUT: '1' } },
]
function runChild(arm: string, env: Record<string, string>): { stdout: string; stderr: string; status: number | null; dir: string } {
  const dir = join(scratch, arm)
  mkdirSync(dir, { recursive: true })
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  for (const k of ['MERCURY_FORCE_SYNC_OUTPUT', 'MERCURY_NO_SYNC_OUTPUT', 'TMUX', 'STY', 'NODE_ENV']) {
    if (!(k in env)) delete childEnv[k]
  }
  const res = spawnSync(BUN, ['run', import.meta.path, '--child', arm, dir], { encoding: 'utf8', env: childEnv, timeout: 120_000 })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status, dir }
}
const wordsOf = (s: string): string[] => s.match(/[A-Za-z0-9]{3,}/g) ?? []
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
const copiesOf = (frame: string, text: string): number => {
  const hay = ` ${wordsOf(stripAnsi(frame)).join(' ')} `
  const run = ` ${wordsOf(text).slice(0, 6).join(' ')} `
  return hay.split(run).length - 1
}

section('one settled frame — the export render of one turn under every marker regime')
const frames = new Map<string, string>()
for (const arm of ARMS) {
  const res = runChild(arm.name, arm.env)
  check(`${arm.name}: the child rendered (exit 0, nothing printed)`, res.status === 0 && res.stdout === '' && res.stderr === '', `status=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 120))} stderr=${JSON.stringify(res.stderr.slice(-300))}`)
  const path = join(res.dir, 'frame.ansi')
  const frame = existsSync(path) ? readFileSync(path, 'utf8') : ''
  frames.set(arm.name, frame)
  check(`${arm.name}: the frame is not empty`, stripAnsi(frame).trim() !== '')
  check(`${arm.name}: the working note paints exactly once`, copiesOf(frame, NOTE) === 1, `${copiesOf(frame, NOTE)} copies`)
  check(`${arm.name}: the final answer paints exactly once`, copiesOf(frame, FINAL) === 1, `${copiesOf(frame, FINAL)} copies`)
  check(`${arm.name}: no sync marker survives in the settled frame`, !frame.includes('\x1b[?2026'), 'BSU/ESU inside the returned frame')
}
const reference = frames.get('force') ?? ''
for (const arm of ARMS.slice(1)) {
  const frame = frames.get(arm.name) ?? ''
  if (arm.name === 'tmux') {
    const sgrCount = (s: string): number => (s.match(/\x1b\[[0-9;]*m/g) ?? []).length
    check(`${arm.name}: the same settled text and the same style transitions as the forced-on arm (only the colour form follows the terminal)`, stripAnsi(frame) === stripAnsi(reference) && sgrCount(frame) === sgrCount(reference), `${sgrCount(frame)} vs ${sgrCount(reference)} transitions`)
    continue
  }
  check(`${arm.name}: byte-identical to the forced-on arm (the same bytes with sync on, off and on the harness path)`, frame === reference, `${frame.length} vs ${reference.length} bytes`)
}

if (failures === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`[forensics] scratch kept: ${scratch}`)
console.log(failures === 0 ? '\nprove-one-shot-render-settles: ALL LAWS HOLD' : `\nprove-one-shot-render-settles: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
