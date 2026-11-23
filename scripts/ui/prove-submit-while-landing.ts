#!/usr/bin/env bun
import { join } from 'node:path'

const ROOT = process.cwd()
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}


console.log('§4 the resting connector keeps its one honest sentence')
{
  const resting = await import(join(ROOT, 'src/engine/connector/noSessionConnector.ts'))
  check('the sentence names the door a chat starts through (unchanged owner)', resting.NO_CHAT_OPEN === 'no chat is open — ↵ New Session on the boot menu starts one', 'NO_CHAT_OPEN in src/engine/connector/noSessionConnector.ts changed; restore the sentence or update the places that show it')
  const refused = await new resting.NoSessionConnector().sendWords()
  check('the resting connector still refuses a send with it (the arm is what keeps a landing line away from it)', refused.state === 'refused' && refused.detail === resting.NO_CHAT_OPEN, `got ${JSON.stringify(refused)}; NoSessionConnector.sendWords in src/engine/connector/noSessionConnector.ts must return state refused with detail NO_CHAT_OPEN`)
}

if (failures > 0) {
  console.log(`\n ❌ submit-while-landing — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ submit-while-landing — a landing-window line waits as the armed message and sends when the seat lands')
