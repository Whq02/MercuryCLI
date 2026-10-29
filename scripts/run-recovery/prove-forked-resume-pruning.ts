#!/usr/bin/env bun
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
const forkFirst = fx.deadUuids.filter((_, i) => i % 4 === 0)
const forkRest = fx.deadUuids.filter((_, i) => i % 4 !== 0)
check('no dead row beyond the first of its fork reaches the conversation', !forkRest.some(u => uuidCount.has(u)))
check("the first row of each fork — a tool_result under a live assistant — lands once, exactly as the full load's chain builder recovers it (its rule keys by parent alone; the wire strips such an orphan)", forkFirst.every(u => uuidCount.get(u) === 1), String(forkFirst.filter(u => uuidCount.get(u) !== 1).length))
const flat = JSON.stringify(messages)
check('the live tail text is intact', flat.includes(fx.liveTailText))
check('no dead-branch content beyond the recovered rows survives', !/dead branch \d+\/[123]:/.test(flat))
check(
  'the conversation is O(live chain) plus one recovered row per fork, never the dead majority',
  messages.length >= fx.liveUuids.length && messages.length <= fx.liveUuids.length + forkFirst.length + 4,
  String(messages.length),
)
{
  const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
  const { buildConversationChain } = await import('../../src/utils/sessionStorage/chain.ts')
  const full = await loadTranscriptFile(fx.path, { keepAllLeaves: true })
  const tail = fx.liveUuids[fx.liveUuids.length - 1]!
  const fullChain = buildConversationChain(full.messages, full.messages.get(tail as never)!).map(m => m.uuid)
  check('THE LAW: the resume over the big-file road equals the full-load chain, uuid for uuid', JSON.stringify(fullChain) === JSON.stringify(messages.map(m => m.uuid)), `full=${fullChain.length} resumed=${messages.length}`)
}

console.log(failures === 0 ? '\n ✅ FORKED RESUME PRUNING PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
