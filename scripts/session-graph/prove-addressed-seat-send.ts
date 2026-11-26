#!/usr/bin/env bun
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { checker, waitUntil } from '../engine-durability/harness.ts'
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('addressed-seat-send')
const scratch = realpathSync(home)
const workDir = join(scratch, 'work')
const binDir = join(scratch, 'bin')
const stdinDir = join(scratch, 'stdin')
for (const dir of [workDir, binDir, stdinDir]) mkdirSync(dir, { recursive: true })

process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
for (const key of ['MERCURY_HOME', 'MERCURY_CREW_DIR', 'MERCURY_CREW_DIRECTORY']) delete process.env[key]
const origCwd = process.cwd()
const origPath = process.env.PATH ?? ''
process.chdir(workDir)

const peerPath = join(scratch, 'acp-peer.mjs')
writeFileSync(
  peerPath,
  `
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const stdinFile = process.env.PEER_STDIN
const sessionId = process.env.PEER_SESSION
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')

writeFileSync(stdinFile + '.pid', String(process.pid))
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  appendFileSync(stdinFile, line + '\\n')
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: 1, agentInfo: { name: 'stand-in', version: '1' }, agentCapabilities: {} })
  if (msg.method === 'session/new') reply(msg.id, { sessionId })
  if (msg.method === 'session/prompt') reply(msg.id, { stopReason: 'end_turn' })
})
`,
)
if (process.platform === 'win32') {
  writeFileSync(join(binDir, 'devin.cmd'), `@echo off\r\n"${process.execPath}" "${peerPath}" %*\r\n`)
} else {
  const shim = join(binDir, 'devin')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${peerPath}" "$@"\n`)
  chmodSync(shim, 0o755)
}
process.env.PATH = [binDir, dirname(process.execPath), ...(process.platform === 'win32' ? origPath.split(delimiter).filter(Boolean) : ['/usr/bin', '/bin'])].join(delimiter)

const t = checker()
const bridge = await import('../../src/crew/crewmates/seatBridge.ts')
const caps = await import('../../src/crew/crewmates/capabilities.ts')
const dispatch = await import('../../src/crew/crewmates/dispatch.ts')
const crew = await import('../../src/commands/crew/index.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')
type LocalJSXCommandContext = import('../../src/commands/catalogue/command.ts').LocalJSXCommandContext

const context: LocalJSXCommandContext = {
  options: {
    commands: [],
    debug: false,
    verbose: false,
    engineModel: 'claude-sonnet-4-6',
    tools: getAllBaseTools(),
    mcpClients: [],
    isNonInteractiveSession: false,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    theme: 'dark',
  },
  startTurn: () => {
    throw new Error('no turn loop in crew command context')
  },
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
  getAppState: () => getDefaultAppState(),
  setAppState: () => {},
  messages: [],
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  setMessages: () => {},
  onChangeAPIKey: () => {},
}

const { call } = await crew.default.load()
const say = async (line: string): Promise<string> => {
  const out = await call(line, context)
  return out.type === 'text' ? out.value : ''
}

interface Peer {
  seatId: string
  stdinFile: string
  pid: number
}

async function attach(name: string, sessionId: string): Promise<Peer> {
  const stdinFile = join(stdinDir, `${name}.jsonl`)
  writeFileSync(stdinFile, '')
  process.env.PEER_STDIN = stdinFile
  process.env.PEER_SESSION = sessionId
  const out = await say('attach devin')
  return {
    seatId: /seat (seat-[a-f0-9]{12})/.exec(out)?.[1] ?? '',
    stdinFile,
    pid: Number(readFileSync(`${stdinFile}.pid`, 'utf8')),
  }
}

const SETTLE = { tries: 400, everyMs: 25 }

async function send(peer: Peer, words: string): Promise<string> {
  const out = await say(`send ${peer.seatId} ${words}`)
  const id = /crew-[a-f0-9]{12}/.exec(out)?.[0]
  if (id === undefined) await settle(300)
  else await waitUntil(() => bridge.listAttachedSeats().some(s => bridge.lastSeatTurn(s.seatId)?.clientMessageId === id), SETTLE)
  return out
}

const promptsOf = (peer: Peer): string[] =>
  readFileSync(peer.stdinFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { method?: string; params?: { prompt?: Array<{ text?: string }> } })
    .filter(msg => msg.method === 'session/prompt')
    .map(msg => msg.params?.prompt?.[0]?.text ?? '')
const bytesOf = (...peers: Peer[]): string => peers.map(peer => statSync(peer.stdinFile).size).join(' ')
const agentOf = (peer: Peer) => bridge.attachedSeatOf(peer.seatId)?.agentId
const sessionOf = (peer: Peer) => bridge.attachedSeatOf(peer.seatId)?.externalSessionId
const read = (...peers: Peer[]): string => JSON.stringify(peers.map(promptsOf))

