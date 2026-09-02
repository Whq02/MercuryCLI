#!/usr/bin/env bun
// ============================================================================
//  scripts/channels/prove-channel-bus-live.ts — the agents' wire END-TO-END,
//  in process. The bus module rides the build-only feature() macro graph
//  that `bun run` refuses, so this prover is BUNDLED with the product's own
//  resolution laws (scripts/search/lib/bundle-for-node.ts) and run under
//  node — the prover-green-under-bun ≠ node law's method. No product boot:
//  a node process over the bus module and the session queue, a scratch
//  config home, the room pinned by env.
//
//   (1) history law — a line appended BEFORE the tail starts is never
//       replayed (a fresh session joins at EOF);
//   (2) the live round-trip — a record posted from an agent's seat lands as
//       exactly ONE channel-origin command in the session queue within the
//       1 s poll, wrapped as <channel source="…"> with the body whole (a
//       newline, a tab and quotes intact), isMeta, skipSlashCommands,
//       priority 'next', mode 'prompt' — the shape UserChannelMessage renders
//       and the model reads;
//   (3) a malformed line is skipped, the next good line still lands;
//   (4) stop() tears the tail down — a later post is not ingested;
//   (5) MERCURY_LOCAL_CHANNELS=0 ⇒ the dead handle: no room dir, no file.
//
//  The static and door legs live in prove-channel-bus.ts; this file is the
// wire's LIVE leg — the pin that the wire kept working
//  after its one command door retired.
//
//  Run (the suite's run-all.sh does both steps):
//    bun scripts/search/lib/bundle-for-node.ts scripts/channels/prove-channel-bus-live.ts scripts/channels/.out/prove-channel-bus-live.mjs
//    node scripts/channels/.out/prove-channel-bus-live.mjs
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The scratch home and the room are pinned BEFORE the bus module loads
// (dynamic imports below): channelsRoot memoizes the home on first read.
const home = mkdtempSync(join(tmpdir(), 'mercury-bus-live-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
process.env.MERCURY_LOCAL_CHANNELS = '1'
process.env.MERCURY_CHANNEL_ROOM = 'proofroom'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const bus = await import('../../src/services/mcp/localChannelBus.js')
const queue = await import('../../src/utils/messageQueueManager.js')

type Snap = ReturnType<typeof queue.getCommandQueueSnapshot>
const channelCommands = (): Snap =>
  queue.getCommandQueueSnapshot().filter(c => (c as { origin?: { kind?: string } }).origin?.kind === 'channel')

console.log('============================================================')
console.log(" Local channel bus — the agents' wire, end-to-end in process (node)")
console.log('============================================================')
try {
  const inbox = bus.getLocalChannelInboxPath()
  check('the inbox path lives under the scratch home', inbox.startsWith(home), inbox)
  check("the room is the env override, sanitized ('proofroom')", bus.getLocalChannelRoom() === 'proofroom', bus.getLocalChannelRoom())

  // (1) a pre-start line is history, never replayed.
  check('the send half works before any tail (pre-start post appends)', bus.postLocalChannelMessage({ server: 'agent', content: 'before the tail' }) === true)
  const handle = bus.startLocalChannelBus()
  await sleep(1500)
  check('(1) a line appended before the tail started is NOT replayed', channelCommands().length === 0, `${channelCommands().length} queued`)

  // (2) the live round-trip from an agent's seat.
  const body = 'hello from the wire\nsecond line\twith a tab and "quotes"'
  check("(2) the post from an agent's seat is accepted", bus.postLocalChannelMessage({ server: 'agent', content: body, meta: { user: 'runner' } }) === true)
  let landed: Snap = []
  for (let i = 0; i < 25 && landed.length === 0; i++) {
    await sleep(100)
    landed = channelCommands()
  }
  check('(2) exactly ONE channel-origin command landed within the poll', landed.length === 1, `${landed.length}`)
  const cmd = landed[0] as
    | { value: unknown; mode: string; priority?: string; isMeta?: boolean; skipSlashCommands?: boolean; origin?: { kind?: string; server?: string } }
    | undefined
  const text = typeof cmd?.value === 'string' ? cmd.value : JSON.stringify(cmd?.value ?? '')
  check('(2) wrapped as <channel source="agent" …> (the MCP-path wire contract)', /<channel source="agent"/.test(text), text.slice(0, 120))
  check('(2) the meta rides the tag (user="runner")', /user="runner"/.test(text), text.slice(0, 120))
  check('(2) the body rides whole (newline, tab, quotes intact)', text.includes(body), text.slice(0, 160))
  check("(2) origin.kind === 'channel' · origin.server === 'agent'", cmd?.origin?.kind === 'channel' && cmd?.origin?.server === 'agent')
  check("(2) isMeta · skipSlashCommands · priority 'next' · mode 'prompt'", cmd?.isMeta === true && cmd?.skipSlashCommands === true && cmd?.priority === 'next' && cmd?.mode === 'prompt')

  // (3) a malformed line never stops the tail.
  appendFileSync(inbox, '{not json\n', 'utf8')
  bus.postLocalChannelMessage({ server: 'agent', content: 'after the bad line' })
  let after: Snap = []
  for (let i = 0; i < 25 && after.length < 2; i++) {
    await sleep(100)
    after = channelCommands()
  }
  check('(3) the malformed line is skipped and the next good line lands (2 total)', after.length === 2, `${after.length}`)

  // (4) stop() tears the tail down.
  handle.stop()
  bus.postLocalChannelMessage({ server: 'agent', content: 'after stop' })
  await sleep(1500)
  check('(4) after stop() a later post is not ingested (still 2)', channelCommands().length === 2, `${channelCommands().length}`)

  // (5) the hard override off ⇒ the dead handle, no room dir.
  process.env.MERCURY_LOCAL_CHANNELS = '0'
  process.env.MERCURY_CHANNEL_ROOM = 'deadroom'
  const dead = bus.startLocalChannelBus()
  dead.stop()
  check('(5) MERCURY_LOCAL_CHANNELS=0 ⇒ isLocalChannelBusEnabled() false', bus.isLocalChannelBusEnabled() === false)
  check('(5) …and the dead handle touched no room dir', !existsSync(join(home, 'channels', 'deadroom')))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n✅ ALL BUS-LIVE PROOFS PASS' : `\n❌ ${failures} BUS-LIVE PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
