#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-protocol.ts
//  PROOF: the REAL UnityBridgeClient against the scripted fake bridge —
//  zero editor, zero network beyond loopback ephemeral ports, gate-safe.
//
//   §1  HANDSHAKE — good token ⇒ ready + round-trip; bad token ⇒ AUTH_FAILED
//       with the install-teaching hint.
//   §2  VERSION SKEW, BOTH ARMS — a server demanding protocol 2 refuses the
//       v1 hello typed (VERSION_SKEW naming both); a server ACCEPTING the
//       hello but claiming result.version 2 is refused BY THE CLIENT
//       (BRIDGE_VERSION_SKEW) with zero ops sent across the gap.
//   §3  CORRELATION — 10 interleaved hierarchy_read calls with distinct caps
//       each land on their own promise.
//   §4  HEARTBEAT — pings on the wire at the injected cadence; a missed pong
//       destroys (wedged editor ⇒ dead connection, not a hang).
//   §5  BACKOFF — doubling with the error+close single-fire guard, the
//       fast-fail window's typed EDITOR_UNREACHABLE with the teaching hint,
//       reconnect after the window, reset on success.
//   §6  EVENTS — play_state_changed buffers + drains (no-reload play).
//   §7  TIMEOUT + OVERSIZE — REQUEST_TIMEOUT names the op; a 9MiB frame
//       kills the connection instead of buffering forever.
//   §8  PB-1 — squatted-port dribble settles bounded; garbage first line
//       dies fast; a queued request keeps its OWN deadline.
//   §9  THE DOMAIN-RELOAD LAW — play_enter acks {willReload:true} BEFORE the
//       drop; the drop is typed as the by-design reload; the next request
//       after the window reconnects and sees isPlaying:true.
//   §10 ACCEPT-NEWEST — a second client's hello drops the first.
//   §11 TESTS ROAD — tests_run acks started:true; the fixture XML lands at
//       resultsPath and the LANDED parseUnityTestResults reads it (never a
//       second parser); the test_run_finished event's counts agree with the
//       file's own parse; RUN_IN_FLIGHT refuses a second concurrent run.
//   §12 ERROR ARMS — UNKNOWN_OP (verb-list hint), BAD_ARGS, SCENE_NOT_FOUND,
//       SCENE_DIRTY (the save-road hint), PLAY_MODE_ACTIVE.
// ============================================================================

import * as net from 'node:net'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { UnityBridgeClient } from '../../src/services/unity/bridgeClient.js'
import { parseUnityTestResults } from '../../src/services/ide/unityTests.js'
import { startFakeUnityBridge } from './fake-bridge.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const FAST = {
  heartbeatMs: 120,
  pongTimeoutMs: 80,
  backoffStartMs: 60,
  backoffCapMs: 240,
  connectTimeoutMs: 500,
  helloTimeoutMs: 500,
}

