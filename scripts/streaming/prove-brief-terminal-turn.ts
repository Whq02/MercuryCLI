#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-brief-terminal-turn.ts — #64 rooms-layer double-reply.
//
//  A solo-session conversational reply rides SendUserMessage (BriefTool).
//  Before the fix, that tool_use left needsFollowUp true (query.ts) so the
//  loop recursed into a SECOND /v1/messages call with nothing to do
//  ("Standing by…") — 2 billed API calls on EVERY conversational turn.
//  The fix ends a Brief-terminal turn (all tool uses are Brief, results
//  settled clean) at the recursion seam, after the tool result lands.
//
//  App-scale oracle (artifactArena — the SHIPPED dist against the fixture):
//    B1 precondition: brief is LIVE in a default interactive boot — the
//       first request's tool list carries SendUserMessage.
//    B2 conversational turn ⇒ exactly ONE /v1/messages request (the bug's
//       signature is a 2nd request carrying the same user prompt).
//    B3 the reply actually painted — the turn ended AFTER delivery, not
//       before it.
//    B4 the scripted second turn (the "Standing by" filler) was never
//       requested nor rendered.
//    B5 the Brief tool_use has its tool_result recorded in the session
//       transcript — the turn ended after the result SETTLED (a turn cut
//       at the needsFollowUp declaration would strand the pair and 400
//       the next call).
//    B6 the post-hoc brief-stop hook (kept live) recognized the Brief call
//       — neither the enforce sentinel nor the recap sentinel polluted the
//       transcript on the new end-turn path.
// ============================================================================

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
  // Both turns are pinned to the MAIN model: the same submit fires a
  // small-model side call (the session title), which must never eat the
  // scripted turn nor count as the turn's request.
  turns: [
    {
      kind: 'tool_use',
      name: 'SendUserMessage',
      input: { message: BRIEF_MESSAGE, status: 'normal' },
      whenModel: 'opus',
    },
    // Only consumed if the loop makes the buggy second call.
    { kind: 'text', text: SECOND_CALL_SENTINEL, whenModel: 'opus' },
  ],
  sends: [`4500:${PROMPT_TOKEN}`, '5300:\\r'],
  seconds: 12,
  keep: true,
  // Brief is AWAY-SCOPED since (interactive desktop sessions
  // reply as plain text) — this proof tests the brief-terminal ONE-CALL
  // contract, so it pins the courier ON explicitly, exactly like the away
  // contexts (daemon fires) do.
  extraEnv: { MERCURY_BRIEF: '1' },
})

// The turn's requests are the MAIN model's; the small-model side call the
// submit also fires (the session title) is its own law, not this one.
const msgReqs = run.fixture
  .messageRequests()
  .filter(r => String((r.body as { model?: unknown }).model ?? '').includes('opus'))

// B1 — brief pinned ON for this arena (away-scope contract): tool list has
// the tool.
const firstBody = msgReqs[0]?.body as
  | { tools?: { name: string }[] }
  | undefined
const briefInTools = (firstBody?.tools ?? []).some(
  t => t.name === 'SendUserMessage' || t.name === 'Brief',
)
check('B1 SendUserMessage in the first request tool list', briefInTools, `tools=${(firstBody?.tools ?? []).length}`)

// B2 — the core contract: one conversational turn, one /v1/messages request.
const turnReqs = msgReqs.filter(r => JSON.stringify(r.body).includes(PROMPT_TOKEN))
check(
  'B2 exactly ONE /v1/messages request for the turn',
  msgReqs.length === 1 && turnReqs.length === 1,
  `total=${msgReqs.length} carrying-prompt=${turnReqs.length}`,
)

// B3 — the reply painted before the turn ended.
const allVisible = visibleText(run.teeLines.map(t => t.content ?? '').join(''))
check('B3 brief reply rendered', allVisible.includes('roomslayer'), 'reply text not painted')

// B4 — the filler turn was never served nor painted.
check(
  'B4 no phantom second reply',
  !allVisible.includes('SECOND-CALL-SENTINEL') &&
    !msgReqs.some(r => JSON.stringify(r.body).includes('SECOND-CALL-SENTINEL')),
)

// B5/B6 — transcript forensics: pairing intact, no stop-hook nag pollution.
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
    // legacy lines spell tool_result; vNext records spell kind:'tool-result'
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
