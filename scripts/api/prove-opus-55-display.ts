#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'opus-55-display-pure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const ROW = 'claude-opus-5-5'
const PREVIOUS = 'claude-opus-5'
const DISPLAY_HEADER = 'thinking-display-updates-2026-08-18'
const BINDING_HEADER = 'thinking-binding-controls-2026-08-01'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

type Body = {
  model?: string
  thinking?: { type?: string; display?: string; block_binding?: { prefix_mismatch_behavior?: string } }
  tool_choice?: { type?: string }
  output_config?: { effort?: string }
}

section('the wire — the built bundle, headless, against the fixture: the request to Claude Opus 5.5')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'OPUS-55-DISPLAY-DONE', thinking: 'read the probe', model: ROW, whenModel: 'opus-5-5' },
      { kind: 'text', text: 'OPUS-55-DISPLAY-DONE', thinking: 'read the probe', model: ROW, whenModel: 'opus-5-5' },
      { kind: 'text', text: 'OPUS-55-DISPLAY-DONE', thinking: 'read the probe', model: ROW, whenModel: 'opus-5-5' },
      { kind: 'text', text: 'OPUS-5-CONTROL-DONE', thinking: 'control', model: PREVIOUS, whenModel: 'opus-5' },
      { kind: 'text', text: 'SIDE', thinking: 'side' },
      { kind: 'text', text: 'SIDE', thinking: 'side' },
      { kind: 'text', text: 'SIDE', thinking: 'side' },
      { kind: 'text', text: 'SIDE', thinking: 'side' },
    ]
    const fixture = await startFixtureApi(turns)
    const home = mkdtempSync(join(tmpdir(), 'opus-55-display-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'opus-55-display-cwd-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    const env = (extra: Record<string, string>): Record<string, string> => ({
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.claude'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_THINKING_BINDING: 'drop_block',
      ...extra,
    })
    const run = (args: string[], extra: Record<string, string>): Promise<{ exit: number | null; stdout: string; stderr: string }> =>
      new Promise(resolvePromise => {
        const child = spawn(nodeBin, [DIST, ...args], { cwd, env: env(extra) })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
      })
    const mainRequest = (from: number, model: string, needle: string): Body | undefined => {
      const rows = fixture.messageRequests().slice(from)
      return rows.map(r => r.body as Body).find(b => b.model === model && j(b).includes(needle))
    }
    const headersOf = (from: number, model: string, needle: string): string => {
      const rows = fixture.messageRequests().slice(from)
      const row = rows.find(r => (r.body as Body).model === model && j(r.body).includes(needle))
      return row?.headers['anthropic-beta'] ?? ''
    }

    let from = fixture.messageRequests().length
    const r1 = await run(['-p', 'display probe one', '--model', ROW, '--output-format', 'stream-json'], { MERCURY_THINKING_DISPLAY: 'updates' })
    check('the turn on the row exits 0 and answers', r1.exit === 0 && r1.stdout.includes('OPUS-55-DISPLAY-DONE'), `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
    const b1 = mainRequest(from, ROW, 'display probe one')
    check('the request names the row', b1?.model === ROW, j(b1?.model))
    check("thinking rides adaptive with display 'updates' (never disabled, never a budget)", b1?.thinking?.type === 'adaptive' && b1?.thinking?.display === 'updates' && !('budget_tokens' in (b1?.thinking ?? {})), j(b1?.thinking))
    check('the display beta rides the anthropic-beta header beside the binding beta', headersOf(from, ROW, 'display probe one').includes(DISPLAY_HEADER) && headersOf(from, ROW, 'display probe one').includes(BINDING_HEADER), headersOf(from, ROW, 'display probe one'))
    check('the preserved-thinking binding stamps drop_block on the row as on every first-party request', b1?.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block', j(b1?.thinking))
    check('no forced tool choice reaches the wire (auto or absent)', b1 !== undefined && (b1.tool_choice === undefined || b1.tool_choice.type === 'auto'), j(b1?.tool_choice))
    check("the launch effort rides 'high' in output_config (the owner's ruling; the vendor's default is medium)", b1?.output_config?.effort === 'high', j(b1?.output_config))

    from = fixture.messageRequests().length
    const r2 = await run(['-p', 'display probe two', '--model', ROW, '--output-format', 'stream-json'], { MERCURY_THINKING_DISPLAY: 'off' })
    const b2 = mainRequest(from, ROW, 'display probe two')
    check("an explicit 'off' sends no display field and no display beta; thinking still rides adaptive", r2.exit === 0 && b2?.thinking?.type === 'adaptive' && b2?.thinking?.display === undefined && !headersOf(from, ROW, 'display probe two').includes(DISPLAY_HEADER), `exit=${r2.exit} ${j(b2?.thinking)} ${headersOf(from, ROW, 'display probe two')}`)

    from = fixture.messageRequests().length
    const r3 = await run(['-p', 'display probe three', '--model', ROW, '--output-format', 'stream-json'], { MERCURY_THINKING_DISPLAY: 'updates', MERCURY_THINKING_BUDGET: '0' })
    const b3 = mainRequest(from, ROW, 'display probe three')
    check('a disabled thinking config sends NO thinking object to the row (the always-on law: never the disabled shape)', r3.exit === 0 && b3 !== undefined && b3.thinking === undefined, `exit=${r3.exit} ${j(b3?.thinking)}`)

    from = fixture.messageRequests().length
    const r4 = await run(['-p', 'display probe four', '--model', PREVIOUS, '--output-format', 'stream-json'], { MERCURY_THINKING_DISPLAY: 'updates' })
    const b4 = mainRequest(from, PREVIOUS, 'display probe four')
    check('Opus 5 is untouched: adaptive thinking, no display field, no display beta', r4.exit === 0 && b4?.thinking?.type === 'adaptive' && b4?.thinking?.display === undefined && !headersOf(from, PREVIOUS, 'display probe four').includes(DISPLAY_HEADER), `exit=${r4.exit} ${j(b4?.thinking)} ${headersOf(from, PREVIOUS, 'display probe four')}`)
    await fixture.close()
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` OPUS 5.5 DISPLAY WIRE GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ${failures} OPUS 5.5 DISPLAY WIRE FAILURE(S) (${checks} checks)`)
process.exit(1)
