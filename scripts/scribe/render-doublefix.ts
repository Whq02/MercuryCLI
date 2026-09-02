#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/render-doublefix.ts  (Stage-5 render-verify for the double-fix)
//  The render-verify law: a renderer change is only "working" once the REAL TUI is
//  captured. The double-message bug's operator-visible shape is a Scribe turn that
//  emits BOTH a text block AND a SendUserMessage in ONE turn → two rows. This builds
//  a SYNTHETIC --resume session containing exactly that ([text, SendUserMessage] +
//  its tool_result) and renders the built binary under vshot.py at 80 AND 120 cols,
//  for two REALISTIC post-fix scenarios:
//    • BRIEF (a plain fork brief session — SendUserMessage is the legit channel):
//      dropTextInBriefTurns suppresses the redundant text → exactly ONE operator row
//      (the SendUserMessage content). The defense-in-depth dedup, intact.
//    • CHATROOM (scribe chatroom, should-fix c): dropTextToolNames=[] ⇒ the Scribe's
//      typed text is KEPT (it reads as its own [Mercury-Amanuensis] line) → BOTH render,
//      no silent loss of the operator-visible text.
//  NOTE on scribe-DEFAULT mode: post must-fix #1 the keystone DENIES SendUserMessage to
//  the default-mode Scribe entirely, so a [text, SendUserMessage] turn is structurally
//  IMPOSSIBLE there (the tool is absent) — the double is killed at the tool, not the
//  renderer. That is proven by the LIVE engage test + prove-double-fix, not a resume
//  render (a recorded SendUserMessage from a disabled tool simply does not render).
//  This is the rendered counterpart to the source/logic proof in prove-double-fix.ts.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/render-doublefix.ts
//  Out:  /tmp/doublefix-{DEFAULT,CHATROOM}-{80,120}.html + a grep summary.
// ============================================================================
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// CI-portability: derive the checkout root — never a machine literal.
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
const PROJECTS = join(process.env.HOME!, '.claude', 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('../ui/vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')

const SID = '00000000-aaaa-bbbb-cccc-000000000048'
const TS = (s: number) => `2026-06-19T11:00:0${s}.000Z`
let u = 0
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`

// Distinctive sentinels so the grep is unambiguous about which block rendered.
const REDUNDANT_TEXT = 'REDUNDANTWORKINGNOTES tokenizer split looks right'
const OPERATOR_MSG = 'OPERATORFACINGLINE the tokenizer is split and tests pass'

type Line = Record<string, unknown>
const common = (extra: Line): Line => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd: RUNTIME_CWD, sessionId: SID,
  version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})

function operator(parent: string | null, text: string, t: number): Line {
  return common({ parentUuid: parent, type: 'user', message: { role: 'user', content: text }, uuid: uuid(), timestamp: TS(t) })
}
// A Scribe turn that emits BOTH a text block AND a SendUserMessage tool_use — the
// exact double-message shape. tu id links to the tool_result below.
function scribeDouble(parent: string, tuId: string, t: number): Line {
  return common({
    parentUuid: parent, type: 'assistant',
    message: {
      model: 'claude-opus-4-8', id: `msg_${uuid()}`, type: 'message', role: 'assistant',
      content: [
        { type: 'text', text: REDUNDANT_TEXT },
        { type: 'tool_use', id: tuId, name: 'SendUserMessage', input: { message: OPERATOR_MSG, status: 'normal' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    uuid: uuid(), timestamp: TS(t),
  })
}
// The SendUserMessage tool_result — the structured output rides `toolUseResult`
// (what the renderer reads as output.message), the content block links the id.
function briefResult(parent: string, tuId: string, t: number): Line {
  return common({
    parentUuid: parent, type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuId, content: 'Message delivered to user.' }] },
    toolUseResult: { message: OPERATOR_MSG, sentAt: TS(t) },
    uuid: uuid(), timestamp: TS(t),
  })
}

function buildSession(): string {
  const lines: Line[] = []
  let prev: string | null = null
  const push = (l: Line) => { lines.push(l); prev = l.uuid as string }
  push(operator(prev, 'How is the refactor going?', 1))
  const tu = 'toolu_00000000000000000048'
  push(scribeDouble(prev!, tu, 2))
  push(briefResult(prev!, tu, 3))
  const path = join(PROJECTS, `${SID}.jsonl`)
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

function shoot(cell: string, cols: number, env: Record<string, string>): string {
  const out = `/tmp/doublefix-${cell}-${cols}.html`
  // total = the vshot capture window (boot + resume-render). 16s, not 10: under heavy
  // concurrent load the boot is slow and a 10s window caught the screen mid-boot (a
  // false-fail in a busy green-gate run). Headroom keeps the render-verify non-flaky.
  const cfg = { argv: ['node', BIN, '--resume', SID], sends: [], total: 16, cols, rows: 44, out, title: `doublefix ${cell} @ ${cols}` }
  const cfgPath = `/tmp/vshot-df-${cell}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', env: { ...process.env, ...env }, timeout: vshotBudgetMs(30000) })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

const baseEnv = {}
// BRIEF: a plain fork brief session (no scribe role) — SendUserMessage is enabled, so its
// recorded result renders and the redundant text is dropped (the dedup → one row).
const briefEnv = { ...baseEnv, MERCURY_SCRIBE_CHATROOM: '0' }
// CHATROOM: a scribe chatroom session — Brief is KEPT, dropText disabled (should-fix c).
const chatEnv = { ...baseEnv, MERCURY_SCRIBE: '1', MERCURY_SCRIBE_BUS_LIVE: '0', MERCURY_AMANUENSIS: '0', MERCURY_SCRIBE_CHATROOM: '1' }

console.log('============================================================')
console.log(' Double-fix render-verify ([text, SendUserMessage] → rows)')
console.log('============================================================')

buildSession()
const results: Record<string, string> = {}
for (const cols of [80, 120]) {
  results[`BRIEF-${cols}`] = shoot('BRIEF', cols, briefEnv)
  results[`CHATROOM-${cols}`] = shoot('CHATROOM', cols, chatEnv)
}

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sentinel = (s: string) => s.replace(/\s+/g, ' ')
for (const cols of [80, 120]) {
  const brief = sentinel(results[`BRIEF-${cols}`]!)
  const chat = sentinel(results[`CHATROOM-${cols}`]!)
  console.log(`\n── @ ${cols} cols ──`)
  // BRIEF: the SendUserMessage content shows; the redundant assistant text is DROPPED → ONE row.
  expect('BRIEF: the SendUserMessage operator line renders', /OPERATORFACINGLINE/.test(brief))
  expect('BRIEF: the redundant assistant text is DROPPED (dedup → one row, no double)', !/REDUNDANTWORKINGNOTES/.test(brief))
  // CHATROOM (should-fix c): the Scribe's typed text is KEPT (no silent loss) — BOTH render.
  expect('CHATROOM: the SendUserMessage line renders', /OPERATORFACINGLINE/.test(chat))
  expect('CHATROOM: the Scribe typed text is KEPT (dropText disabled in chatroom)', /REDUNDANTWORKINGNOTES/.test(chat))
}

try { rmSync(join(PROJECTS, `${SID}.jsonl`)) } catch { /* already gone */ }
console.log('\nHTML written to /tmp/doublefix-{BRIEF,CHATROOM}-{80,120}.html')
console.log(failures === 0 ? '\n✅ DOUBLE-FIX RENDER-VERIFY PASS' : `\n❌ ${failures} RENDER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
