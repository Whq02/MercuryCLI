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
check(
  'B5 brief tool_result settled in the transcript',
  transcripts.includes('toolu_fixture_1') &&
    (transcripts.includes('tool_result') || transcripts.includes('"kind":"tool-result"')),
)
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
