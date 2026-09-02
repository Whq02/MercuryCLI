#!/usr/bin/env bun
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
