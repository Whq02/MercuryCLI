#!/usr/bin/env bun
// ============================================================================
//  scripts/blender-bridge/prove-blender-bridge-protocol.ts
//  PROOF: the REAL BlenderBridgeClient against the scripted fake bridge —
//  zero Blender, zero network beyond loopback ephemeral ports, gate-safe.
//
//   §1  HANDSHAKE — good token ⇒ ready + round-trip; bad token ⇒ AUTH_FAILED
//       with the install-teaching hint.
//   §2  VERSION SKEW, BOTH ARMS — a server demanding protocol 2 refuses the
//       v1 hello typed (VERSION_SKEW naming both); a server ACCEPTING the
//       hello but claiming result.version 2 is refused BY THE CLIENT
//       (BRIDGE_VERSION_SKEW) with zero ops sent across the gap.
//   §3  CORRELATION — 10 interleaved objects_list calls with distinct caps
//       each land on their own promise.
//   §4  HEARTBEAT — pings on the wire at the injected cadence; a missed pong
//       destroys (wedged Blender ⇒ dead connection, not a hang).
//   §5  BACKOFF — doubling with the error+close single-fire guard, the
//       fast-fail window's typed EDITOR_UNREACHABLE with the teaching hint
//       (which names the ENABLE step — the Blender-specific road), reconnect
//       after the window, reset on success.
//   §6  EVENTS — a by-hand open (the @persistent load_post analog) surfaces
//       as blend_changed; buffers + drains.
//   §7  TIMEOUT + OVERSIZE — REQUEST_TIMEOUT names the op; a 9MiB frame
//       kills the connection instead of buffering forever.
//   §8  hostile servers — squatted-port dribble settles bounded; garbage
//       first line dies fast; a queued request keeps its OWN deadline.
//   §9  THE NO-RELOAD LAW (the deliberate INVERSE of unity §9) — blend_open
//       answers AND THE CONNECTION HOLDS: status stays ready, the follow-up
//       op rides the SAME connection (connectionCount stays 1), and
//       scene_info shows the new file. Any future drop across blend_open is
//       a DEFECT, not a documented law.
//   §10 ACCEPT-NEWEST — a bare probe cannot kick the authed client; a second
//       client's hello can.
//   §11 THE RENDER ROAD — render_still acks started:true; the DURABLE FILE
//       lands at outputPath; the render_finished event agrees with the file;
//       DURING the job: a second render_still, blend_open, and python_run
//       all refuse RENDER_ACTIVE while render_state READS FREE showing
//       jobs.render true (the mutate/exec-only ruling); after completion a
//       new render starts; the cancel lever answers ok:false/cancelled:true
//       and writes NOTHING.
//   §12 ERROR ARMS + python_run shapes — UNKNOWN_OP (verb-list hint),
//       BAD_ARGS (source over the 64KiB cap), BLEND_NOT_FOUND, BLEND_DIRTY
//       (the save-road hint), PYTHON_EXCEPTION (type+message, traceback tail
//       in the hint), the value/stdout/truncation result shapes, report_tail
//       severity floor + honest dropped count.
// ============================================================================

