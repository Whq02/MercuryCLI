#!/usr/bin/env bun
// ============================================================================
//  scripts/staleness/prove-instruction-invalidation-reaches-composition.ts —
//  the ONE instruction invalidation reaches the COMPOSED block the model
//  receives (FN-017 R2, S2: clearInstructionFileCaches did not reach the
//  composed instruction blob).
//
//  clearInstructionFileCaches() is the exported invalidation for the
//  instruction estate — EnterWorktree / ExitWorktree, the project writer
//  behind RecordConvention, the /memory dialog, settings sync all call it.
//  It cleared the memoized discovery walk only; the composed blocks
//  (src/context.ts getUserContext / getSystemContext) are memoized on their
//  own and nothing on that road cleared them, so a session that entered a
//  worktree kept sending the ORIGINAL tree's MERCURY.md as the binding
//  instruction block on every later turn while the environment block named
//  the worktree — and a convention the model was told it recorded never
//  entered the composed block for that session. The correct pairing lived
//  only at harnessGround.ts (a ground move); the four other call sites each
//  had to remember the second half, and none did.
//
//  The composition now OBSERVES the engine's invalidation (the shape
//  effectiveSize.ts already uses), so the one call covers the whole chain.
//
//   §0 the shape: context.ts observes; the call sites still call the ONE
//      invalidation (never a second lattice of paired clears)
//   §1 DRIVEN: prime the composed block on estate A, move the estate to B,
//      invalidate through the one exported call, read B (the base read A)
//   §2 DRIVEN: the system-context memo clears at the same invalidation
//
//  Run:  ~/.bun/bin/bun run scripts/staleness/prove-instruction-invalidation-reaches-composition.ts
// ============================================================================
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home BEFORE any src import (getMercuryHome memoizes the env);
// real config reads (NODE_ENV=test would short-circuit them onto test objects).
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-instr-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_SIMPLE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The repo root, captured BEFORE the chdir below — every source read is
// absolute from here on.
const repoRoot = process.cwd()

// The scratch project IS the prover's boot ground: chdir BEFORE the first
// src import — the session-identity owner resolves its cwd trio eagerly at
// module load, and the discovery walk starts from it.
const project = mkdtempSync(join(tmpdir(), 'stale-instr-project-'))
const estate = join(project, 'MERCURY.md')
writeFileSync(estate, '# Project rules\n\nMARKER-ALPHA: the first estate.\n')
process.chdir(project)

console.log('the one instruction invalidation reaches the composed block')

// ── §0 the shape ─────────────────────────────────────────────────────────────
section('§0 the composition observes the engine invalidation; the call sites call the ONE invalidation')
{
  const ctx = readFileSync(join(repoRoot, 'src/context.ts'), 'utf8')
  const at = ctx.indexOf('onInstructionCacheInvalidated(')
  check('context.ts subscribes to onInstructionCacheInvalidated', at > 0)
  const body = at > 0 ? ctx.slice(at, at + 400) : ''
  check('…and the observer clears BOTH composed memos (user + system context)', /getSystemContext\.cache\.clear\?\.\(\)/.test(body) && /getUserContext\.cache\.clear\?\.\(\)/.test(body), body.slice(0, 160))
  const engine = readFileSync(join(repoRoot, 'src/services/instructions/engine.ts'), 'utf8')
  check('the engine still owns the one exported invalidation (no import of the composition — the observer keeps the graph acyclic)', /export function clearInstructionFileCaches\(\)/.test(engine) && !/from '\.\.\/\.\.\/context\.js'/.test(engine))
  const callers: Array<[string, string]> = [
    ['src/tools/EnterWorktreeTool/EnterWorktreeTool.ts', 'EnterWorktree'],
    ['src/tools/ExitWorktreeTool/ExitWorktreeTool.ts', 'ExitWorktree'],
    ['src/services/instructions/projectInstructionWriter.ts', 'the project writer (RecordConvention)'],
    ['src/commands/memory/memory.tsx', 'the /memory dialog'],
  ]
  for (const [file, name] of callers) {
    const src = readFileSync(join(repoRoot, file), 'utf8')
    check(`${name} calls the ONE invalidation`, /clearInstructionFileCaches\(\)/.test(src))
    check(`…and does not hand-roll the composition clear (one owner, never four rememberings)`, !/getUserContext\.cache/.test(src), file)
  }
}

// ── the estate under drive ──────────────────────────────────────────────────
const globalConfig = await import('../../src/utils/config/globalConfig.js')
globalConfig.enableConfigs()
const context = await import('../../src/context.js')
const engine = await import('../../src/services/instructions/engine.js')

// ── §1 the composed block follows the invalidation ──────────────────────────
section('§1 prime on estate A · move to B · invalidate through the one call · read B')
{
  const first = await context.getUserContext()
  const firstBlock = first.claudeMd ?? ''
  check('the composed block carries estate A (the memo primes from the walk)', firstBlock.includes('MARKER-ALPHA'), `keys: ${Object.keys(first).join(',')} block: ${firstBlock.slice(0, 80)}`)

  writeFileSync(estate, '# Project rules\n\nMARKER-BETA: the estate moved.\n')
  const stale = await context.getUserContext()
  check('control: with NO invalidation the memo answers A (a memo is a memo — this is the road every caller rides between turns)', (stale.claudeMd ?? '').includes('MARKER-ALPHA'))

  // The ONE exported invalidation — the very call EnterWorktree, ExitWorktree,
  // the project writer and the /memory dialog make.
  engine.clearInstructionFileCaches()
  const fresh = await context.getUserContext()
  const freshBlock = fresh.claudeMd ?? ''
  check('THE ONE INVALIDATION REACHES THE COMPOSED BLOCK: the next read carries B (the base kept answering A for the session\'s life)', freshBlock.includes('MARKER-BETA') && !freshBlock.includes('MARKER-ALPHA'), freshBlock.slice(0, 120))
  check('…and the discovery walk moved with it (the half the base already cleared)', (await engine.getInstructionFiles()).some(f => f.content.includes('MARKER-BETA')))
}

// ── §2 the system-context memo clears at the same invalidation ──────────────
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
