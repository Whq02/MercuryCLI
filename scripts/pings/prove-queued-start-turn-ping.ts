#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'queued-start-ping-'))
const home = join(scratch, 'home')
const configDir = join(home, '.mercury')
const daemonHome = join(home, 'daemon')
const work = join(scratch, 'work')
mkdirSync(configDir, { recursive: true })
mkdirSync(join(daemonHome, 'session-facts'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ view: { ping: true } }))

process.env.HOME = home
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.TERM_PROGRAM = 'iTerm.app'
delete process.env.TMUX

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateLastInteractionTime, flushInteractionTime } = await import('../../src/bootstrap/state.ts')
const { Box, Text, render } = await import('../../src/ink.ts')
const { TerminalWriteProvider } = await import('../../src/ink/terminalWrite.ts')
const { useTurnEndPing, PING_MESSAGE } = await import('../../src/hooks/useTurnEndPing.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { readSessionWorkersSnapshot, markConcourseWorkerTurnSettled } = await import('../../src/daemon/concourseWorkers.ts')
const { hasSeatLive, IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const {
  getFocusedSessionConnector,
  setFocusedSessionConnector,
  subscribeFocusedSessionConnector,
  subscribeThroughFocused,
} = await import('../../src/services/engine-connector/focusedConnector.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
import type { SessionFactsV1 } from '../../src/services/engine-connector/seatProjections.ts'

const { vshotBudgetMs } = await import('../lib/captureDriver.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function wait(ms: number, stopWhen?: () => boolean): Promise<void> {
  let expired = false
  const timer = setTimeout(() => {
    expired = true
  }, vshotBudgetMs(ms))
  timer.unref?.()
  try {
    while (!expired && !(stopWhen?.() ?? false)) {
      await new Promise<void>(next => setImmediate(next))
    }
  } finally {
    clearTimeout(timer)
  }
}

let factsSeq = 100
function writeFacts(sessionId: string, patch: Partial<SessionFactsV1>): void {
  factsSeq += 10
  const doc: SessionFactsV1 = {
    schema: 1,
    sessionId,
    atMs: Date.now() + factsSeq,
    model: { effective: 'claude-opus-5-5', setting: 'claude-opus-5-5' },
    pendingModel: null,
    usage: {
      totalCostUSD: 0,
      totalAPIDurationMs: 0,
      totalDurationMs: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      hasUnknownModelCost: false,
    },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd: work, originalCwd: work, projectRoot: work },
    queue: [],
    busy: false,
    ...patch,
  }
  writeFileSync(join(daemonHome, 'session-facts', `${sessionId}.json`), JSON.stringify(doc))
}

function writeWorkers(entries: Record<string, { sessionId: string; lastDeliveryAt?: number; lastTurnSettledAt?: number }>): void {
  const workers: Record<string, unknown> = {}
  for (const [runnerId, w] of Object.entries(entries)) {
    workers[runnerId] = {
      schema: 1,
      runnerId,
      sessionId: w.sessionId,
      workspaceId: work,
      isolation: 'shared',
      modelKey: 'claude-opus-5-5',
      spawnedAt: 1000,
      lastLiveAt: 1000,
      ...(w.lastDeliveryAt !== undefined ? { lastDeliveryAt: w.lastDeliveryAt } : {}),
      ...(w.lastTurnSettledAt !== undefined ? { lastTurnSettledAt: w.lastTurnSettledAt } : {}),
    }
  }
  writeFileSync(join(daemonHome, 'concourse-workers.json'), JSON.stringify({ version: 1, workers }))
}

function feedFacts(connector: InstanceType<typeof DaemonSessionConnector>): void {
  ;(connector as unknown as { readFacts: () => void }).readFacts()
}

const subscribeFocusedSeatLive = subscribeThroughFocused((c, listener) => (hasSeatLive(c) ? c.subscribeLive(listener) : () => {}))
const getFocusedSeatLive = () => {
  const c = getFocusedSessionConnector()
  return hasSeatLive(c) ? c.live() : IDLE_LIVE
}

let completionEdges = 0
const THRESHOLD_MS = 80
const writes: string[] = []
const recordWrite = (s: string): void => {
  writes.push(s)
}
const osc9Count = (): number => writes.filter(w => w.includes(']9;') && w.includes(PING_MESSAGE)).length

const chatSrc = readFileSync(join(import.meta.dir, '../../src/screens/Chat.tsx'), 'utf8')
const chatSwitchBlock = chatSrc.slice(
  chatSrc.indexOf('if (connectorCompletedRef.current.connector !== focusedConnector)'),
  chatSrc.indexOf('const completed = hasConnectorCompleted'),
)
const switchResetsTipWhenLoading = chatSwitchBlock.includes('if (isLoading) tipPickedThisTurnRef.current = false')
let tipsPicked = 0

function PingHarness(): React.ReactNode {
  const focusedConnector = useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedSessionConnector, getFocusedSessionConnector)
  const seatLive = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedSeatLive, getFocusedSeatLive)
  const isLoading = seatLive.inFlight
  const [lastCompletedAt, setLastCompletedAt] = useState<number | null>(null)
  const tipPickedThisTurnRef = useRef(false)
  const wasLoadingRef = useRef(false)
  const connectorCompletedRef = useRef<{ connector: unknown; at: number | null }>({ connector: null, at: null })
  const hasConnectorCompleted = typeof (focusedConnector as { lastTurnCompletedAtMs?: unknown }).lastTurnCompletedAtMs === 'function'
  const connectorCompletedAt = hasConnectorCompleted ? (focusedConnector as unknown as { lastTurnCompletedAtMs: () => number | null }).lastTurnCompletedAtMs() : null
  useEffect(() => {
    if (connectorCompletedRef.current.connector !== focusedConnector) {
      connectorCompletedRef.current = { connector: focusedConnector, at: connectorCompletedAt }
      if (switchResetsTipWhenLoading && isLoading) tipPickedThisTurnRef.current = false
      wasLoadingRef.current = isLoading
      return
    }
    const completed = hasConnectorCompleted
      ? !isLoading && connectorCompletedAt !== null && connectorCompletedAt !== connectorCompletedRef.current.at
      : wasLoadingRef.current && !isLoading
    if (!isLoading) connectorCompletedRef.current.at = connectorCompletedAt
    if (completed) {
      completionEdges++
      setLastCompletedAt(Date.now())
      if (!tipPickedThisTurnRef.current) {
        tipPickedThisTurnRef.current = true
        tipsPicked++
      }
    }
    if (isLoading) tipPickedThisTurnRef.current = false
    wasLoadingRef.current = isLoading
  }, [focusedConnector, hasConnectorCompleted, connectorCompletedAt, isLoading])
  useTurnEndPing({ lastCompletedAt, busy: isLoading }, THRESHOLD_MS)
  return React.createElement(Box, null, React.createElement(Text, null, isLoading ? 'busy' : 'idle'))
}