import * as net from 'node:net'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { BlenderBridgeClient } from '../../src/services/blender/bridgeClient.js'
import { BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES } from '../../src/services/blender/bridgeProtocol.js'
import { startFakeBlenderBridge } from './fake-bridge.js'

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
    const srv = await startFakeBlenderBridge({ token: 'tok-good' })
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok-good', ...FAST })
    const r = await client.request('scene_info')
    check('good token round-trip', r.ok === true && (r as { result: { engine: string } }).result.engine === 'BLENDER_EEVEE_NEXT')
    check('status ready', client.status() === 'ready')
    check('helloInfo captured (bridge + blender + blendFile)', /mercury_blender_bridge/.test(client.helloInfo()?.bridge ?? '') && client.helloInfo()?.blendFile === '/work/studio/scene.blend')
    client.close()

    const bad = new BlenderBridgeClient({ port: srv.port, token: 'tok-WRONG', ...FAST })
    const rb = await bad.request('scene_info')
    check('bad token ⇒ AUTH_FAILED', !rb.ok && rb.error.code === 'AUTH_FAILED', JSON.stringify(!rb.ok ? rb.error : {}))
    check('refusal hint teaches blender_bridge_install', !rb.ok && /blender_bridge_install/.test(rb.error.hint ?? ''))
    bad.close()
    await srv.close()
  }

  section('2. version skew — the server arm and the client arm')
  {
    const demanding = await startFakeBlenderBridge({ protocolVersion: 2 })
    const c1 = new BlenderBridgeClient({ port: demanding.port, token: 'tok', ...FAST })
    const r1 = await c1.request('scene_info')
    check('server demanding v2 refuses the v1 hello typed', !r1.ok && r1.error.code === 'VERSION_SKEW', !r1.ok ? r1.error.code : 'ok?!')
    check('the skew message names both versions', !r1.ok && /2/.test(r1.error.message) && /1/.test(r1.error.message))
    c1.close()
    await demanding.close()

    const lying = await startFakeBlenderBridge({ helloResultVersion: 2 })
    const c2 = new BlenderBridgeClient({ port: lying.port, token: 'tok', ...FAST })
    const r2 = await c2.request('scene_info')
    check('an ok-hello claiming v2 is refused CLIENT-side', !r2.ok && r2.error.code === 'BRIDGE_VERSION_SKEW', !r2.ok ? r2.error.code : 'ok?!')
    check('no op crossed the version gap', !lying.seenOps.includes('scene_info'), lying.seenOps.join(','))
    check('the client did not go ready', c2.status() !== 'ready')
    c2.close()
    await lying.close()
  }

  section('3. correlation — 10 interleaved requests, each on its own promise')
  {
    const srv = await startFakeBlenderBridge()
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.request('objects_list', { maxObjects: i + 1 })),
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
    const srv = await startFakeBlenderBridge()
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await client.request('scene_info')
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
    const client = new BlenderBridgeClient({ port: deadPort, token: 'tok', ...FAST })
    check('initial next-delay = start', client.nextDelayMs() === FAST.backoffStartMs)
    const r1 = await client.request('scene_info')
    check('connect failure surfaces (handshake class)', !r1.ok && (r1.error.code === 'HANDSHAKE_CLOSED' || r1.error.code === 'CONNECTION_LOST'), !r1.ok ? r1.error.code : '')
    check('one failure doubles ONCE (error+close guard)', client.nextDelayMs() === FAST.backoffStartMs * 2, `${client.nextDelayMs()}`)
    const r2 = await client.request('scene_info')
    check('inside the window ⇒ EDITOR_UNREACHABLE fast-fail', !r2.ok && r2.error.code === 'EDITOR_UNREACHABLE')
    check('fast-fail hint teaches install + ENABLE + status (the Blender road)',
      !r2.ok && /blender_bridge_install/.test(r2.error.hint ?? '') && /enable/i.test(r2.error.hint ?? '') && /blender_status/.test(r2.error.hint ?? ''))
    await sleep(FAST.backoffStartMs + 30)
    const r3 = await client.request('scene_info')
    check('after the window a reconnect is attempted', !r3.ok && r3.error.code !== 'EDITOR_UNREACHABLE', !r3.ok ? r3.error.code : '')
    check('second failure doubles again', client.nextDelayMs() === FAST.backoffStartMs * 4, `${client.nextDelayMs()}`)
    client.close()

    const srv = await startFakeBlenderBridge()
    const c2 = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await c2.request('scene_info')
    srv.setMode('drop-on-request')
    const rd = await c2.request('render_state')
    check('mid-flight drop ⇒ CONNECTION_LOST (and the message speaks quit/disabled, NEVER a by-design reload)',
      !rd.ok && rd.error.code === 'CONNECTION_LOST' && !/reload does this by design/.test(rd.error.message))
    check('drop armed backoff', c2.nextDelayMs() === FAST.backoffStartMs * 2)
    srv.setMode('echo')
    await sleep(FAST.backoffStartMs + 30)
    const rr = await c2.request('scene_info')
    check('reconnects and answers after the window', rr.ok === true)
    check('success RESETS backoff', c2.nextDelayMs() === FAST.backoffStartMs, `${c2.nextDelayMs()}`)
    c2.close()
    await srv.close()
  }

  section('6. events — blend_changed (the load_post analog) buffers + drains')
  {
    const srv = await startFakeBlenderBridge()
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await client.request('scene_info')
    srv.openBlendExternally('/work/studio/assets/props.blend')
    await sleep(50)
    const events = client.drainEvents()
    check('blend_changed buffered', events.length === 1 && events[0]?.event === 'blend_changed')
    check('the event carries the new filepath', (events[0]?.data as { filepath: string }).filepath === '/work/studio/assets/props.blend')
    check('drain clears', client.drainEvents().length === 0)
    check('the connection HELD across the external open', client.status() === 'ready')
    client.close()
    await srv.close()
  }

  section('7. timeout + oversize')
  {
    const srv = await startFakeBlenderBridge({ mode: 'silent-after-hello' })
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const rt = await client.request('render_state', undefined, 100)
    check('unanswered request ⇒ REQUEST_TIMEOUT naming the op', !rt.ok && rt.error.code === 'REQUEST_TIMEOUT' && /render_state/.test(rt.error.message))
    client.close()
    await srv.close()

    const srv2 = await startFakeBlenderBridge({ mode: 'oversize-on-request' })
    const c2 = new BlenderBridgeClient({ port: srv2.port, token: 'tok', ...FAST })
    const ro = await c2.request('render_state', undefined, 2_000)
    check('oversized frame kills the connection (no forever-buffer)', !ro.ok && ro.error.code === 'CONNECTION_LOST', !ro.ok ? ro.error.code : 'ok?!')
    c2.close()
    await srv2.close()
  }

  section('8. hostile servers — squatted port, garbage handshake, queued-request deadlines')
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
    const client = new BlenderBridgeClient({ port: squatted.port, token: 'tok', ...FAST })
    const r = await client.request('scene_info', undefined, 1_500)
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
    const c2 = new BlenderBridgeClient({ port: garbler.port, token: 'tok', ...FAST })
    const r2 = await c2.request('scene_info', undefined, 1_500)
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
    const c3 = new BlenderBridgeClient({ port: silent.port, token: 'tok', ...FAST, helloTimeoutMs: 30_000 })
    const t2 = Date.now()
    const r3 = await c3.request('render_state', undefined, 400)
    check('queued request times out on ITS OWN deadline (handshake still pending)',
      !r3.ok && r3.error.code === 'REQUEST_TIMEOUT' && /render_state/.test(r3.error.message) && Date.now() - t2 < 1_500,
      `elapsed=${Date.now() - t2}ms`)
    c3.close()
    silent.close()
  }

  section('9. THE NO-RELOAD LAW — blend_open answers and the connection HOLDS')
  {
    const srv = await startFakeBlenderBridge()
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await client.request('scene_info')
    const connectionsBefore = srv.connectionCount()
    const opened = await client.request('blend_open', { path: '/work/studio/assets/props.blend' })
    check('blend_open answers opened', opened.ok === true && (opened as { result: { opened: string } }).result.opened === '/work/studio/assets/props.blend')
    check('the connection HELD (status ready, no drop)', client.status() === 'ready')
    const after = await client.request('scene_info')
    check('the follow-up op rides the SAME connection and sees the new file',
      after.ok === true &&
        (after as { result: { blendFile: string } }).result.blendFile === '/work/studio/assets/props.blend' &&
        srv.connectionCount() === connectionsBefore,
      `connections=${srv.connectionCount()}`)
    client.close()
    await srv.close()
  }

  section('10. accept-newest AT HELLO TIME — a probe cannot kick the client; a second hello can')
  {
    const srv = await startFakeBlenderBridge()
    const a = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    await a.request('scene_info')
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
    const stillAlive = await a.request('scene_info')
    check('A still answers after the probe', stillAlive.ok === true)
    const b = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const rb = await b.request('scene_info')
    check('B connects and answers', rb.ok === true && b.status() === 'ready')
    await sleep(30)
    check('A was dropped by the accept-newest law', a.status() === 'disconnected')
    const rb2 = await b.request('render_state')
    check('B lives on', rb2.ok === true)
    a.close()
    b.close()
    await srv.close()
  }

  section('11. the render road — ack, the DURABLE file, event agreement, RENDER_ACTIVE mutate/exec-only')
  {
    const scratch = mkdtempSync(path.join(tmpdir(), 'blender-bridge-render-'))
    const outputPath = path.join(scratch, 'renders', 'frame-0001.png')
    const srv = await startFakeBlenderBridge({ renderDurationMs: 80 })
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const rs = await client.request('render_still', { outputPath, frame: 1 })
    check('render_still acks started:true with the outputPath echoed',
      rs.ok === true && (rs as { result: { started: boolean; outputPath: string } }).result.started === true &&
        (rs as { result: { outputPath: string } }).result.outputPath === outputPath)
    // DURING the job: mutate/exec refuse, reads stay free.
    const second = await client.request('render_still', { outputPath })
    check('a second render_still refuses RENDER_ACTIVE', !second.ok && second.error.code === 'RENDER_ACTIVE')
    const openDuring = await client.request('blend_open', { path: '/work/studio/assets/props.blend' })
    check('blend_open during a render refuses RENDER_ACTIVE (mutate law)', !openDuring.ok && openDuring.error.code === 'RENDER_ACTIVE')
    const pyDuring = await client.request('python_run', { source: 'x = 1' })
    check('python_run during a render refuses RENDER_ACTIVE (the exec ruling)', !pyDuring.ok && pyDuring.error.code === 'RENDER_ACTIVE')
    const stateDuring = await client.request('render_state')
    check('render_state READS FREE during the job and shows jobs.render true',
      stateDuring.ok === true && (stateDuring as { result: { jobs: { render: boolean } } }).result.jobs.render === true)
    await sleep(160)
    check('the DURABLE file landed at outputPath', existsSync(outputPath))
    check('the file carries the render bytes', readFileSync(outputPath, 'utf8').startsWith('FAKE-PNG-BYTES:1'))
    const finished = client.drainEvents().find(e => e.event === 'render_finished')
    const data = finished?.data as { outputPath: string; ok: boolean; cancelled: boolean } | undefined
    check('render_finished event agrees with the file (path + ok, not cancelled)',
      data?.outputPath === outputPath && data?.ok === true && data?.cancelled === false)
    const again = await client.request('render_still', { outputPath: path.join(scratch, 'renders', 'frame-0002.png') })
    check('after completion a new render starts again', again.ok === true)
    client.close()
    await srv.close()

    // The cancel lever: ok:false/cancelled:true and NOTHING written.
    const cancelSrv = await startFakeBlenderBridge({ renderDurationMs: 30, renderCancels: true })
    const c2 = new BlenderBridgeClient({ port: cancelSrv.port, token: 'tok', ...FAST })
    const cancelPath = path.join(scratch, 'renders', 'cancelled.png')
    await c2.request('render_still', { outputPath: cancelPath })
    await sleep(100)
    const cancelled = c2.drainEvents().find(e => e.event === 'render_finished')
    const cdata = cancelled?.data as { ok: boolean; cancelled: boolean } | undefined
    check('a cancelled render reports ok:false/cancelled:true', cdata?.ok === false && cdata?.cancelled === true)
    check('a cancelled render writes NOTHING (write_still writes only at completion)', !existsSync(cancelPath))
    c2.close()
    await cancelSrv.close()
  }

  section('12. error arms + python_run shapes — every refusal typed and teaching')
  {
    const srv = await startFakeBlenderBridge()
    const client = new BlenderBridgeClient({ port: srv.port, token: 'tok', ...FAST })
    const unknown = await client.request('tests_run')
    check('UNKNOWN_OP with the verb list in the hint',
      !unknown.ok && unknown.error.code === 'UNKNOWN_OP' && /python_run/.test(unknown.error.hint ?? ''))
    const overCap = await client.request('python_run', { source: 'x'.repeat(BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES + 1) })
    check('BAD_ARGS: python_run source over the 64KiB cap', !overCap.ok && overCap.error.code === 'BAD_ARGS' && /cap/.test(overCap.error.message))
    const missing = await client.request('blend_open', { path: '/work/studio/nope.blend' })
    check('BLEND_NOT_FOUND', !missing.ok && missing.error.code === 'BLEND_NOT_FOUND')
    srv.setDirty(true)
    const dirty = await client.request('blend_open', { path: '/work/studio/assets/props.blend' })
    check('BLEND_DIRTY names the save road, never a silent discard',
      !dirty.ok && dirty.error.code === 'BLEND_DIRTY' && /save/i.test(dirty.error.hint ?? ''))
    srv.setDirty(false)
    const boom = await client.request('python_run', { source: 'raise ValueError("BOOM")' })
    check('PYTHON_EXCEPTION carries type+message, traceback tail in the hint',
      !boom.ok && boom.error.code === 'PYTHON_EXCEPTION' && /ValueError: boom/.test(boom.error.message) && /traceback/i.test(boom.error.hint ?? ''))
    const valued = await client.request('python_run', { source: 'result = 40 + 2' })
    check("a source setting `result` answers its repr as value",
      valued.ok === true && (valued as { result: { value: string | null } }).result.value === "'fixture-value'")
    const printed = await client.request('python_run', { source: 'print("hi")' })
    check('stdout rides back, truncation zero when complete',
      printed.ok === true &&
        (printed as { result: { stdout: string; truncated: { stdout: number } } }).result.stdout.length > 0 &&
        (printed as { result: { truncated: { stdout: number } } }).result.truncated.stdout === 0)
    const tail = await client.request('report_tail', { severity: 'warning' })
    check('report_tail severity floor + honest dropped count',
      tail.ok === true &&
        (tail as { result: { entries: Array<{ severity: string }>; dropped: number } }).result.entries.every(e => e.severity === 'warning' || e.severity === 'error') &&
        (tail as { result: { dropped: number } }).result.dropped === 2)
    client.close()
    await srv.close()
  }

  console.log('\n' + (failures === 0 ? '✅ blender-bridge protocol proof PASS' : `❌ ${failures} FAILURES`))
  process.exit(failures === 0 ? 0 : 1)
}

void main()
