#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
const { hasSeatLive, IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const {
  getFocusedSessionConnector,
  setFocusedSessionConnector,
  subscribeFocusedSessionConnector,
  subscribeThroughFocused,
} = await import('../../src/services/engine-connector/focusedConnector.ts')
import type { SessionFactsV1 } from '../../src/services/engine-connector/seatProjections.ts'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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

const THRESHOLD_MS = 80
const writes: string[] = []
const recordWrite = (s: string): void => {
  writes.push(s)
}
const osc9Count = (): number => writes.filter(w => w.includes(']9;') && w.includes(PING_MESSAGE)).length

function PingHarness(): React.ReactNode {
  const focusedConnector = useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedSessionConnector, getFocusedSessionConnector)
  const seatLive = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedSeatLive, getFocusedSeatLive)
  const isLoading = seatLive.inFlight
  const [lastCompletedAt, setLastCompletedAt] = useState<number | null>(null)
  const wasLoadingRef = useRef(false)
  const connectorCompletedRef = useRef<{ connector: unknown; at: number | null }>({ connector: null, at: null })
  const hasConnectorCompleted = typeof (focusedConnector as { lastTurnCompletedAtMs?: unknown }).lastTurnCompletedAtMs === 'function'
  const connectorCompletedAt = hasConnectorCompleted ? (focusedConnector as unknown as { lastTurnCompletedAtMs: () => number | null }).lastTurnCompletedAtMs() : null
  useEffect(() => {
    if (connectorCompletedRef.current.connector !== focusedConnector) {
      connectorCompletedRef.current = { connector: focusedConnector, at: connectorCompletedAt }
      wasLoadingRef.current = isLoading
      return
    }
    const completed = hasConnectorCompleted
      ? !isLoading && connectorCompletedAt !== null && connectorCompletedAt !== connectorCompletedRef.current.at
      : wasLoadingRef.current && !isLoading
    if (!isLoading) connectorCompletedRef.current.at = connectorCompletedAt
    if (completed) {
      setLastCompletedAt(Date.now())
    }
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
} finally {
  mounted.unmount()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-queued-start-turn-ping: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
