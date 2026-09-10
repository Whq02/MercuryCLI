#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { requireDist, runArtifactArena, visibleText } from './artifactArena.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── #64 brief-terminal turn = ONE API call (shipped artifact) ──')
requireDist()

const BRIEF_MESSAGE = 'Reply landed on the rooms layer.'
const SECOND_CALL_SENTINEL = 'SECOND-CALL-SENTINEL standing by.'
const PROMPT_TOKEN = 'hello64'

const run = await runArtifactArena({
  turns: [
    {
      kind: 'tool_use',
      name: 'SendUserMessage',
      input: { message: BRIEF_MESSAGE, status: 'normal' },
      whenModel: 'opus',
    },
    { kind: 'text', text: SECOND_CALL_SENTINEL, whenModel: 'opus' },
  ],
  sends: [`4500:${PROMPT_TOKEN}`, '5300:\\r'],
  seconds: 12,
  keep: true,
  extraEnv: { MERCURY_BRIEF: '1' },
})

const msgReqs = run.fixture
  .messageRequests()
  .filter(r => String((r.body as { model?: unknown }).model ?? '').includes('opus'))

const firstBody = msgReqs[0]?.body as
  | { tools?: { name: string }[] }
  | undefined
const briefInTools = (firstBody?.tools ?? []).some(
  t => t.name === 'SendUserMessage' || t.name === 'Brief',
)
check('B1 SendUserMessage in the first request tool list', briefInTools, `tools=${(firstBody?.tools ?? []).length}`)

const turnReqs = msgReqs.filter(r => JSON.stringify(r.body).includes(PROMPT_TOKEN))
check(
  'B2 exactly ONE /v1/messages request for the turn',
  msgReqs.length === 1 && turnReqs.length === 1,
  `total=${msgReqs.length} carrying-prompt=${turnReqs.length}`,
)

const allVisible = visibleText(run.teeLines.map(t => t.content ?? '').join(''))
check('B3 brief reply rendered', allVisible.includes('roomslayer'), 'reply text not painted')

check(
  'B4 no phantom second reply',
  !allVisible.includes('SECOND-CALL-SENTINEL') &&
    !msgReqs.some(r => JSON.stringify(r.body).includes('SECOND-CALL-SENTINEL')),
)

