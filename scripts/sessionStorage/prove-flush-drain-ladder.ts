#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const SCRATCH = mkdtempSync(join(tmpdir(), 'flush-ladder-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const writer = await import(join(SRC, 'sessions/transcripts/writer.ts'))

let failures = 0
const drainLadderFailHint = 'fix the drain, retry timer and failure streak in src/sessions/transcripts/writer/queue.ts, the flush entry flushSessionStorage in src/sessions/transcripts/writer.ts, or the published fact in src/sessions/transcripts/writer/storeHealth.ts (transcriptStoreHealth)'
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}${ok ? '' : ` — ${drainLadderFailHint}`}`)
  if (!ok) failures = 1
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const entry = (_uuid: string, words: string): never => ({ type: 'tag', tag: words, sessionId: 'flush-ladder' }) as never

const poisoned = join(SCRATCH, 'session-as-dir.jsonl')
mkdirSync(join(poisoned, 'block'), { recursive: true })
writer.setSessionFileForTesting(poisoned)
const project = writer.getProject()

project.appendEntry(entry('00000000-0000-4000-8000-000000000001', 'first words'))
let rejections = 0
let lastError = ''
for (let i = 0; i < 2; i++) {
  try {
    await writer.flushSessionStorage()
  } catch (err) {
    rejections++
    lastError = err instanceof Error ? err.message : String(err)
  }
}
{
  const health = writer.transcriptStoreHealth()
  t('L1 flush() reports each failure to its caller (2 of 2 rejected)', rejections === 2, `${rejections} rejections`)
  t('L1 two consecutive flush-initiated failures publish the failing fact', health.failing === true, JSON.stringify(health))
  t("L1 …carrying the store owner's sentence", (health.sentence ?? '') === lastError && lastError.length > 0, health.sentence ?? '(none)')
}

rmSync(poisoned, { recursive: true, force: true })
await sleep(1_500)
{
  let landed = ''
  try {
    landed = readFileSync(poisoned, 'utf8')
  } catch {
  }
  t('L2 the un-landed batch is retried by the re-armed timer, not by the next enqueue', landed.includes('first words'), 'nothing landed after the heal')
  const health = writer.transcriptStoreHealth()
  t('L2 the first successful drain clears the failing fact', health.failing === false, JSON.stringify(health))
}

{
  project.appendEntry(entry('00000000-0000-4000-8000-000000000002', 'second words'))
  let healthyFlushRejected = false
  try {
    await writer.flushSessionStorage()
  } catch {
    healthyFlushRejected = true
  }
  const afterFlush = readFileSync(poisoned, 'utf8')
  t('L3 a healthy flush resolves and lands its words', !healthyFlushRejected && afterFlush.includes('second words'))
  project.appendEntry(entry('00000000-0000-4000-8000-000000000003', 'third words'))
  await sleep(600)
  t('L3 the timer road still lands without a flush', readFileSync(poisoned, 'utf8').includes('third words'))
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'FLUSH DRAIN LADDER: ALL PASS' : 'FLUSH DRAIN LADDER: RED')
process.exit(failures)
