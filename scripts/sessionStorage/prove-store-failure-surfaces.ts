#!/usr/bin/env bun
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
  t('§1 two consecutive drain failures publish the failing fact', health.failing === true, JSON.stringify(health))
  t('§1 …carrying the store owner\'s sentence', (health.sentence ?? '').includes('transcript store') || (health.sentence ?? '').includes(poisoned), health.sentence ?? '(none)')
  t('§1 …and the seam fired listeners', healthEvents >= 1, `${healthEvents} events`)
}

rmSync(poisoned, { recursive: true, force: true })
await sleep(5_600)

{
  const health = writer.transcriptStoreHealth()
  t('§2 the first successful drain clears the failing fact', health.failing === false, JSON.stringify(health))
  let landed = ''
  try {
    landed = readFileSync(poisoned, 'utf8')
  } catch {
  }
  t('§2 …and the queued words actually landed', landed.includes('first words') && landed.includes('second words'))
}

{
  const repl = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
  t("§3 the chat paints the sticky notification from the seam", repl.includes("key: 'transcript-store'") && repl.includes('subscribeTranscriptStoreHealth'))
  t('§3 …and clears it on recovery', repl.includes("removeNotification('transcript-store')"))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'STORE FAILURE SURFACES: ALL PASS' : 'STORE FAILURE SURFACES: RED')
process.exit(failures)
