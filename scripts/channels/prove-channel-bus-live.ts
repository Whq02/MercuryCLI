#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  check('the send half works before any tail (pre-start post appends)', bus.postLocalChannelMessage({ server: 'agent', content: 'before the tail' }) === true)
  const handle = bus.startLocalChannelBus()
  await sleep(1500)
  check('(1) a line appended before the tail started is NOT replayed', channelCommands().length === 0, `${channelCommands().length} queued`)

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

  appendFileSync(inbox, '{not json\n', 'utf8')
  bus.postLocalChannelMessage({ server: 'agent', content: 'after the bad line' })
  let after: Snap = []
  for (let i = 0; i < 25 && after.length < 2; i++) {
    await sleep(100)
    after = channelCommands()
  }
  check('(3) the malformed line is skipped and the next good line lands (2 total)', after.length === 2, `${after.length}`)

  handle.stop()
  bus.postLocalChannelMessage({ server: 'agent', content: 'after stop' })
  await sleep(1500)
  check('(4) after stop() a later post is not ingested (still 2)', channelCommands().length === 2, `${channelCommands().length}`)

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