try {
  t.section('§1 — two attached peers answer session/new with ONE external session id')
  const a = await attach('a', 'peer-shared')
  const b = await attach('b', 'peer-shared')
  t.check(
    'two attaches are two seats, two processes and two agents',
    a.seatId !== '' && b.seatId !== '' && a.seatId !== b.seatId && a.pid !== b.pid && agentOf(a) !== agentOf(b),
    JSON.stringify({ a, b, agents: [agentOf(a), agentOf(b)] }),
  )
  await send(a, 'first-A')
  await send(b, 'first-B')
  const coalesced = await waitUntil(() => agentOf(a) === agentOf(b), SETTLE)
  t.check(
    'after their first turns both seats carry the one external session id and one agent id',
    coalesced && sessionOf(a) === 'peer-shared' && sessionOf(b) === 'peer-shared',
    JSON.stringify({ agents: [agentOf(a), agentOf(b)], sessions: [sessionOf(a), sessionOf(b)] }),
  )
  const toB = await send(b, 'for-B')
  t.check(
    "/crew send <seat B> is read on B's stdin and not on A's",
    toB.includes(`(${b.seatId})`) && promptsOf(b).includes('for-B') && !promptsOf(a).includes('for-B'),
    `${toB} · stdin A, B: ${read(a, b)}`,
  )
  const toA = await send(a, 'for-A')
  t.check(
    "/crew send <seat A> is read on A's stdin and not on B's",
    toA.includes(`(${a.seatId})`) && promptsOf(a).includes('for-A') && !promptsOf(b).includes('for-A'),
    `${toA} · stdin A, B: ${read(a, b)}`,
  )
  await send(a, 'again-A')
  await send(b, 'again-B')
  t.check(
    'each child read exactly the sends addressed to its own seat, in order',
    read(a, b) === JSON.stringify([['first-A', 'for-A', 'again-A'], ['first-B', 'for-B', 'again-B']]),
    read(a, b),
  )

  t.section('§2 — a send to a seat that has gone is refused before a byte is written')
  process.kill(a.pid, 'SIGKILL')
  const exited = await waitUntil(() => bridge.attachedSeatOf(a.seatId)?.lifecycle === 'exited', SETTLE)
  t.check("seat A's process is killed and the seat reads exited", exited, String(bridge.attachedSeatOf(a.seatId)?.lifecycle))
  const beforeGone = bytesOf(a, b)
  const gone = await send(a, 'gone-A')
  t.check(
    'a send to the exited seat A is refused, names seat A, and neither stdin grows',
    gone.includes('not-delivered') && gone.includes(a.seatId) && bytesOf(a, b) === beforeGone,
    `${gone} · stdin bytes A B: ${beforeGone} → ${bytesOf(a, b)} · stdin B: ${read(b)}`,
  )
  const sharedAgent = agentOf(b)
  await say(`detach ${a.seatId}`)
  const beforeDetached = bytesOf(a, b)
  const detached = await send(a, 'detached-A')
  t.check(
    'a send to the detached seat A is refused by name at the command and neither stdin grows',
    detached.includes(`no attached seat '${a.seatId}'`) && bytesOf(a, b) === beforeDetached,
    `${detached} · stdin bytes A B: ${beforeDetached} → ${bytesOf(a, b)}`,
  )
  const beforeLeft = bytesOf(a, b)
  const left =
    sharedAgent === undefined
      ? null
      : await dispatch.dispatchToAgent({
          clientMessageId: 'addressed-left-1',
          requestedAddress: { agentId: sharedAgent, seatId: a.seatId },
          requestedDisposition: 'start-turn',
          instruction: 'left-A',
          attachments: [],
        })
  await settle(300)
  t.check(
    'a dispatch still addressed to the detached seat A is refused, names seat A, and never falls to seat B',
    left?.state === 'not-delivered' && (left.reason ?? '').includes(a.seatId) && bytesOf(a, b) === beforeLeft,
    `${left?.state} — ${left?.reason} · stdin bytes A B: ${beforeLeft} → ${bytesOf(a, b)} · stdin B: ${read(b)}`,
  )
  const stillB = await send(b, 'after-B')
  t.check(
    'seat B is still reached by its own id after seat A left',
    stillB.includes(`(${b.seatId})`) && promptsOf(b).at(-1) === 'after-B',
    `${stillB} · stdin B: ${read(b)}`,
  )
  await say(`detach ${b.seatId}`)

  t.section('§3 — control: two attached peers with two external session ids')
  const c = await attach('c', 'peer-c')
  const d = await attach('d', 'peer-d')
  await send(c, 'first-C')
  await send(d, 'first-D')
  const named = await waitUntil(() => sessionOf(c) === 'peer-c' && sessionOf(d) === 'peer-d', SETTLE)
  await send(d, 'for-D')
  await send(c, 'for-C')
  t.check(
    'each seat keeps its own agent and each child read only the sends addressed to its own seat',
    named && agentOf(c) !== agentOf(d) && read(c, d) === JSON.stringify([['first-C', 'for-C'], ['first-D', 'for-D']]),
    `${JSON.stringify({ agents: [agentOf(c), agentOf(d)] })} · stdin C, D: ${read(c, d)}`,
  )
  const agentC = agentOf(c)
  const beforeCrossed = bytesOf(c, d)
  const crossed =
    agentC === undefined
      ? null
      : await dispatch.dispatchToAgent({
          clientMessageId: 'addressed-crossed-1',
          requestedAddress: { agentId: agentC, seatId: d.seatId },
          requestedDisposition: 'start-turn',
          instruction: 'crossed',
          attachments: [],
        })
  await settle(300)
  t.check(
    "a dispatch that names seat D under seat C's agent is refused, names seat D, and neither stdin grows",
    crossed?.state === 'not-delivered' && (crossed.reason ?? '').includes(d.seatId) && bytesOf(c, d) === beforeCrossed,
    `${crossed?.state} — ${crossed?.reason} · stdin bytes C D: ${beforeCrossed} → ${bytesOf(c, d)} · stdin C, D: ${read(c, d)}`,
  )
} finally {
  for (const seat of bridge.listAttachedSeats()) await bridge.detachExternalSeat(seat.seatId)
  bridge._resetSeatBridgeForTesting()
  caps._resetCapabilitiesForTesting()
  process.chdir(origCwd)
  process.env.PATH = origPath
  await releaseScratchHome(home)
}

t.finish('prove-addressed-seat-send')