function readTranscripts(root: string): string {
  let all = ''
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (e.endsWith('.jsonl')) all += readFileSync(p, 'utf8')
    }
  }
  return all
}
const transcripts = readTranscripts(run.paths.home)
function sessionTranscripts(root: string): string[] {
  const found: string[] = []
  const stack = [join(root, '.claude', 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (/^[0-9a-f-]{36}\.jsonl$/.test(e)) found.push(p)
    }
  }
  return found
}
type ToolPairing = { useSessions: string[]; resultSessions: string[]; resultCallIds: string[]; paired: boolean }
function toolPairing(files: string[], callId: string): ToolPairing {
  const useSessions: string[] = []
  const resultSessions: string[] = []
  const resultCallIds: string[] = []
  for (const file of files) {
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    let sawUse = false
    let sawResult = false
    for (const line of rows) {
      let rec: { sessionId?: string; payload?: { kind?: string; content?: unknown } }
      try {
        rec = JSON.parse(line) as typeof rec
      } catch {
        continue
      }
      const blocks = Array.isArray(rec.payload?.content) ? (rec.payload!.content as Array<{ kind?: string; callId?: string; type?: string; id?: string; tool_use_id?: string }>) : []
      for (const b of blocks) {
        const isUse = (b.kind === 'tool-use' && b.callId === callId) || (b.type === 'tool_use' && b.id === callId)
        const isResult = b.kind === 'tool-result' || b.type === 'tool_result'
        if (isUse) sawUse = true
        if (isResult) {
          const id = b.callId ?? b.tool_use_id ?? ''
          resultCallIds.push(id)
          if (id === callId) sawResult = true
        }
      }
    }
    if (sawUse) useSessions.push(file)
    if (sawResult) resultSessions.push(file)
  }
  const paired = useSessions.length === 1 && resultSessions.length === 1 && useSessions[0] === resultSessions[0]
  return { useSessions, resultSessions, resultCallIds, paired }
}
const sessionFiles = sessionTranscripts(run.paths.home)
const pairing = toolPairing(sessionFiles, 'toolu_fixture_1')
check('B5 exactly ONE session transcript carries the brief tool use', pairing.useSessions.length === 1, `${pairing.useSessions.length} of ${sessionFiles.length} session file(s)`)
check(
  'B5 brief tool_result settled in the transcript',
  transcripts.includes('toolu_fixture_1') &&
    (transcripts.includes('tool_result') || transcripts.includes('"kind":"tool-result"')),
)
check('B5 …and the tool-result naming THAT call id sits in the SAME session transcript as the use (pairing, not co-occurrence across files)', pairing.paired, `use in ${pairing.useSessions.map(f => f.split('/').pop())}, result in ${pairing.resultSessions.map(f => f.split('/').pop())}, result ids ${JSON.stringify(pairing.resultCallIds)}`)
{
  const scratch = join(run.paths.home, 'b5-control')
  const { mkdirSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(scratch, { recursive: true })
  const row = (sessionId: string, payload: unknown): string => JSON.stringify({ schemaVersion: 1, sessionId, payload }) + '\n'
  const a = join(scratch, '11111111-1111-4111-8111-111111111111.jsonl')
  const b = join(scratch, '22222222-2222-4222-8222-222222222222.jsonl')
  writeFileSync(a, row('a', { kind: 'output', content: [{ kind: 'tool-use', callId: 'toolu_ctrl', name: 'X', input: {} }] }))
  writeFileSync(b, row('b', { kind: 'input', content: [{ kind: 'tool-result', callId: 'toolu_ctrl', body: 'ok' }] }))
  const split = toolPairing([a, b], 'toolu_ctrl')
  check('B5 control: a use in one session and its result in ANOTHER is NOT paired (the raw whole-home scan would have accepted it)', !split.paired && split.useSessions.length === 1 && split.resultSessions.length === 1 && split.useSessions[0] !== split.resultSessions[0])
  writeFileSync(a, row('a', { kind: 'output', content: [{ kind: 'tool-use', callId: 'toolu_ctrl', name: 'X', input: {} }] }) + row('a', { kind: 'input', content: [{ kind: 'tool-result', callId: 'toolu_other', body: 'ok' }] }))
  const mismatched = toolPairing([a], 'toolu_ctrl')
  check('B5 control: a result in the same session naming a DIFFERENT call id is NOT paired', !mismatched.paired && mismatched.resultCallIds.join(',') === 'toolu_other')
  writeFileSync(a, row('a', { kind: 'output', content: [{ kind: 'tool-use', callId: 'toolu_ctrl', name: 'X', input: {} }] }))
  const missing = toolPairing([a], 'toolu_ctrl')
  check('B5 control: a use with NO result at all is NOT paired', !missing.paired && missing.resultSessions.length === 0)
  writeFileSync(a, row('a', { kind: 'output', content: [{ kind: 'tool-use', callId: 'toolu_ctrl', name: 'X', input: {} }] }) + row('a', { kind: 'input', content: [{ kind: 'tool-result', callId: 'toolu_ctrl', body: 'ok' }] }))
  check('B5 control: use and matching result in ONE session IS paired', toolPairing([a], 'toolu_ctrl').paired)
  rmSync(scratch, { recursive: true, force: true })
}
check(
  'B6 no brief-stop-hook sentinel pollution',
  !transcripts.includes('ended the turn without calling') &&
    !transcripts.includes('emitted plain text after your'),
)

run.cleanup()

if (failures > 0) {
  console.log(`❌ brief-terminal-turn: ${failures} failing`)
  process.exit(1)
}
console.log('✅ brief-terminal-turn GREEN')
