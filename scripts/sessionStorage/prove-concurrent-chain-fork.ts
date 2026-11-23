#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chainfork-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { recordTranscript, flushSessionStorage } = await import(
  join(ROOT, 'src/sessions/transcripts/writer.ts')
)
const { createUserMessage } = await import(join(ROOT, 'src/engine/messages/messages.ts'))
const { getSessionId } = await import(join(ROOT, 'src/boot/process-state/processState.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('concurrent chain writes — the leaf reads atomically with the write')

const seed = createUserMessage({ content: 'the seed turn' })
await recordTranscript([seed] as never)

const first = createUserMessage({ content: 'first overlapping turn' })
const second = createUserMessage({ content: 'second overlapping turn' })
const p1 = recordTranscript([first] as never)
const p2 = recordTranscript([second] as never)
await Promise.all([p1, p2])
await flushSessionStorage()

const home = process.env.MERCURY_CONFIG_DIR!
const { readdirSync, statSync } = await import('node:fs')
const files: string[] = []
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.jsonl')) files.push(p)
  }
}
walk(home)
const sessionFile = files.find(f => f.includes(getSessionId()))
check('the session file stands', sessionFile !== undefined, `${files.join(', ')}; recordTranscript and flushSessionStorage in src/sessions/transcripts/writer.ts should leave a .jsonl for getSessionId() under the config home`)

const parents = new Map<string, string | null>()
if (sessionFile) {
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as {
        recordId?: string
        parentId?: string | null
        payload?: { fields?: { uuid?: string; parentUuid?: string | null } }
      }
      const uuid = record.payload?.fields?.uuid ?? record.recordId
      if (typeof uuid === 'string') {
        parents.set(uuid, record.payload?.fields?.parentUuid ?? record.parentId ?? null)
      }
    } catch {
    }
  }
}

const seedUuid = (seed as { uuid: string }).uuid
const firstUuid = (first as { uuid: string }).uuid
const secondUuid = (second as { uuid: string }).uuid
check('all three turns are recorded', parents.has(seedUuid) && parents.has(firstUuid) && parents.has(secondUuid), `${parents.size} records; every message passed to recordTranscript in src/sessions/transcripts/writer.ts must land as a row in the session file`)
check('the first overlapping turn chains onto the seed', parents.get(firstUuid) === seedUuid, `parent=${parents.get(firstUuid)}; the first turn after the seed should take the seed as parent, see recordTranscript in src/sessions/transcripts/writer.ts`)
check(
  'THE LAW: the second overlapping turn chains onto the FIRST — linear, never a fork onto the shared stale leaf',
  parents.get(secondUuid) === firstUuid,
  `second.parent=${parents.get(secondUuid)} (a fork points it at the seed ${seedUuid.slice(0, 8)}…); the starting parent of an overlapping recordTranscript call must come from the live chain leaf when the write runs, see preferLiveLeaf and currentSessionChainLeaf in src/sessions/transcripts/writer.ts`,
)

const third = createUserMessage({ content: 'a later sequential turn' })
await recordTranscript([third] as never)
await flushSessionStorage()
{
  const raw = readFileSync(sessionFile!, 'utf8')
  const line = raw
    .split('\n')
    .find(l => l.includes((third as { uuid: string }).uuid) && l.includes('parentUuid'))
  check(
    'a sequential turn chains onto the newest leaf as ever',
    line !== undefined && line.includes(secondUuid),
    `${line?.slice(0, 160) ?? 'missing'}; a later recordTranscript call should chain onto the newest leaf, see recordTranscript in src/sessions/transcripts/writer.ts`,
  )
}

console.log(
  failures === 0
    ? '\n ✅ CONCURRENT CHAIN WRITES — the leaf reads atomically; the chain stays linear'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
