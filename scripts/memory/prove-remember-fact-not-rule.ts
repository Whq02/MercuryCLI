#!/usr/bin/env bun

import { proofHome } from '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

void proofHome
const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const { RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')
const { RECORD_CONVENTION_DESCRIPTION } = await import('../../src/tools/RecordConventionTool/prompt.ts')
const { unansweredConventionNote, UNANSWERED_ASK, RecordConventionTool } = await import('../../src/tools/RecordConventionTool/RecordConventionTool.ts')
const { settleUnansweredAsk } = await import('../../src/cli/headless/runnerAsks.ts')

console.log('\n§1 the Retain prompt: a plain "remember:" is a fact; the pin needs words that ask for a standing rule')
const pinLine = RETAIN_PROMPT.split('\n').find(line => line.includes('pin: true')) ?? ''
check('the pin line exists', pinLine !== '', RETAIN_PROMPT)
check('the pin line no longer lists "remember: …" among the words that pin', !pinLine.includes('"remember: …"'), pinLine)
check('the pin line names the standing-rule words', ['"always …"', '"from now on …"', '"every session"', '"keep this as a rule"'].every(words => pinLine.includes(words)), pinLine)
check('the pin line says a plain "remember: <a fact>" is a fact stored without pin', pinLine.includes('A plain "remember: <a fact>" is a fact, not a rule: store it without pin; the pin needs words that ask for a standing rule.'), pinLine)
check('the pin line still forbids a pin on the model\'s own judgement', pinLine.includes('Never pin on your own judgement.'), pinLine)
check('the RecordConvention description still sends a remembered rule to Retain with pin, never to the estate', RECORD_CONVENTION_DESCRIPTION.includes('that is pinned memory (Retain with pin)'), RECORD_CONVENTION_DESCRIPTION)
const mneme = readFileSync(join(REPO, 'docs', 'MNEME.md'), 'utf8')
check('the manual\'s example of a remembered rule carries a standing-rule word', /"remember: always …"/.test(mneme), mneme.split('\n').find(l => l.includes('remember:')) ?? '')

console.log('\n§2 RecordConvention: an ask that reaches nobody settles on the safe side — nothing written, the ask named')
const rule = 'tests run with the wrapper script'
const ask = { behavior: 'ask' as const, message: 'Permission to write to /work/project/MERCURY.md has not been granted.' }
const settled = settleUnansweredAsk(RecordConventionTool, { rule }, ask)
check('the tool names its safe side: the ask settles as an allow that carries the ask on the call input', settled.behavior === 'allow' && (settled as { updatedInput?: Record<string, unknown> }).updatedInput?.[UNANSWERED_ASK] === ask.message && (settled as { updatedInput?: Record<string, unknown> }).updatedInput?.rule === rule, JSON.stringify(settled))
check('the settle says why in its reason', settled.behavior === 'allow' && /no one can answer the ask to write .*MERCURY\.md; the convention is not recorded and the result says so/.test(JSON.stringify(settled.decisionReason)), JSON.stringify(settled))
const plainAsk = settleUnansweredAsk({}, { rule }, ask)
check('a tool with no safe side keeps its ask (and is refused as before)', plainAsk === ask)
const allow = { behavior: 'allow' as const, updatedInput: { rule } }
check('an answered decision is never touched', settleUnansweredAsk(RecordConventionTool, { rule }, allow) === allow)
const note = unansweredConventionNote(rule, '/work/project/MERCURY.md')
check('the note says nothing was written and what Mercury would have asked', /^Not recorded — /.test(note) && note.includes(`would have asked permission to write "${rule}" into /work/project/MERCURY.md`) && note.includes('Tell the user the convention was not recorded') && note.includes('--allowed-tools RecordConvention'), note)
check('the tool\'s output schema knows the not-recorded action', RecordConventionTool.outputSchema.safeParse({ action: 'not-recorded', detail: note }).success)

console.log(failures === 0 ? '\n✅ A PLAIN "remember:" IS A FACT; AN ASK NOBODY ANSWERS RECORDS NOTHING' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
