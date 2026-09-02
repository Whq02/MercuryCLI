#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getLivePresence,
  getPresenceDir,
  getPresenceVersion,
  recordSelfPresence,
  subscribePresence,
  tailPresence,
} from '../../src/utils/cockpit/presenceLive.js'
import type { PresenceSeat } from '../../src/utils/cockpit/presenceLive.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' presenceLive — per-seat producer + tailer (agent-ignored)')
console.log('============================================================')

const ROOM = `presence-proof-${process.pid}`
process.env.MERCURY_CHANNEL_ROOM = ROOM
process.env.MERCURY_OPERATOR = 'alice'
delete process.env.MERCURY_LOCAL_CHANNELS

let roomDir: string | null = null
try {
  section('(a) recordSelfPresence writes presence/<seat>.json atomically')
  recordSelfPresence({
    seat: 'alice',
    verb: 'editing',
    branch: 'feat/a1-presence',
    lastLine: 'wired the presence store',
  })
  const dir = getPresenceDir()
  check('getPresenceDir() resolves when a room is active', dir !== null, String(dir))
  if (!dir) throw new Error('no presence dir — cannot continue')
  roomDir = dirname(dir)
  const alicePath = join(dir, 'alice.json')
  check('presence/alice.json exists after a self-write', existsSync(alicePath))
  let aliceRec: PresenceSeat | null = null
  try {
    aliceRec = JSON.parse(readFileSync(alicePath, 'utf8')) as PresenceSeat
  } catch {
  }
  check(
    'the written file is a COMPLETE, parseable record (atomic tmp+rename, no half-write)',
    aliceRec !== null &&
      aliceRec.seat === 'alice' &&
      aliceRec.verb === 'editing' &&
      typeof aliceRec.ts === 'number',
  )

  const bobPath = join(dir, 'bob.json')
  const writeBob = (ts: number): void =>
    writeFileSync(
      bobPath,
      JSON.stringify({
        seat: 'bob',
        verb: 'reviewing',
        branch: 'main',
        lastLine: 'reading the diff',
        ts,
      }),
      'utf8',
    )
  writeBob(Date.now())

  section('(b) tailPresence excludes self (alice) and keeps the peer (bob)')
  const v0 = getPresenceVersion()
  let repainted = false
  const unsub = subscribePresence(() => {
    repainted = true
  })
  tailPresence()
  const live = getLivePresence()
  check('getLivePresence() returns exactly ONE seat', live.length === 1, `len=${live.length}`)
  check('that seat is bob (the peer), NOT alice (self)', live[0]?.seat === 'bob', live[0]?.seat)
  check('alice (self) is excluded from the live set', !live.some(s => s.seat === 'alice'))
  check('the bob record round-trips its fields', live[0]?.verb === 'reviewing' && live[0]?.branch === 'main')
  check('subscribePresence fired on tail (deck repaint signal)', repainted)
  check('the version counter advanced', getPresenceVersion() > v0, `${v0} → ${getPresenceVersion()}`)
  unsub()

  section('(c) a stale peer (now - ts > STALE_MS) is dropped on the next tail')
  writeBob(Date.now() - 999_999)
  tailPresence()
  const liveStale = getLivePresence()
  check('a stale bob is dropped (live set now empty)', liveStale.length === 0, `len=${liveStale.length}`)

  section('(d) channels opted out ⇒ recordSelfPresence is a no-op, tail yields empty, no crash')
  delete process.env.MERCURY_CHANNEL_ROOM
  process.env.MERCURY_LOCAL_CHANNELS = '0'
  check('getPresenceDir() is null when channels are opted out', getPresenceDir() === null)
  let threw = false
  try {
    recordSelfPresence({ seat: 'carol', verb: 'x', branch: 'y', lastLine: 'z' })
    tailPresence()
  } catch {
    threw = true
  }
  check('no-op record + tail never throws', !threw)
  check('live set is empty in the inactive state', getLivePresence().length === 0)
  delete process.env.MERCURY_LOCAL_CHANNELS

  section('INVARIANT — presenceLive never routes through the channel-bus ingest path')
  const here = dirname(fileURLToPath(import.meta.url))
  const moduleSrc = readFileSync(
    join(here, '..', '..', 'src', 'utils', 'cockpit', 'presenceLive.ts'),
    'utf8',
  )
  const code = moduleSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('no enqueue( — presence never enters the message queue', !/enqueue\(/.test(code))
  check('no ingestRecord( — presence never becomes a model turn', !/ingestRecord\(/.test(code))
  check('no inbox.jsonl — presence is a SEPARATE per-seat file', !/inbox\.jsonl/.test(code))
  check('no import of the channel-bus module (no transitive ingest path)', !/localChannelBus/.test(code))
  check('writes a per-seat snapshot file (presence/<seat>.json)', /'presence'/.test(code) && /\.json/.test(code))
} finally {
  if (roomDir) {
    try {
      rmSync(roomDir, { recursive: true, force: true })
    } catch {
    }
  }
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ presenceLive — producer/tailer correct; invariant (agent-ignored) intact')
  process.exit(0)
} else {
  console.log(` ❌ presenceLive — ${failures} check(s) failed`)
  process.exit(1)
}
