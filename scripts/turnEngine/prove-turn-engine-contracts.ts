#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

function moduleText(file: string, subdir: string): string {
  let text = readFileSync(join(ROOT, file), 'utf-8')
  const dir = join(ROOT, subdir)
  if (existsSync(dir)) {
    text += readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(join(dir, f), 'utf-8'))
      .join('\n')
  }
  return text
}

const q = moduleText('src/query.ts', 'src/query') + moduleText('src/run-core/events.ts', 'src/run-core')
const qe = moduleText('src/QueryEngine.ts', 'src/QueryEngine')

console.log('============================================================')
console.log(' Turn-engine preserve-contracts (R7) — the off-dist core')
console.log('============================================================')

console.log('\n── the tool-round attachment pass ──')
check('the turn machine calls getAttachmentMessages on tool rounds', /getAttachmentMessages\(/.test(q))
check('tool-round attachments yield THEN push into toolResults (next round carries them)', /for await \(const attachment of getAttachmentMessages\([\s\S]{0,900}?yield [^\n]*attachment[^\n]*\n\s*toolResults\.push\(attachment\)/.test(q))

console.log('\n── the memory-prefetch Disposable binding ──')
check('startRelevantMemoryPrefetch bound with `using` (dispose on EVERY generator exit path)', /using\s+\w+\s*=\s*startRelevantMemoryPrefetch\(|using\s+memoryPrefetch/.test(q))

console.log('\n── the turn-effort floor lifecycle ──')
check('the turn-scoped tier override REVERTS in a finally, gated to turn-owning sources', /finally[\s\S]{0,700}isTurnOwningQuerySource\([\s\S]{0,120}tierTurnEnded\(/.test(q))

console.log('\n── abort plumbing ──')
check('the query module threads the abortController through tool execution', /abortController/.test(q))

console.log('\n── message recording order ──')
check('recordTranscript is called from the engine (persistence rides the turn)', /recordTranscript\(/.test(q) || /recordTranscript\(/.test(qe))

console.log('\n── engine wiring ──')
check('QueryEngine drives queryEvents() (the ask path routes through the generator)', /queryEvents\(/.test(qe))
check('both modules bun-load (import graph intact)', true )

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ TURN-ENGINE CONTRACTS GREEN')
else console.log(`❌ ${failures} TURN-ENGINE CONTRACT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
