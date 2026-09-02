#!/usr/bin/env bun
// ============================================================================
//  prove-store-failure-surfaces — a failing transcript store says so.
//
//  The gap: on an unwritable session file (EISDIR here — a directory where
//  the .jsonl belongs; disk-full and read-only homes are the same road) the
//  drain backed off forever and the ONLY trace was a debug-ring line — the
//  operator kept typing into a session that silently stopped saving, while
//  the correct operator sentence (describeTranscriptStoreFailure) sat one
//  screen below, never painted. The law: after TWO consecutive drain
//  failures the writer publishes a health fact carrying the owner's exact
//  sentence (the chat paints it as one sticky notification); the first
//  successful drain clears it.
//
//  §1 two consecutive drain failures publish the failing fact + sentence
//  §2 healing the store clears it on the next successful drain
//  §3 the chat's surface is wired (structural: sticky key, clear arm)
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'store-failure-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const writer = await import('../../src/utils/sessionStorage/writer.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The poisoned store: a DIRECTORY where the session .jsonl belongs.
const poisoned = join(SCRATCH, 'session-as-dir.jsonl')
mkdirSync(poisoned, { recursive: true })
mkdirSync(join(poisoned, 'block'), { recursive: true })
writer.setSessionFileForTesting(poisoned)

let healthEvents = 0
writer.subscribeTranscriptStoreHealth(() => {
  healthEvents++
})

const project = writer.getProject()
project.appendEntry({ type: 'user', uuid: '00000000-0000-4000-8000-00000000aaaa', timestamp: new Date().toISOString(), message: { role: 'user', content: 'first words' } } as never)
await sleep(450) // first drain (~100ms) + second retry (~200ms) both fail
project.appendEntry({ type: 'user', uuid: '00000000-0000-4000-8000-00000000aaab', timestamp: new Date().toISOString(), message: { role: 'user', content: 'second words' } } as never)
await sleep(900)

{
  const health = writer.transcriptStoreHealth()
  t('§1 two consecutive drain failures publish the failing fact', health.failing === true, JSON.stringify(health))
  t('§1 …carrying the store owner\'s sentence', (health.sentence ?? '').includes('transcript store') || (health.sentence ?? '').includes(poisoned), health.sentence ?? '(none)')
  t('§1 …and the seam fired listeners', healthEvents >= 1, `${healthEvents} events`)
}

// §2 heal: the path becomes writable; the backoff retry drains and clears.
rmSync(poisoned, { recursive: true, force: true })
await sleep(5_600) // past the 5s backoff cap so the retry runs healed

{
  const health = writer.transcriptStoreHealth()
  t('§2 the first successful drain clears the failing fact', health.failing === false, JSON.stringify(health))
  let landed = ''
  try {
    landed = readFileSync(poisoned, 'utf8')
  } catch {
    // stays empty — the check reds
  }
  t('§2 …and the queued words actually landed', landed.includes('first words') && landed.includes('second words'))
}

// §3 the chat surface (structural)
{
  const repl = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
  t("§3 the chat paints the sticky notification from the seam", repl.includes("key: 'transcript-store'") && repl.includes('subscribeTranscriptStoreHealth'))
  t('§3 …and clears it on recovery', repl.includes("removeNotification('transcript-store')"))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'STORE FAILURE SURFACES: ALL PASS' : 'STORE FAILURE SURFACES: RED')
process.exit(failures)
