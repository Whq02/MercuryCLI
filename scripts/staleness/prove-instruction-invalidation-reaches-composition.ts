#!/usr/bin/env bun
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-instr-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_BARE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}clearInstructionFileCaches in src/sessions/instructions/instructionFiles.ts must reach the getUserContext and getSystemContext memos in src/engine/requestContext.ts through the listener that armInstructionInvalidation registers` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


const project = realpathSync(mkdtempSync(join(tmpdir(), 'stale-instr-project-')))
const estate = join(project, 'MERCURY.md')
writeFileSync(estate, '# Project rules\n\nMARKER-ALPHA: the first estate.\n')
seedFirstRun(process.env.MERCURY_CONFIG_DIR, [project])
process.chdir(project)

console.log('the one instruction invalidation reaches the composed block')


const globalConfig = await import('../../src/platform/config/globalConfig.js')
globalConfig.enableConfigs()
const context = await import('../../src/engine/requestContext.js')
const engine = await import('../../src/sessions/instructions/instructionFiles.js')

section('§1 prime on estate A · move to B · invalidate through the one call · read B')
{
  const first = await context.getUserContext()
  const firstBlock = first.instructions ?? ''
  check('the composed block carries estate A (the memo primes from the walk)', firstBlock.includes('MARKER-ALPHA'), `keys: ${Object.keys(first).join(',')} block: ${firstBlock.slice(0, 80)}`)

  writeFileSync(estate, '# Project rules\n\nMARKER-BETA: the estate moved.\n')
  const stale = await context.getUserContext()
  check('control: with NO invalidation the memo answers A (a memo is a memo — this is the road every caller rides between turns)', (stale.instructions ?? '').includes('MARKER-ALPHA'))

  engine.clearInstructionFileCaches()
  const fresh = await context.getUserContext()
  const freshBlock = fresh.instructions ?? ''
  check('THE ONE INVALIDATION REACHES THE COMPOSED BLOCK: the next read carries B (the base kept answering A for the session\'s life)', freshBlock.includes('MARKER-BETA') && !freshBlock.includes('MARKER-ALPHA'), freshBlock.slice(0, 120))
  check('…and the discovery walk moved with it (the half the base already cleared)', (await engine.getInstructionFiles()).some(f => f.content.includes('MARKER-BETA')))
}

section('§2 the system-context memo (git status) clears at the same invalidation')
{
  await context.getSystemContext()
  const primed = context.getSystemContext.cache?.has?.(undefined) === true
  check('the system-context memo primes', primed)
  engine.clearInstructionFileCaches()
  check('…and is cleared by the one invalidation (a worktree entry moves the git facts too)', context.getSystemContext.cache?.has?.(undefined) === false)
  check('the user-context memo is cleared as well (an empty memo, not a stale one)', context.getUserContext.cache?.has?.(undefined) === false)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-instruction-invalidation-reaches-composition${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