async function main(): Promise<void> {
  section('1. handshake — good + bad token')
  {
    const srv = await startFakeUnityBridge({ token: 'tok-good' })
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok-good', ...FAST })
    const r = await client.request('play_state')
    check('good token round-trip', r.ok === true && (r as { result: { isPlaying: boolean } }).result.isPlaying === false)
    check('status ready', client.status() === 'ready')
    check('helloInfo captured (bridge + unity + project)', /com\.mercury\.unity-bridge/.test(client.helloInfo()?.bridge ?? '') && client.helloInfo()?.project === 'fixture')
    client.close()

    const bad = new UnityBridgeClient({ port: srv.port, token: 'tok-WRONG', ...FAST })
    const rb = await bad.request('play_state')
    check('bad token ⇒ AUTH_FAILED', !rb.ok && rb.error.code === 'AUTH_FAILED', JSON.stringify(!rb.ok ? rb.error : {}))
    check('refusal hint teaches unity_bridge_install', !rb.ok && /unity_bridge_install/.test(rb.error.hint ?? ''))
    bad.close()
    await srv.close()
  }

  section('2. version skew — the server arm and the client arm')
  {
    const demanding = await startFakeUnityBridge({ protocolVersion: 2 })
    const c1 = new UnityBridgeClient({ port: demanding.port, token: 'tok', ...FAST })
    const r1 = await c1.request('play_state')
    check('server demanding v2 refuses the v1 hello typed', !r1.ok && r1.error.code === 'VERSION_SKEW', !r1.ok ? r1.error.code : 'ok?!')
    check('the skew message names both versions', !r1.ok && /2/.test(r1.error.message) && /1/.test(r1.error.message))
    c1.close()
    await demanding.close()

    const lying = await startFakeUnityBridge({ helloResultVersion: 2 })
    const c2 = new UnityBridgeClient({ port: lying.port, token: 'tok', ...FAST })
    const r2 = await c2.request('play_state')
    check('an ok-hello claiming v2 is refused CLIENT-side', !r2.ok && r2.error.code === 'BRIDGE_VERSION_SKEW', !r2.ok ? r2.error.code : 'ok?!')
    check('no op crossed the version gap', !lying.seenOps.includes('play_state'), lying.seenOps.join(','))
    check('the client did not go ready', c2.status() !== 'ready')
    c2.close()
    await lying.close()
  }

  section('3. correlation — 10 interleaved requests, each on its own promise')
  {
    const srv = await startFakeUnityBridge()
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.request('hierarchy_read', { maxNodes: i + 1 })),
    )
    // The fixture holds 5 nodes total; cap i+1 keeps min(5, i+1).
    const allMatch = results.every((r, i) => {
      if (!r.ok) return false
      const h = r.result as { nodeCount: number; truncatedNodes: number }
      return h.nodeCount === 5 && h.truncatedNodes === Math.max(0, 5 - (i + 1))
    })
    check('each answer carries its own cap’s truncation', allMatch)
    client.close()
    await srv.close()
  }

  section('4. heartbeat — pings flow; missed pong destroys')
  {
    const srv = await startFakeUnityBridge()
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await client.request('play_state')
    await sleep(300)
    check('pings observed on the wire', srv.seenOps.filter(o => o === 'ping').length >= 1, `${srv.seenOps.filter(o => o === 'ping').length} pings`)
    check('still ready while pongs answered', client.status() === 'ready')
    srv.setMode('no-pong')
    await sleep(400)
    check('missed pong ⇒ connection destroyed', client.status() === 'disconnected')
    client.close()
    await srv.close()
  }

  section('5. backoff — fast-fail window, doubling, reset on success')
  {
    const deadPort = await new Promise<number>(resolve => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const client = new UnityBridgeClient({ port: deadPort, token: 'tok', ...FAST })
    check('initial next-delay = start', client.nextDelayMs() === FAST.backoffStartMs)
    const r1 = await client.request('play_state')
    check('connect failure surfaces (handshake class)', !r1.ok && (r1.error.code === 'HANDSHAKE_CLOSED' || r1.error.code === 'CONNECTION_LOST'), !r1.ok ? r1.error.code : '')
    check('one failure doubles ONCE (error+close guard)', client.nextDelayMs() === FAST.backoffStartMs * 2, `${client.nextDelayMs()}`)
    const r2 = await client.request('play_state')
    check('inside the window ⇒ EDITOR_UNREACHABLE fast-fail', !r2.ok && r2.error.code === 'EDITOR_UNREACHABLE')
    check('fast-fail hint teaches install + status', !r2.ok && /unity_bridge_install/.test(r2.error.hint ?? '') && /unity_status/.test(r2.error.hint ?? ''))
    await sleep(FAST.backoffStartMs + 30)
    const r3 = await client.request('play_state')
    check('after the window a reconnect is attempted', !r3.ok && r3.error.code !== 'EDITOR_UNREACHABLE', !r3.ok ? r3.error.code : '')
    check('second failure doubles again', client.nextDelayMs() === FAST.backoffStartMs * 4, `${client.nextDelayMs()}`)
    client.close()

    const srv = await startFakeUnityBridge()
    const c2 = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await c2.request('play_state')
    srv.setMode('drop-on-request')
    const rd = await c2.request('scene_list')
    check('mid-flight drop ⇒ CONNECTION_LOST', !rd.ok && rd.error.code === 'CONNECTION_LOST')
    check('drop armed backoff', c2.nextDelayMs() === FAST.backoffStartMs * 2)
    srv.setMode('echo')
    await sleep(FAST.backoffStartMs + 30)
    const rr = await c2.request('play_state')
    check('reconnects and answers after the window', rr.ok === true)
    check('success RESETS backoff', c2.nextDelayMs() === FAST.backoffStartMs, `${c2.nextDelayMs()}`)
    c2.close()
    await srv.close()
  }

  section('6. events — play_state_changed buffers + drains (no-reload play)')
  {
    const srv = await startFakeUnityBridge({ willReloadOnPlay: false })
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const pe = await client.request('play_enter')
    check('no-reload play_enter answers willReload:false', pe.ok === true && (pe as { result: { willReload: boolean } }).result.willReload === false)
    await sleep(50)
    const events = client.drainEvents()
    check('play_state_changed buffered', events.length === 1 && events[0]?.event === 'play_state_changed')
    check('the event carries the play state', (events[0]?.data as { playState: { isPlaying: boolean } }).playState.isPlaying === true)
    check('drain clears', client.drainEvents().length === 0)
    client.close()
    await srv.close()
  }

  section('7. timeout + oversize')
  {
    const srv = await startFakeUnityBridge({ mode: 'silent-after-hello' })
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const rt = await client.request('scene_list', undefined, 100)
    check('unanswered request ⇒ REQUEST_TIMEOUT naming the op', !rt.ok && rt.error.code === 'REQUEST_TIMEOUT' && /scene_list/.test(rt.error.message))
    client.close()
    await srv.close()

    const srv2 = await startFakeUnityBridge({ mode: 'oversize-on-request' })
    const c2 = new UnityBridgeClient({ port: srv2.port, token: 'tok', ...FAST })
    const ro = await c2.request('scene_list', undefined, 2_000)
    check('oversized frame kills the connection (no forever-buffer)', !ro.ok && ro.error.code === 'CONNECTION_LOST', !ro.ok ? ro.error.code : 'ok?!')
    c2.close()
    await srv2.close()
  }

  section('8. PB-1 — squatted port, garbage handshake, queued-request deadlines')
  {
    const squatted = await new Promise<{ port: number; close: () => void }>(resolve => {
      const sockets = new Set<net.Socket>()
      const server = net.createServer(socket => {
        sockets.add(socket)
        socket.write('GARBAGE-NOT-A-FRAME') // no newline, never a frame
        const drip = setInterval(() => socket.write('.'), 50)
        socket.on('close', () => {
          clearInterval(drip)
          sockets.delete(socket)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          close: () => {
            for (const s of sockets) s.destroy()
            server.close()
          },
        })
      })
    })
    const t0 = Date.now()
    const client = new UnityBridgeClient({ port: squatted.port, token: 'tok', ...FAST })
    const r = await client.request('play_state', undefined, 1_500)
    const elapsed = Date.now() - t0
    check('squatted-port request SETTLES bounded (typed, no forever-connecting)', !r.ok && elapsed < 3_000, `elapsed=${elapsed}ms`)
    check("state is not wedged in 'connecting'", client.status() !== 'connecting', client.status())
    client.close()
    squatted.close()

    const garbler = await new Promise<{ port: number; close: () => void }>(resolve => {
      const sockets = new Set<net.Socket>()
      const server = net.createServer(socket => {
        sockets.add(socket)
        socket.write('THIS IS NOT JSON\n')
        socket.on('close', () => sockets.delete(socket))
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          close: () => {
            for (const s of sockets) s.destroy()
            server.close()
          },
        })
      })
    })
    const t1 = Date.now()
    const c2 = new UnityBridgeClient({ port: garbler.port, token: 'tok', ...FAST })
    const r2 = await c2.request('play_state', undefined, 1_500)
    check('unparseable handshake payload dies FAST (typed, well under the request timeout)', !r2.ok && Date.now() - t1 < 1_200, `elapsed=${Date.now() - t1}ms`)
    c2.close()
    garbler.close()

    const silent = await new Promise<{ port: number; close: () => void }>(resolve => {
      const sockets = new Set<net.Socket>()
      const server = net.createServer(socket => {
        sockets.add(socket) // accept, say nothing, keep the socket open
        socket.on('close', () => sockets.delete(socket))
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          close: () => {
            for (const s of sockets) s.destroy()
            server.close()
          },
        })
      })
    })
    const c3 = new UnityBridgeClient({ port: silent.port, token: 'tok', ...FAST, helloTimeoutMs: 30_000 })
    const t2 = Date.now()
    const r3 = await c3.request('scene_list', undefined, 400)
    check('queued request times out on ITS OWN deadline (handshake still pending)',
      !r3.ok && r3.error.code === 'REQUEST_TIMEOUT' && /scene_list/.test(r3.error.message) && Date.now() - t2 < 1_500,
      `elapsed=${Date.now() - t2}ms`)
    c3.close()
    silent.close()
  }

  section('9. the domain-reload law — ack, drop, reconnect, state carried')
  {
    const srv = await startFakeUnityBridge() // willReloadOnPlay: true (default)
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const pe = await client.request('play_enter')
    check('the ack ARRIVES BEFORE the reload drop, carrying willReload:true', pe.ok === true && (pe as { result: { willReload: boolean } }).result.willReload === true)
    await sleep(60)
    check('the reload dropped the connection', client.status() === 'disconnected')
    const inWindow = await client.request('play_state')
    check('the drop armed the fast-fail window', !inWindow.ok)
    await sleep(FAST.backoffStartMs * 2 + 60)
    const after = await client.request('play_state')
    check('the next request after the window reconnects (fresh hello) and play state survived the reload',
      after.ok === true && (after as { result: { isPlaying: boolean } }).result.isPlaying === true,
      after.ok ? '' : after.error.code)
    check('the reconnect really is a second connection', srv.connectionCount() >= 2, `${srv.connectionCount()}`)
    client.close()
    await srv.close()
  }

  section('10. accept-newest AT HELLO TIME — a probe cannot kick the client; a second hello can')
  {
    const srv = await startFakeUnityBridge()
    const a = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await a.request('play_state')
    check('A ready', a.status() === 'ready')
    // A bare connect that never hellos (the reachability-probe shape) must
    // NOT displace the authed client.
    await new Promise<void>(resolve => {
      const probe = net.connect({ host: '127.0.0.1', port: srv.port }, () => {
        probe.destroy()
        resolve()
      })
      probe.once('error', () => resolve())
    })
    await sleep(30)
    check('a bare connect+drop leaves A ready (probe immunity)', a.status() === 'ready')
    const stillAlive = await a.request('play_state')
    check('A still answers after the probe', stillAlive.ok === true)
    const b = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const rb = await b.request('play_state')
    check('B connects and answers', rb.ok === true && b.status() === 'ready')
    await sleep(30)
    check('A was dropped by the accept-newest law', a.status() === 'disconnected')
    const rb2 = await b.request('scene_list')
    check('B lives on', rb2.ok === true)
    a.close()
    b.close()
    await srv.close()
  }

  section('11. the tests road — ack, fixture XML at resultsPath, the LANDED parser, event agreement')
  {
    const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-tests-'))
    const resultsPath = path.join(scratch, '.mercury', 'unity-test-results', 'editmode.xml')
    const srv = await startFakeUnityBridge({ testRunDurationMs: 40 })
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const tr = await client.request('tests_run', { mode: 'EditMode', resultsPath })
    check('tests_run acks started:true with the resultsPath echoed',
      tr.ok === true && (tr as { result: { started: boolean; resultsPath: string } }).result.started === true &&
        (tr as { result: { resultsPath: string } }).result.resultsPath === resultsPath)
    const second = await client.request('tests_run', { mode: 'EditMode', resultsPath })
    check('a second concurrent run refuses RUN_IN_FLIGHT', !second.ok && second.error.code === 'RUN_IN_FLIGHT')
    await sleep(120)
    check('the results XML landed at resultsPath', existsSync(resultsPath))
    const parsed = parseUnityTestResults(readFileSync(resultsPath, 'utf8'))
    check('the LANDED parser reads it (never a second parser)', parsed.state === 'ok' && parsed.counts.passed === 3, parsed.state)
    const finished = client.drainEvents().find(e => e.event === 'test_run_finished')
    const data = finished?.data as { resultsPath: string; passed: number } | undefined
    check('test_run_finished event carries the same path + counts as the file’s own parse',
      data?.resultsPath === resultsPath && parsed.state === 'ok' && data?.passed === parsed.counts.passed)
    const rerun = await client.request('tests_run', { mode: 'EditMode', resultsPath })
    check('after completion a new run starts again', rerun.ok === true)
    client.close()
    await srv.close()
  }

  section('12. error arms — every refusal typed and teaching')
  {
    const srv = await startFakeUnityBridge()
    const client = new UnityBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const unknown = await client.request('scene_play')
    check('UNKNOWN_OP with the verb list in the hint',
      !unknown.ok && unknown.error.code === 'UNKNOWN_OP' && /tests_run/.test(unknown.error.hint ?? ''))
    const badPause = await client.request('play_pause')
    check('BAD_ARGS: play_pause without paused', !badPause.ok && badPause.error.code === 'BAD_ARGS')
    const escape = await client.request('scene_open', { path: '../outside.unity' })
    check('BAD_ARGS: a path escaping the project', !escape.ok && escape.error.code === 'BAD_ARGS')
    const missing = await client.request('scene_open', { path: 'Assets/Scenes/Nope.unity' })
    check('SCENE_NOT_FOUND', !missing.ok && missing.error.code === 'SCENE_NOT_FOUND')
    srv.setActiveSceneDirty(true)
    const dirty = await client.request('scene_open', { path: 'Assets/Scenes/Loading.unity' })
    check('SCENE_DIRTY names the save road, never a silent discard',
      !dirty.ok && dirty.error.code === 'SCENE_DIRTY' && /save/i.test(dirty.error.hint ?? ''))
    srv.setActiveSceneDirty(false)
    const open = await client.request('scene_open', { path: 'Assets/Scenes/Loading.unity' })
    check('the clean open succeeds Single', open.ok === true && (open as { result: { mode: string } }).result.mode === 'Single')
    const additive = await client.request('scene_open', { path: 'Assets/Scenes/Main.unity', additive: true })
    check('an additive open succeeds Additive', additive.ok === true && (additive as { result: { mode: string } }).result.mode === 'Additive')
    const stoppedExit = await client.request('play_exit')
    check('PLAY_MODE_ACTIVE: play_exit while stopped', !stoppedExit.ok && stoppedExit.error.code === 'PLAY_MODE_ACTIVE')
    const tail = await client.request('console_tail', { severity: 'warning' })
    check('console_tail severity floor + honest dropped count',
      tail.ok === true &&
        (tail as { result: { entries: Array<{ severity: string }>; dropped: number } }).result.entries.every(e => e.severity !== 'log') &&
        (tail as { result: { dropped: number } }).result.dropped === 2)
    client.close()
    await srv.close()
  }

  console.log('\n' + (failures === 0 ? '✅ unity-bridge protocol proof PASS' : `❌ ${failures} FAILURES`))
  process.exit(failures === 0 ? 0 : 1)
}

void main()
