#!/usr/bin/env bun
// ============================================================================
//  prove-drain-fault-isolation — one unwritable transcript file never holds
//  the rest of the session's persistence hostage (release-hardening audit
//  rank 57).
//
//  The starvation: the writer's drain walked its per-file queues in
//  insertion order and RETHREW at the first append failure, exiting the
//  loop — every file whose queue sat after the failing one stopped
//  persisting for as long as the fault lasted, silently. A wedged sidechain
//  (an agent whose worktree was removed under it) starved every later
//  agent's transcript; a wedged session file starved every sidechain. The
//  failing entry kept a non-empty queue, so every pass reached it first and
//  threw at the same point, and the delete sweep was skipped.
//
//    L1 a poisoned session file ahead of a healthy sidechain: the sidechain
//       lands on the same drain, the flush still reports the failure
//    L2 two poisoned files ahead of a healthy one: the healthy one lands,
//       the aggregate names both failures
//    L3 the heal: once the poison lifts, the requeued lines land and the
//       failing fact clears
//
//  PROVE_SRC names another checkout's src (the A/B control: L1 and L2 read
//  red at the pre-fix tree — the later files starve).
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const SCRATCH = mkdtempSync(join(tmpdir(), 'drain-isolation-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const writer = await import(join(SRC, 'utils/sessionStorage/writer.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')
// A DIRECTORY where a .jsonl belongs: EISDIR on every append — the same
// road as a held file, disk-full or a removed worktree.
const poison = (p: string): void => mkdirSync(join(p, 'block'), { recursive: true })
const tag = (words: string): never => ({ type: 'tag', tag: words, sessionId: 'drain-isolation' }) as never
const sidechain = (agentId: string): never =>
  ({ type: 'content-replacement', sessionId: 'drain-isolation', agentId, replacements: [] }) as never
const flush = async (): Promise<string | null> => {
  try {
    await writer.flushSessionStorage()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const session = join(SCRATCH, 'session.jsonl')
poison(session)
writer.setSessionFileForTesting(session)
const project = writer.getProject()

// ── L1 ───────────────────────────────────────────────────────────────────────
console.log('L1 a poisoned session file ahead of a healthy sidechain')
const chainA = join(SCRATCH, 'agents', 'agent-a.jsonl')
writer.registerAgentTranscriptDestination('agent-a', chainA)
{
  project.appendEntry(tag('session words'))
  project.appendEntry(sidechain('agent-a'))
  const error = await flush()
  t('L1 the flush reports the failing file', error !== null && /session\.jsonl|EISDIR|could not/i.test(error), error ?? 'resolved')
  t('L1 the healthy sidechain landed on the same drain', read(chainA).includes('"agentId":"agent-a"'), read(chainA).slice(0, 120) || '(nothing landed)')
  t('L1 the poisoned file kept its queue (nothing lost)', !existsSync(join(session, 'session words')))
}

// ── L2 ───────────────────────────────────────────────────────────────────────
console.log('L2 two poisoned files ahead of a healthy one')
const chainB = join(SCRATCH, 'agents', 'agent-b.jsonl')
const chainC = join(SCRATCH, 'agents', 'agent-c.jsonl')
poison(chainB)
writer.registerAgentTranscriptDestination('agent-b', chainB)
writer.registerAgentTranscriptDestination('agent-c', chainC)
{
  project.appendEntry(sidechain('agent-b'))
  project.appendEntry(sidechain('agent-c'))
  const error = await flush()
  t('L2 the healthy file behind two failures landed', read(chainC).includes('"agentId":"agent-c"'), read(chainC).slice(0, 120) || '(nothing landed)')
  t('L2 the aggregate names both failing files', error !== null && /2 transcript files/.test(error) && error.includes('session.jsonl') && error.includes('agent-b.jsonl'), error ?? 'resolved')
  const health = writer.transcriptStoreHealth() as { failing: boolean; sentence: string | null }
  t('L2 the store-health ladder still sees the failure (two consecutive)', health.failing === true, JSON.stringify(health))
}

// ── L3 ───────────────────────────────────────────────────────────────────────
console.log('L3 the heal')
rmSync(session, { recursive: true, force: true })
rmSync(chainB, { recursive: true, force: true })
await sleep(1_800)
{
  t('L3 the session words landed after the heal', read(session).includes('session words'), read(session).slice(0, 120) || '(nothing landed)')
  t('L3 the second sidechain landed after the heal', read(chainB).includes('"agentId":"agent-b"'), read(chainB).slice(0, 120) || '(nothing landed)')
  const health = writer.transcriptStoreHealth() as { failing: boolean }
  t('L3 the failing fact clears', health.failing === false, JSON.stringify(health))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'DRAIN FAULT ISOLATION: ALL PASS' : 'DRAIN FAULT ISOLATION: RED')
process.exit(failures)
