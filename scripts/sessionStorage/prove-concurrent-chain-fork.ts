#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-concurrent-chain-fork.ts — the
//  atomic leaf read (the fork-and-drop class, closed at the seam).
//
//  THE CLASS (the writer's own header documents its first instance as a
//  real shipped bug): recordTranscript decided a new batch's parent by
//  reading Project.currentSessionChainLeaf BEFORE entering
//  insertMessageChain's trackWrite-serialized section. Two overlapping
//  calls — no await between them — both read the SAME leaf and both parent
//  their batch onto it: the chain forks, and the latest-leaf reader that
//  displays the transcript then walks ONE branch and silently DROPS the
//  other — a whole turn vanishes, or lands "above" the reply that answers
//  it after a resume re-walk. This is the message-order scramble's
//  writer-side road (the display-side echo road is the delivery lane's).
//
//  THE LAW: the leaf is read and consumed ATOMICALLY with the write — the
//  preference for the live leaf moves INSIDE the serialized section, so
//  overlapping writers chain one after the other and the file stays LINEAR
//  for sequential-chaining batches. The tool-result carve-out
//  (sourceToolAssistantUUID) keeps its own parent, and the first-record
//  anchor scan (an empty file) is untouched.
//
//  Run: ~/.bun/bin/bun run scripts/sessionStorage/prove-concurrent-chain-fork.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chainfork-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { recordTranscript, flushSessionStorage } = await import(
  join(ROOT, 'src/utils/sessionStorage/writer.ts')
)
const { createUserMessage } = await import(join(ROOT, 'src/utils/messages.ts'))
const { getSessionId } = await import(join(ROOT, 'src/bootstrap/state.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('concurrent chain writes — the leaf reads atomically with the write')

const seed = createUserMessage({ content: 'the seed turn' })
await recordTranscript([seed] as never)

// The race shape: two record calls in the SAME tick, no await between —
// exactly two engine lanes settling into one session file.
const first = createUserMessage({ content: 'first overlapping turn' })
const second = createUserMessage({ content: 'second overlapping turn' })
const p1 = recordTranscript([first] as never)
const p2 = recordTranscript([second] as never)
await Promise.all([p1, p2])
await flushSessionStorage()

// Read the raw store: every record's own uuid → parent linkage.
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
check('the session file stands', sessionFile !== undefined, files.join(', '))

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
      /* torn line */
    }
  }
}

const seedUuid = (seed as { uuid: string }).uuid
const firstUuid = (first as { uuid: string }).uuid
const secondUuid = (second as { uuid: string }).uuid
check('all three turns are recorded', parents.has(seedUuid) && parents.has(firstUuid) && parents.has(secondUuid), `${parents.size} records`)
check('the first overlapping turn chains onto the seed', parents.get(firstUuid) === seedUuid, `parent=${parents.get(firstUuid)}`)
check(
  'THE LAW: the second overlapping turn chains onto the FIRST — linear, never a fork onto the shared stale leaf',
  parents.get(secondUuid) === firstUuid,
  `second.parent=${parents.get(secondUuid)} (a fork points it at the seed ${seedUuid.slice(0, 8)}…)`,
)

// The sequential shape stays linear too (the fix must not disturb it).
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
    line?.slice(0, 160) ?? 'missing',
  )
}

console.log(
  failures === 0
    ? '\n ✅ CONCURRENT CHAIN WRITES — the leaf reads atomically; the chain stays linear'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
