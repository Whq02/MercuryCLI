#!/usr/bin/env bun
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { serializeScribeEnvelope, buildProgress, buildDispatch } from '../../src/utils/scribe/scribeBus.js'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
const PROJECTS = join(
  process.env.HOME!,
  '.claude',
  'projects',
  sanitizePath(RUNTIME_CWD),
)
const VSHOT = new URL('../ui/vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')

const SID = '00000000-aaaa-bbbb-cccc-000000000047'
const TS = (s: number) => `2026-06-19T10:00:0${s}.000Z`
let u = 0
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`

type Line = Record<string, unknown>
const common = (extra: Line): Line => ({
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: RUNTIME_CWD,
  sessionId: SID,
  version: '1.0.0-beta.1',
  gitBranch: 'main',
  ...extra,
})

function operator(parent: string | null, text: string, t: number): Line {
  return common({
    parentUuid: parent,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid(),
    timestamp: TS(t),
  })
}
function scribe(parent: string, text: string, t: number): Line {
  return common({
    parentUuid: parent,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: `msg_${uuid()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    uuid: uuid(),
    timestamp: TS(t),
  })
}
function implementer(parent: string, envelopeJson: string, t: number): Line {
  return common({
    parentUuid: parent,
    type: 'user',
    message: {
      role: 'user',
      content: `<teammate-message teammate_id="implementer">\n${envelopeJson}\n</teammate-message>`,
    },
    uuid: uuid(),
    timestamp: TS(t),
  })
}

function buildSession(withReply: boolean): string {
  const lines: Line[] = []
  let prev: string | null = null
  const push = (l: Line) => {
    lines.push(l)
    prev = l.uuid as string
  }
  push(operator(prev, 'Refactor the parser — tokenizer first, keep the existing tests green.', 1))
  push(scribe(prev!, 'On it — splitting the tokenizer out first and keeping the parser tests green.', 2))
  if (withReply) {
    const prog = serializeScribeEnvelope(
      buildProgress('implementer', 'done', { detail: 'tokenizer split into src/parser/tokenizer.ts; parser tests green (42 passing).' }),
    )
    push(implementer(prev!, prog, 3))
    push(scribe(prev!, 'Nice — now fold the AST builder onto the new tokens.', 4))
  }
  const disp = serializeScribeEnvelope(buildDispatch('scribe', 'Fold the AST builder onto the new tokens.', { title: 'AST builder' }))
  void disp

  const path = join(PROJECTS, `${SID}.jsonl`)
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

function shoot(cell: string, cols: number, env: Record<string, string>): string {
  const out = `/tmp/chatroom-${cell}-${cols}.html`
  const cfg = {
    argv: ['node', BIN, '--resume', SID],
    sends: [],
    total: 16,
    cols,
    rows: 44,
    out,
    title: `chatroom ${cell} @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-${cell}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

const baseEnv = {
  MERCURY_SCRIBE: '1',
  MERCURY_OPERATOR: 'sam',
  MERCURY_SCRIBE_BUS_LIVE: '0',
  MERCURY_AMANUENSIS: '0',
}

console.log('============================================================')
console.log(' #47 chatroom render-verify (synthetic session → vshot)')
console.log('============================================================')

buildSession(true)
const results: Record<string, string> = {}
for (const cols of [80, 120]) {
  results[`ON-${cols}`] = shoot('ON', cols, { ...baseEnv, MERCURY_SCRIBE_CHATROOM: '1' })
  results[`OFF-${cols}`] = shoot('OFF', cols, { ...baseEnv, MERCURY_SCRIBE_CHATROOM: '0' })
}

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
for (const cols of [80, 120]) {
  const on = results[`ON-${cols}`]!
  const off = results[`OFF-${cols}`]!
  console.log(`\n── @ ${cols} cols ──`)
  expect(`ON: the Implementer is VISIBLE ([Mercury-Implement] nameplate)`, /Mercury-Implement/.test(on))
  expect(`ON: the Implementer's REAL body renders`, /tokenizer split/.test(on))
  expect(`ON: the Scribe nameplates ([Mercury-Amanuensis])`, /Mercury-Amanuensis/.test(on))
  expect(`ON: the operator nameplates ([sam])`, /\[sam\]/.test(on))
  expect(`OFF: the scribe_protocol envelope is DROPPED (0 [Mercury-Implement])`, !/Mercury-Implement/.test(off))
  expect(`OFF: the Scribe still nameplates`, /Mercury-Amanuensis/.test(off))
}

try {
  rmSync(join(PROJECTS, `${SID}.jsonl`))
} catch {
}

console.log('\nHTML written to /tmp/chatroom-{ON,OFF}-{80,120}.html')
console.log(failures === 0 ? '\n✅ CHATROOM RENDER-VERIFY PASS (4 cells)' : `\n❌ ${failures} RENDER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
