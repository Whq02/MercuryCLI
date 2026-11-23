#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'store-failure-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const writer = await import('../../src/sessions/transcripts/writer.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
await sleep(450)
project.appendEntry({ type: 'user', uuid: '00000000-0000-4000-8000-00000000aaab', timestamp: new Date().toISOString(), message: { role: 'user', content: 'second words' } } as never)
await sleep(900)

{
  const health = writer.transcriptStoreHealth()
  t('§1 two consecutive drain failures publish the failing fact', health.failing === true, `${JSON.stringify(health)}; runDrain in src/sessions/transcripts/writer/queue.ts must call setStoreHealth({ failing: true, ... }) after the second consecutive drain failure`)
  t('§1 …carrying the store owner\'s sentence', (health.sentence ?? '').includes('transcript store') || (health.sentence ?? '').includes(poisoned), `${health.sentence ?? '(none)'}; the failing sentence set in runDrain (src/sessions/transcripts/writer/queue.ts) must carry the describeTranscriptStoreFailure text from src/sessions/transcripts/writer/storeHealth.ts`)
  t('§1 …and the seam fired listeners', healthEvents >= 1, `${healthEvents} events; setStoreHealth in src/sessions/transcripts/writer/storeHealth.ts must call every listener added by subscribeTranscriptStoreHealth when the health changes`)
}

rmSync(poisoned, { recursive: true, force: true })
await sleep(5_600)

{
  const health = writer.transcriptStoreHealth()
  t('§2 the first successful drain clears the failing fact', health.failing === false, `${JSON.stringify(health)}; runDrain in src/sessions/transcripts/writer/queue.ts must call setStoreHealth({ failing: false, sentence: null }) after a drain succeeds`)
  let landed = ''
  try {
    landed = readFileSync(poisoned, 'utf8')
  } catch {
  }
  t('§2 …and the queued words actually landed', landed.includes('first words') && landed.includes('second words'), `file read back: ${JSON.stringify(landed)}; the queue in src/sessions/transcripts/writer/queue.ts must keep failed entries and write them on the next successful drain`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'STORE FAILURE SURFACES: ALL PASS' : 'STORE FAILURE SURFACES: RED')
process.exit(failures)