function makeConnector(sessionId: string): InstanceType<typeof DaemonSessionConnector> {
  const transcriptDir = join(scratch, `tr-${sessionId}`)
  mkdirSync(transcriptDir, { recursive: true })
  return new DaemonSessionConnector({
    sessionId,
    runnerId: 'concourse-w1',
    title: 'ping-proof',
    projectLabel: 'work',
    workspaceId: work,
    home: transcriptDir,
  })
}

updateLastInteractionTime(true)
flushInteractionTime()
await wait(THRESHOLD_MS + 40)

const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: false }) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
const mounted = await render(
  React.createElement(TerminalWriteProvider, { value: recordWrite }, React.createElement(PingHarness)),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)

try {
  {
    const sid = '00000000-0000-4000-8000-000000000001'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 1000 } })
    writeFacts(sid, {
      busy: false,
      runner: { state: 'starting', sinceMs: 900, respawns: 0, maxRespawns: 3 },
      queue: [{ uuid: '00000000-0000-4000-8000-0000000000a1', value: 'apricot', mode: 'prompt' }],
    })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    await wait(30)
    const before = osc9Count()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 1000, lastTurnSettledAt: 1500 } })
    writeFacts(sid, { busy: false, queue: [] })
    feedFacts(c)
    check('1. unseen queued first turn: connector exposes lastTurnCompletedAtMs and advances it without busy ever reading true', typeof (c as { lastTurnCompletedAtMs?: unknown }).lastTurnCompletedAtMs === 'function' && (c as unknown as { lastTurnCompletedAtMs: () => number | null }).lastTurnCompletedAtMs() !== null && !c.live().inFlight)
    await wait(THRESHOLD_MS + 60)
    check('1b. unseen queued first turn: emits exactly 1 OSC 9 notification after the threshold', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000002'
    const base = Date.now()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: base - 500 } })
    writeFacts(sid, { busy: false })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    await wait(20)
    const before = osc9Count()
    writeFacts(sid, { busy: true })
    feedFacts(c)
    await wait(20)
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('2a. falling edge seen first (before worker stamp): pings once on the falling edge', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: base - 500, lastTurnSettledAt: base - 100 } })
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('2b. delayed worker stamp for that same turn absorbed: zero second ping', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
    const nextStart = Date.now() + 100
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: nextStart, lastTurnSettledAt: nextStart + 200 } })
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('2c. second unseen turn right after the seen one: still pings once', osc9Count() - before === 2, `delta=${osc9Count() - before}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000003'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 2000 } })
    writeFacts(sid, { busy: true })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    feedFacts(c)
    await wait(20)
    const before = osc9Count()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 2000, lastTurnSettledAt: 2500 } })
    writeFacts(sid, { busy: true })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('3a. stamp read first while busy=true holds the ping until busy clears', osc9Count() - before === 0, `delta=${osc9Count() - before}`)
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('3b. falling edge arriving after the stamp pings once total (never twice)', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000004'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 3000 } })
    writeFacts(sid, { busy: false })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    await wait(20)
    const before = osc9Count()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 3000, lastTurnSettledAt: 3500 } })
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    const afterStamp = osc9Count()
    check('4a. stamp read while idle pings once', afterStamp - before === 1, `delta=${afterStamp - before}`)
    writeFacts(sid, { busy: true })
    feedFacts(c)
    await wait(20)
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('4b. stale busy pulse for the same delivery after stamp fired is absorbed (zero second ping)', osc9Count() - afterStamp === 0, `extra=${osc9Count() - afterStamp}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000005'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 4000 } })
    writeFacts(sid, { busy: true })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    feedFacts(c)
    await wait(20)
    const before = osc9Count()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 4000, lastTurnSettledAt: 4500 } })
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('5. falling edge and settled stamp in one read: pings once', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000006'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 5000, lastTurnSettledAt: 5500 } })
    writeFacts(sid, { busy: false })
    const before = osc9Count()
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('6a. attach/resume with an existing settled stamp on disk: zero pings', osc9Count() - before === 0, `delta=${osc9Count() - before}`)
    writeFileSync(join(daemonHome, 'concourse-workers.json'), '{torn-json')
    writeFacts(sid, { busy: false })
    feedFacts(c)
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 4000, lastTurnSettledAt: 4200 } })
    writeFacts(sid, { busy: false })
    feedFacts(c)
    writeWorkers({})
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('6b. torn JSON, backwards stamp, and missing worker record (daemon handover): never throws and emits zero pings', osc9Count() - before === 0, `delta=${osc9Count() - before}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000007'
    try {
      unlinkSync(join(daemonHome, 'concourse-workers.json'))
    } catch {}
    writeFacts(sid, { busy: false })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    await wait(20)
    const before = osc9Count()
    writeFacts(sid, { busy: true })
    feedFacts(c)
    await wait(20)
    writeFacts(sid, { busy: false })
    feedFacts(c)
    await wait(THRESHOLD_MS + 60)
    check('7. session with no worker record at all behaves identically to today (falling edge pings once)', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
  }

  {
    const sid = '00000000-0000-4000-8000-000000000008'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 8000 } })
    writeFacts(sid, {
      busy: false,
      runner: { state: 'starting', sinceMs: 7900, respawns: 0, maxRespawns: 3 },
      queue: [{ uuid: '00000000-0000-4000-8000-0000000000b1', value: 'apricot', mode: 'prompt' }],
    })
    const c = makeConnector(sid)
    ;(c as unknown as { attached: boolean }).attached = true
    setFocusedSessionConnector(c)
    await wait(20)
    check('8. pre-tick: status reports the runner starting', c.status().runner?.state === 'starting')
    const before = osc9Count()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 8000, lastTurnSettledAt: 8500 } })
    writeFacts(sid, { busy: false, queue: [] })
    writeFileSync(
      c.transcriptFile(),
      encodeSeedTranscript(
        [
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000b1', timestamp: '2026-11-12T17:43:38.000Z', message: { role: 'user', content: 'apricot' } },
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: '00000000-0000-4000-8000-0000000000b1', type: 'assistant', uuid: '00000000-0000-4000-8000-0000000000b2', timestamp: '2026-11-12T17:43:41.000Z', message: { id: 'msg_b2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Apricot, as asked.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 4 } } },
        ],
        sid,
      ),
    )
    await (c as unknown as { tick: () => Promise<void> }).tick()
    const completedAfterFirstTick = c.lastTurnCompletedAtMs()
    check('8a. transcript arrival while runner is starting refreshes facts at once, clearing "the runner is starting"', c.status().runner === null, JSON.stringify(c.status().runner))
    await wait(THRESHOLD_MS + 60)
    check('8b. that same refresh picks up the settled stamp and pings once without waiting for the idle facts timer', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 9000, lastTurnSettledAt: 9500 } })
    writeFacts(sid, { busy: false, runner: { state: 'crashed', sinceMs: 9100, respawns: 1, maxRespawns: 3 } })
    writeFileSync(
      c.transcriptFile(),
      encodeSeedTranscript(
        [
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000b1', timestamp: '2026-11-12T17:43:38.000Z', message: { role: 'user', content: 'apricot' } },
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: '00000000-0000-4000-8000-0000000000b1', type: 'assistant', uuid: '00000000-0000-4000-8000-0000000000b2', timestamp: '2026-11-12T17:43:41.000Z', message: { id: 'msg_b2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Apricot, as asked.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 4 } } },
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: '00000000-0000-4000-8000-0000000000b2', type: 'user', uuid: '00000000-0000-4000-8000-0000000000b3', timestamp: '2026-11-12T17:43:45.000Z', message: { role: 'user', content: 'next' } },
        ],
        sid,
      ),
    )
    await (c as unknown as { tick: () => Promise<void> }).tick()
    check('8c. once runner is no longer starting, ordinary fast transcript ticks do not re-read facts or workers', c.status().runner === null && c.lastTurnCompletedAtMs() === completedAfterFirstTick)
    c.detach()
  }

  {
    const sid = '00000000-0000-4000-8000-000000000009'
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 10000 } })
    writeFacts(sid, { busy: false })
    const c = makeConnector(sid)
    ;(c as unknown as { attached: boolean }).attached = true
    setFocusedSessionConnector(c)
    await wait(20)
    const before = osc9Count()
    writeFileSync(
      c.transcriptFile(),
      encodeSeedTranscript(
        [
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000c1', timestamp: '2026-11-12T18:56:09.000Z', message: { role: 'user', content: 'apricot' } },
          { isSidechain: false, entrypoint: 'cli', cwd: work, sessionId: sid, version: '1.0.10', gitBranch: 'main', parentUuid: '00000000-0000-4000-8000-0000000000c1', type: 'assistant', uuid: '00000000-0000-4000-8000-0000000000c2', timestamp: '2026-11-12T18:56:12.000Z', message: { id: 'msg_c2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Apricot, as asked.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 4 } } },
        ],
        sid,
      ),
    )
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 10000, lastTurnSettledAt: 10500 } })
    writeFacts(sid, { busy: false, queue: [] })
    feedFacts(c)
    check('9a. when facts/settled stamp arrive while transcript bytes sit unread on disk, completion waits for tick to paint the reply', c.records().length === 0 ? c.lastTurnCompletedAtMs() === null : true)
    await wait(40)
    check('9b. readFacts immediately triggers tick so the settled reply paints without waiting 2s for IDLE_TRANSCRIPT_FLOOR_MS', c.records().length >= 2 && c.lastTurnCompletedAtMs() !== null, `records=${c.records().length}`)
    await wait(THRESHOLD_MS + 60)
    check('9c. ping fires once after the reply painted', osc9Count() - before === 1, `delta=${osc9Count() - before}`)
    c.detach()
  }

  {
    const sid = '00000000-0000-4000-8000-000000000010'
    const workersPath = join(daemonHome, 'concourse-workers.json')
    const buildBigBody = (deliveryAt: number, settledAt?: number): string => {
      const workers: Record<string, unknown> = {}
      const pad = 'p'.repeat(900)
      for (let i = 0; i < 1000; i++) {
        workers[`concourse-bulk-${i}`] = {
          schema: 1,
          runnerId: `concourse-bulk-${i}`,
          sessionId: `00000000-0000-4000-9100-${String(i).padStart(12, '0')}`,
          workspaceId: work,
          isolation: 'shared',
          modelKey: 'claude-opus-5-5',
          spawnedAt: 1000,
          lastLiveAt: 1000,
          endedAt: i < 990 ? 2000 : undefined,
          lastDeliveryAt: 1000,
          lastTurnSettledAt: 1500,
          settingsSnapshot: { pad },
        }
      }
      workers['concourse-w1'] = {
        schema: 1,
        runnerId: 'concourse-w1',
        sessionId: sid,
        workspaceId: work,
        isolation: 'shared',
        modelKey: 'claude-opus-5-5',
        spawnedAt: 1000,
        lastLiveAt: 1000,
        lastDeliveryAt: deliveryAt,
        ...(settledAt !== undefined ? { lastTurnSettledAt: settledAt } : {}),
        settingsSnapshot: { pad },
      }
      return JSON.stringify({ version: 1, workers })
    }

    writeFacts(sid, { busy: false })
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 1000 } })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    await wait(20)

    const origParse = JSON.parse
    let bigParses = 0
    let midReadSwap: (() => void) | null = null
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === 'string' && text.includes('"concourse-bulk-999"')) {
        bigParses++
        if (midReadSwap !== null) {
          const fn = midReadSwap
          midReadSwap = null
          fn()
        }
      }
      return origParse(text, reviver)
    }) as typeof JSON.parse

    try {
      const bodyA = buildBigBody(1000, 1500)
      writeFileSync(workersPath, bodyA)
      bigParses = 0
      for (let i = 0; i < 50; i++) {
        writeFacts(sid, { busy: false })
        feedFacts(c)
      }
      check(
        '10a. 50 facts reads over an unchanged 1,001-record workers file read and parse it once (not 50 times)',
        bigParses === 1,
        `parses=${bigParses}`,
      )

      const bodyB = buildBigBody(10000, 105000)
      writeFileSync(workersPath, bodyB)
      writeFacts(sid, { busy: false })
      const prevCompleted = c.lastTurnCompletedAtMs()
      feedFacts(c)
      check(
        '10b. a changed workers file is read at the very next facts read',
        bigParses === 2 && c.lastTurnCompletedAtMs() !== prevCompleted,
        `parses=${bigParses} completed=${c.lastTurnCompletedAtMs()} prev=${prevCompleted}`,
      )

      const sameLenA = buildBigBody(20000, 205000)
      const sameLenB = buildBigBody(30000, 305000)
      const tmpSame = `${workersPath}.samelen.tmp`
      writeFileSync(tmpSame, sameLenA)
      renameSync(tmpSame, workersPath)
      writeFacts(sid, { busy: false })
      feedFacts(c)
      const parsesBeforeSameSize = bigParses
      const completedBeforeSameSize = c.lastTurnCompletedAtMs()
      writeFileSync(tmpSame, sameLenB)
      renameSync(tmpSame, workersPath)
      writeFacts(sid, { busy: false })
      feedFacts(c)
      check(
        '10c. replacing the workers file with another of identical byte size is read at the very next call',
        Buffer.byteLength(sameLenA) === Buffer.byteLength(sameLenB) &&
          bigParses === parsesBeforeSameSize + 1 &&
          c.lastTurnCompletedAtMs() !== completedBeforeSameSize,
        `lenA=${Buffer.byteLength(sameLenA)} lenB=${Buffer.byteLength(sameLenB)} parses=${bigParses - parsesBeforeSameSize}`,
      )

      const raceInitial = buildBigBody(40000, 401000)
      const raceConcurrent = buildBigBody(40000, 409000)
      writeFileSync(tmpSame, raceInitial)
      renameSync(tmpSame, workersPath)
      midReadSwap = () => {
        const swapTmp = `${workersPath}.swap.tmp`
        writeFileSync(swapTmp, raceConcurrent)
        renameSync(swapTmp, workersPath)
      }
      const duringSave = readSessionWorkersSnapshot(daemonHome)
      const nextRead = readSessionWorkersSnapshot(daemonHome)
      check(
        '10d. stat is captured before readFileSync: a save landing mid-read is seen on the very next call',
        duringSave.state === 'known' &&
          duringSave.workers['concourse-w1']?.lastTurnSettledAt === 401000 &&
          nextRead.state === 'known' &&
          nextRead.workers['concourse-w1']?.lastTurnSettledAt === 409000,
        `first=${duringSave.state === 'known' ? duringSave.workers['concourse-w1']?.lastTurnSettledAt : 'unavail'} next=${nextRead.state === 'known' ? nextRead.workers['concourse-w1']?.lastTurnSettledAt : 'unavail'}`,
      )

      const frozenSnap = readSessionWorkersSnapshot(daemonHome)
      let threwOnMutate = false
      if (frozenSnap.state === 'known') {
        try {
          ;(frozenSnap.workers['concourse-w1'] as { lastTurnSettledAt?: number }).lastTurnSettledAt = 1
        } catch {
          threwOnMutate = true
        }
      }
      markConcourseWorkerTurnSettled('concourse-w1', daemonHome)
      const afterUpdate = readSessionWorkersSnapshot(daemonHome)
      check(
        '10e. memoized snapshot and its records are frozen against caller mutation while updateConcourseWorkers still writes cleanly',
        frozenSnap.state === 'known' &&
          Object.isFrozen(frozenSnap) &&
          Object.isFrozen(frozenSnap.workers) &&
          Object.isFrozen(frozenSnap.workers['concourse-w1']) &&
          threwOnMutate &&
          afterUpdate.state === 'known' &&
          (afterUpdate.workers['concourse-w1']?.lastTurnSettledAt ?? 0) > 409000,
        `threw=${threwOnMutate}`,
      )

      writeFileSync(workersPath, '{"version":1,"workers":{"broken')
      const tornSnap = readSessionWorkersSnapshot(daemonHome)
      unlinkSync(workersPath)
      const absentSnap = readSessionWorkersSnapshot(daemonHome)
      check(
        '10f. torn and missing workers files return unavailable and empty known as before without poisoning the memo',
        tornSnap.state === 'unavailable' && absentSnap.state === 'known' && Object.keys(absentSnap.workers).length === 0,
        `torn=${tornSnap.state} absent=${absentSnap.state}`,
      )
    } finally {
      JSON.parse = origParse
    }
  }

  {
    const sid = '00000000-0000-4000-8000-000000000011'
    writeWorkers({ 'concourse-w1': { sessionId: sid } })
    writeFacts(sid, {
      busy: false,
      runner: { state: 'starting', sinceMs: Date.now() - 100, respawns: 0, maxRespawns: 3 },
    })
    const c = makeConnector(sid)
    setFocusedSessionConnector(c)
    await wait(25)

    const compStart = completionEdges
    const pingStart = osc9Count()
    const sendId = '00000000-0000-4000-8000-0000000000e1'
    type InternalSend = { clientMessageId: string; text: string; sentAtMs: number; state: string; mode: string }
    const priv = c as unknown as {
      sends: InternalSend[]
      dressSend: (id: string, state: string) => void
      recomputeLive: () => void
    }
    priv.sends = [...priv.sends, { clientMessageId: sendId, text: 'apricot', sentAtMs: Date.now(), state: 'pending', mode: 'prompt' }]
    priv.dressSend(sendId, 'delivered')
    priv.recomputeLive()
    await wait(20)
    const seenDeliveredInFlight = c.live().inFlight

    writeFacts(sid, {
      busy: false,
      runner: { state: 'starting', sinceMs: Date.now() - 200, respawns: 0, maxRespawns: 3 },
      queue: [{ uuid: sendId, value: 'apricot', mode: 'prompt' }],
    })
    feedFacts(c)
    await wait(THRESHOLD_MS + 80)
    const earlyCompletions = completionEdges - compStart
    const earlyPings = osc9Count() - pingStart
    check(
      '11a. send observed in flight while starting, then demoted to queued: zero early completion and zero ping while queued',
      seenDeliveredInFlight && !c.live().inFlight && earlyCompletions === 0 && earlyPings === 0,
      `seenInFlight=${seenDeliveredInFlight} earlyCompletions=${earlyCompletions} earlyPings=${earlyPings}`,
    )

    const settledAt = Date.now()
    writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: settledAt - 40, lastTurnSettledAt: settledAt } })
    writeFacts(sid, { busy: false, queue: [] })
    feedFacts(c)
    await wait(THRESHOLD_MS + 80)
    const totalCompletions = completionEdges - compStart
    const totalPings = osc9Count() - pingStart
    check(
      '11b. once that queued turn actually runs and settles, exactly 1 completion and 1 ping fire at the end',
      totalCompletions === 1 && totalPings === 1,
      `totalCompletions=${totalCompletions} totalPings=${totalPings}`,
    )

    const sid2 = '00000000-0000-4000-8000-000000000012'
    try {
      unlinkSync(join(daemonHome, 'concourse-workers.json'))
    } catch {}
    writeFacts(sid2, { busy: true })
    const c2 = makeConnector(sid2)
    setFocusedSessionConnector(c2)
    feedFacts(c2)
    await wait(20)
    const comp2Start = completionEdges
    const followId = '00000000-0000-4000-8000-0000000000e2'
    const priv2 = c2 as unknown as typeof priv
    priv2.sends = [...priv2.sends, { clientMessageId: followId, text: 'second', sentAtMs: Date.now(), state: 'pending', mode: 'prompt' }]
    priv2.dressSend(followId, 'delivered')
    writeFacts(sid2, {
      busy: false,
      queue: [{ uuid: followId, value: 'second', mode: 'prompt' }],
    })
    feedFacts(c2)
    await wait(25)
    check(
      '11c. a real busy turn ending in the same facts read that demotes a follow-up send to queued still completes once',
      completionEdges - comp2Start === 1,
      `completions=${completionEdges - comp2Start}`,
    )
  }

  {
    let seq = 20
    const writeSeed = (filePath: string, sid: string, pairs: number): void => {
      const rows: Array<Record<string, unknown>> = []
      let parent: string | null = null
      for (let i = 0; i < pairs; i++) {
        const uId = `00000000-0000-4000-8000-0000000c${String(i).padStart(3, '0')}1`
        const aId = `00000000-0000-4000-8000-0000000c${String(i).padStart(3, '0')}2`
        rows.push({
          isSidechain: false,
          entrypoint: 'cli',
          cwd: work,
          sessionId: sid,
          version: '1.0.10',
          gitBranch: 'main',
          parentUuid: parent,
          type: 'user',
          uuid: uId,
          timestamp: '2026-11-12T20:00:00.000Z',
          message: { role: 'user', content: `prompt ${i}` },
        })
        rows.push({
          isSidechain: false,
          entrypoint: 'cli',
          cwd: work,
          sessionId: sid,
          version: '1.0.10',
          gitBranch: 'main',
          parentUuid: uId,
          type: 'assistant',
          uuid: aId,
          timestamp: '2026-11-12T20:00:01.000Z',
          message: {
            id: `msg_seed_${i}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: `Reply ${i}.` }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        })
        parent = aId
      }
      writeFileSync(filePath, encodeSeedTranscript(rows, sid))
    }

    const runTranscriptWaitCase = async (
      setup: (c: InstanceType<typeof DaemonSessionConnector>, sid: string) => void | (() => void),
    ): Promise<{ elapsedMs: number; painted: number; completions: number; connector: InstanceType<typeof DaemonSessionConnector>; sid: string }> => {
      const sid = `00000000-0000-4000-8000-0000000000${++seq}`
      writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 50000 } })
      writeFacts(sid, { busy: false })
      const c = makeConnector(sid)
      ;(c as unknown as { attached: boolean }).attached = true
      setFocusedSessionConnector(c)
      await wait(20)
      const cleanup = setup(c, sid)
      const compBefore = completionEdges
      writeWorkers({ 'concourse-w1': { sessionId: sid, lastDeliveryAt: 50000, lastTurnSettledAt: 50500 } })
      writeFacts(sid, { busy: false })
      const t0 = Date.now()
      feedFacts(c)
      let elapsedMs = -1
      for (let i = 0; i < 300; i++) {
        if (c.lastTurnCompletedAtMs() !== null) {
          elapsedMs = Date.now() - t0
          break
        }
        await wait(10)
        if (i % 20 === 19) {
          writeFacts(sid, { busy: false })
          feedFacts(c)
        }
      }
      await wait(25)
      const painted = c.records().length
      const completions = completionEdges - compBefore
      if (typeof cleanup === 'function') cleanup()
      return { elapsedMs, painted, completions, connector: c, sid }
    }

    const n1 = await runTranscriptWaitCase((c, sid) => writeSeed(c.transcriptFile(), sid, 1))
    n1.connector.detach()
    check('12a (N1). unread reply on disk paints first and completes promptly', n1.elapsedMs >= 0 && n1.elapsedMs < 250 && n1.painted === 2 && n1.completions === 1, JSON.stringify({ ms: n1.elapsedMs, painted: n1.painted, completions: n1.completions }))

    const n2 = await runTranscriptWaitCase(() => {})
    n2.connector.detach()
    check('12b (N2). absent transcript file completes at once', n2.elapsedMs >= 0 && n2.elapsedMs < 80 && n2.painted === 0 && n2.completions === 1, JSON.stringify({ ms: n2.elapsedMs, painted: n2.painted, completions: n2.completions }))

    const n3 = await runTranscriptWaitCase(c => writeFileSync(c.transcriptFile(), ''))
    n3.connector.detach()
    check('12c (N3). empty transcript file completes at once', n3.elapsedMs >= 0 && n3.elapsedMs < 80 && n3.painted === 0 && n3.completions === 1, JSON.stringify({ ms: n3.elapsedMs, painted: n3.painted, completions: n3.completions }))

    const n4 = await runTranscriptWaitCase((c, sid) => {
      writeSeed(c.transcriptFile(), sid, 1)
      let count = 2
      const iv = setInterval(() => {
        writeSeed(c.transcriptFile(), sid, count++)
        if (count > 80) clearInterval(iv)
      }, 10)
      return () => clearInterval(iv)
    })
    n4.connector.detach()
    check('12d (N4). continuously growing transcript still completes promptly without starving', n4.elapsedMs >= 0 && n4.elapsedMs < 300 && n4.painted >= 2 && n4.completions === 1, JSON.stringify({ ms: n4.elapsedMs, painted: n4.painted, completions: n4.completions }))

    const n5 = await runTranscriptWaitCase(c => writeFileSync(c.transcriptFile(), 'not-json-at-all\n'))
    n5.connector.detach()
    check('12e (N5). non-JSON garbage line ends the wait and completes once', n5.elapsedMs >= 0 && n5.elapsedMs < 250 && n5.painted === 0 && n5.completions === 1, JSON.stringify({ ms: n5.elapsedMs, painted: n5.painted, completions: n5.completions }))

    const n6 = await runTranscriptWaitCase((c, sid) => {
      writeSeed(c.transcriptFile(), sid, 1)
      const p = c.transcriptFile()
      writeFileSync(p, `${readFileSync(p, 'utf8')}{"type":"assistant","uuid":"torn-row`)
    })
    n6.connector.detach()
    check('12f (N6). transcript ending in a torn row paints the whole rows and completes once', n6.elapsedMs >= 0 && n6.elapsedMs < 250 && n6.painted === 2 && n6.completions === 1, JSON.stringify({ ms: n6.elapsedMs, painted: n6.painted, completions: n6.completions }))

    const n7 = await runTranscriptWaitCase((c, sid) => {
      writeSeed(c.transcriptFile(), sid, 1)
      chmodSync(c.transcriptFile(), 0o000)
    })
    try {
      chmodSync(n7.connector.transcriptFile(), 0o600)
      await (n7.connector as unknown as { tick: () => Promise<void> }).tick()
      const recoveredRows = n7.connector.records().length
      check(
        '12g (N7). unreadable transcript (mode 000) ends the wait as fast as an unread reply instead of holding completion forever, and still loads once permissions recover',
        n7.elapsedMs >= 0 &&
          n7.elapsedMs < 250 &&
          n7.completions === 1 &&
          (process.getuid?.() === 0 ? n7.painted >= 0 : n7.painted === 0) &&
          recoveredRows === 2,
        JSON.stringify({ ms: n7.elapsedMs, paintedWhile000: n7.painted, completions: n7.completions, recoveredRows }),
      )
    } finally {
      try {
        chmodSync(n7.connector.transcriptFile(), 0o600)
      } catch {}
      n7.connector.detach()
    }
  }

  {
    const sidA = '00000000-0000-4000-8000-000000000031'
    const sidB = '00000000-0000-4000-8000-000000000032'
    writeWorkers({
      'concourse-w1': { sessionId: sidA, lastDeliveryAt: 60000 },
      'concourse-w2': { sessionId: sidB, lastDeliveryAt: 60100 },
    })
    writeFacts(sidA, { busy: true })
    writeFacts(sidB, { busy: true })
    const cA = makeConnector(sidA)
    const cB = makeConnector(sidB)
    setFocusedSessionConnector(cA)
    feedFacts(cA)
    feedFacts(cB)
    await wait(25)

    const tipsStart = tipsPicked
    writeWorkers({
      'concourse-w1': { sessionId: sidA, lastDeliveryAt: 60000, lastTurnSettledAt: 60500 },
      'concourse-w2': { sessionId: sidB, lastDeliveryAt: 60100 },
    })
    writeFacts(sidA, { busy: false })
    feedFacts(cA)
    await wait(25)

    const compBeforeSwitchToBusy = completionEdges
    setFocusedSessionConnector(cB)
    await wait(25)

    setFocusedSessionConnector(cA)
    await wait(25)
    const falseCompletionsOnBusyToIdleSwitch = completionEdges - compBeforeSwitchToBusy

    setFocusedSessionConnector(cB)
    await wait(25)
    writeWorkers({
      'concourse-w1': { sessionId: sidA, lastDeliveryAt: 60000, lastTurnSettledAt: 60500 },
      'concourse-w2': { sessionId: sidB, lastDeliveryAt: 60100, lastTurnSettledAt: 60900 },
    })
    writeFacts(sidB, { busy: false })
    feedFacts(cB)
    await wait(25)

    check(
      '13. switching focus from an idle completed session to a busy session resets tipPickedThisTurnRef so the busy session picks its turn tip on settle, while busy-to-idle switch fires zero false completions',
      falseCompletionsOnBusyToIdleSwitch === 0 && tipsPicked - tipsStart === 2,
      JSON.stringify({ falseCompletionsOnBusyToIdleSwitch, tipsDelta: tipsPicked - tipsStart }),
    )
  }
} finally {
  mounted.unmount()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-queued-start-turn-ping: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
