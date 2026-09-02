#!/usr/bin/env bun
// ============================================================================
//  prove-ptl-recovery-road — the refusal a compaction gives when its retries
//  are exhausted names a road this build can take (release-hardening audit
//  rank 72).
//
//  The lie: "This conversation has outgrown one pass. Press esc twice to
//  step up a few messages, then try again." Pressing esc twice opens the
//  message selector; its summarise action closes it with a notification
//  that summarising a stretch is not available for a managed session
//  (REPL.tsx refuses the session rewrite unconditionally, and
//  partialCompactConversation has no caller in this build). The instructed
//  recovery could not be performed; the operator's only remaining option
//  was to discard the conversation — at exactly the moment they were at
//  the window limit trying to get back under it.
//
//    L1 the sentence never points at the refused road
//    L2 it names roads that exist: /clear, a larger-window model, /compact
//    L3 the refused road is still refused — the why of the re-wording
//       (source pin)
//    L4 the stable key the overflow presenter reads still leads
//
//  PROVE_SRC names another checkout's src (the A/B control: L1 and L2 read
//  red at the pre-fix tree).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { ERROR_MESSAGE_PROMPT_TOO_LONG } = await import(join(SRC, 'services/compact/compact.ts'))
const text = String(ERROR_MESSAGE_PROMPT_TOO_LONG)

console.log('L1 never the refused road')
check('no "esc twice"', !/esc twice/i.test(text), text)
check('no "step up a few messages"', !/step up/i.test(text), text)

console.log('L2 roads that exist')
check('/clear is named', text.includes('/clear'), text)
check('a larger context window (a model switch) is named', /larger context window/i.test(text), text)
check('/compact is named', text.includes('/compact'), text)
check('the sentence says what happened (the summariser itself was refused)', /summariser itself was refused/i.test(text), text)

console.log('L3 the refused road is still refused (the why)')
{
  const repl = readFileSync(join(SRC, 'screens/REPL.tsx'), 'utf8')
  check("the message selector's summarise action refuses the session rewrite", repl.includes("refuseSessionRewrite('summarising a stretch of the conversation')"))
}

console.log('L4 the stable key still leads')
check('the sentence still opens with the outgrown-one-pass key the presenter tests', text.startsWith('This conversation has outgrown one pass'), text)

console.log(failures === 0 ? '\nprove-ptl-recovery-road: ALL PASS' : `\nprove-ptl-recovery-road: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
