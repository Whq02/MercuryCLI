#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { ERROR_MESSAGE_PROMPT_TOO_LONG } = await import(join(SRC, 'engine/compaction/foldConversation.ts'))
const text = String(ERROR_MESSAGE_PROMPT_TOO_LONG)

console.log('L1 never the refused road')
check('no "esc twice"', !/esc twice/i.test(text), text)
check('no "step up a few messages"', !/step up/i.test(text), text)

console.log('L2 roads that exist')
check('/clear is named', text.includes('/clear'), text)
check('a larger context window (a model switch) is named', /larger context window/i.test(text), text)
check('/compact is named', text.includes('/compact'), text)
check('the sentence names the cause without narrating the summariser', text.includes('too much context') && !text.includes('summariser itself'), text)

console.log('L3 the refused road is still refused (the why)')
{
  const { openSelectorPart } = await import('../ui/chatScenarios.ts')
  const selector = await openSelectorPart('ptl-recovery-selector')
  await selector.selector().onSummarize()
  const refusal = selector.notices.find(notice => notice.key === 'session-rewrite')
  const asked = selector.session.calls.length
  await selector.close()
  check("the message selector's summarise action refuses the session rewrite", refusal !== undefined && refusal.text.startsWith('summarising a stretch of the conversation acts on the session') && asked === 0, `${refusal?.text ?? 'no notice'} · ${asked} calls on the session`)
}

console.log('L4 the stable key still leads')
check('the sentence opens with its stable key (the conversation could not be compacted) and never claims a retry count the ladder no longer has', text.startsWith('This conversation could not be compacted') && !/three narrowing retries/.test(text), text)

console.log(failures === 0 ? '\nprove-ptl-recovery-road: ALL PASS' : `\nprove-ptl-recovery-road: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
