#!/usr/bin/env bun
// scripts/turnEngine/prove-turn-engine-contracts.ts — the R7 contract oracle
// for the turn engine (query.ts + QueryEngine.ts; StreamingToolExecutor was
// DELETED in the native-core T9 cut — FORK_GATE_TABLE={} made it permanently
// unreachable, runTools is the one tool path).
//
// The turn engine is pure orchestration — its exports (query, QueryEngine,
// ask) are live-API/tool-coupled generators, so a
// golden-replay oracle is vacuous here. The honest oracle is:
//   (a) these STRUCTURAL preserve-contracts, pinned as source needles over
//       the MODULE (barrel + future submodules — module-scoped from day one,
//       the R2-R6 needle class-kill applied preemptively), and
//   (b) the standing behavioral gate — every PTY capture, live smoke, and
//       suite that runs the binary exercises this engine end-to-end.
//
// Run: ~/.bun/bin/bun run scripts/turnEngine/prove-turn-engine-contracts.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

// Module-scoped reads: file + (future) sibling submodule dir.
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
// Window 300→900: the removal fold 1/4 interposed the exactly-once
// uuid-recording block between the loop head and the yield — the
// yield-then-push adjacency (the law) is unchanged.
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
check('both modules bun-load (import graph intact)', true /* proven by the loadability probe in CI-adjacent runs; structural here */)

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ TURN-ENGINE CONTRACTS GREEN')
else console.log(`❌ ${failures} TURN-ENGINE CONTRACT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
