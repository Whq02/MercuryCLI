#!/usr/bin/env bun
// ============================================================================
//  scripts/run-recovery/prove-forked-resume-pruning.ts — the RESUME surface
//  over a heavily forked transcript: loadConversationForResume rebuilds the
//  LIVE thread whole (every live row exactly once, the tail intact) while
//  the dead fork branches — pruned at the byte level before the parse —
//  never reach the conversation.
//
//  Fixture: REAL record JSONL through the writer's own encoder, >5MB with
//  a dead-branch byte majority (scripts/sessionStorage/forkedFixture.ts —
//  the same builder the fold-equality prover drives).
//
//  Hermetic: scratch MERCURY_CONFIG_DIR from mkdtemp before any src import,
//  scratch cwd, no network, no PTY, no live providers.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'forked-resume-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'forked-resume-'))
process.chdir(scratch)

import { writeForkedFixture } from '../sessionStorage/forkedFixture.ts'

const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('forked-resume pruning — the live thread resumes whole, the dead majority never loads')

const fx = await writeForkedFixture({
  path: join(scratch, 'f0f0f0f0-1111-4000-8000-000000000001.jsonl'),
  turns: 300,
  forkEvery: 3,
  deadPerFork: 4,
  deadFatBytes: 16 * 1024,
})

const loaded = await loadConversationForResume('forked-fixture', fx.path)
check('the forked session resumes (never a refusal, never a crash)', loaded !== null)
const messages = (loaded?.messages ?? []) as Array<{ uuid?: string }>
const uuidCount = new Map<string, number>()
for (const m of messages) {
  if (typeof m.uuid === 'string') uuidCount.set(m.uuid, (uuidCount.get(m.uuid) ?? 0) + 1)
}
check(
  `every LIVE row lands exactly once (${fx.liveUuids.length})`,
  fx.liveUuids.every(u => uuidCount.get(u) === 1),
  fx.liveUuids.filter(u => uuidCount.get(u) !== 1).slice(0, 3).join(','),
)
check('no DEAD row reaches the conversation', !fx.deadUuids.some(u => uuidCount.has(u)))
const flat = JSON.stringify(messages)
check('the live tail text is intact', flat.includes(fx.liveTailText))
check('no dead-branch content survives', !flat.includes('dead branch '))
check(
  'the conversation is O(live chain), never the dead majority',
  messages.length >= fx.liveUuids.length && messages.length <= fx.liveUuids.length + 4,
  String(messages.length),
)

console.log(failures === 0 ? '\n ✅ FORKED RESUME PRUNING PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
