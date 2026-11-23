#!/usr/bin/env bun

import * as net from 'node:net'
import { VulcanClient } from '../../src/integrations/vulcan/vulcanClient.js'
import { vulcanDeclaredBudgetMs } from '../../src/tools/godot/GodotTool.js'
import { VULCAN_STEP_WALL_MS_PER_FRAME } from '../../src/integrations/vulcan-optable/optable.generated.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = cond || !hint ? detail : detail ? `${detail} — ${hint}` : hint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const fakeInstance = (port: number) => ({ version: 1 as const, id: 'f'.repeat(32), role: 'agent-editor' as const, port, pid: process.pid, projectRoot: process.cwd(), ownerPid: process.pid })

type Mode = 'echo' | 'silent-after-hello' | 'drop-on-request' | 'no-pong' | 'oversize-on-request'

interface FakeServer {
  port: number
  instance: ReturnType<typeof fakeInstance>
  seenOps: string[]
  close: () => Promise<void>
  setMode: (m: Mode) => void
}

function startFakeServer(token: string, mode: Mode = 'echo'): Promise<FakeServer> {
  const state = { mode, seenOps: [] as string[] }
  const sockets = new Set<net.Socket>()
  const server = net.createServer(socket => {
    const instance = fakeInstance(socket.localPort!)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buf = ''
    let authed = false
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        const frame = JSON.parse(line) as Record<string, unknown>
        if (!authed) {
          if (frame.op === 'hello' && frame.token === token) {
            authed = true
            socket.write(JSON.stringify({ ok: true, result: { version: 1, godot: '4.3-fake', project: 'fixture' }, instance }) + '\n')
          } else {
            socket.write(JSON.stringify({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token', hint: 'vulcan_install rewrites the token file' } }) + '\n')
            socket.end()
          }
          continue
        }
        const op = String(frame.op)
        state.seenOps.push(op)
        if (op === 'ping') {
          if (state.mode !== 'no-pong') {
            socket.write(JSON.stringify({ id: frame.id, ok: true, result: 'pong', instance }) + '\n')
          }
          continue
        }
        if (state.mode === 'drop-on-request') {
          socket.destroy()
          continue
        }
        if (state.mode === 'silent-after-hello') continue
        if (state.mode === 'oversize-on-request') {
          socket.write('{"pad":"' + 'x'.repeat(9 * 1024 * 1024) + '"}\n')
          continue
        }
        if (op === 'batch10') {
          continue
        }
        socket.write(JSON.stringify({ id: frame.id, ok: true, result: { echo: op, args: frame.args ?? null }, instance }) + '\n')
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        instance: fakeInstance((server.address() as net.AddressInfo).port),
        seenOps: state.seenOps,
        setMode: m => {
          state.mode = m
        },
        close: () =>
          new Promise<void>(r => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}

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
    const srv = await startFakeServer('tok-good')
    const client = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok-good', ...FAST })
    const r = await client.request('project_info')
    check('good token round-trip', r.ok === true && (r as { result: { echo: string } }).result.echo === 'project_info', '', 'the hello handshake and request path of VulcanClient in src/integrations/vulcan/vulcanClient.ts must complete with the right token')
    check('status ready', client.status() === 'ready', '', 'VulcanClient.status in src/integrations/vulcan/vulcanClient.ts must read ready after a good handshake')
    check('the response identifies the selected instance and role', r.instance?.id === srv.instance.id && r.instance.role === 'agent-editor')
    client.close()
    const beforeMismatch = srv.seenOps.length
    const mismatch = new VulcanClient({ port: srv.port, token: 'tok-good', instance: { ...srv.instance, id: 'e'.repeat(32) }, ...FAST })
    const refused = await mismatch.request('must_not_run')
    check('a mismatched hello identity refuses before sending an operation', !refused.ok && refused.error.code === 'INSTANCE_MISMATCH' && srv.seenOps.length === beforeMismatch, '', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must compare the hello instance with the selected one and return INSTANCE_MISMATCH before it sends any op')
    mismatch.close()

    const bad = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok-WRONG', ...FAST })
    const rb = await bad.request('project_info')
    check('bad token ⇒ AUTH_FAILED', !rb.ok && rb.error.code === 'AUTH_FAILED', JSON.stringify(!rb.ok ? rb.error : {}), 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must return the server AUTH_FAILED error for a refused hello')
    check('bad token carries the hint', !rb.ok && typeof rb.error.hint === 'string' && rb.error.hint!.length > 0)
    bad.close()
    await srv.close()
  }

  section('2. correlation — 10 interleaved, answered out of order')
  {
    const srv = await startFakeServer('tok')
    const client = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok', ...FAST })
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.request(`op_${i}`, { i })),
    )
    const allMatch = results.every((r, i) => r.ok && (r as { result: { echo: string; args: { i: number } } }).result.echo === `op_${i}` && (r as { result: { args: { i: number } } }).result.args.i === i)
    check('each of 10 answers lands on its own promise', allMatch, '', 'VulcanClient.request in src/integrations/vulcan/vulcanClient.ts must match each response to its request by id')
    client.close()
    await srv.close()
  }

  section('3. heartbeat — pings flow; missed pong destroys')
  {
    const srv = await startFakeServer('tok')
    const client = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok', ...FAST })
    await client.request('warm')
    await sleep(300)
    check('pings observed on the wire', srv.seenOps.filter(o => o === 'ping').length >= 1, `${srv.seenOps.filter(o => o === 'ping').length} pings`, 'the heartbeat of VulcanClient in src/integrations/vulcan/vulcanClient.ts (heartbeatMs) must send ping frames')
    check('still ready while pongs answered', client.status() === 'ready')
    srv.setMode('no-pong')
    await sleep(400)
    check('missed pong ⇒ connection destroyed', client.status() === 'disconnected', '', 'the heartbeat of VulcanClient in src/integrations/vulcan/vulcanClient.ts must destroy the connection when no pong arrives within pongTimeoutMs')
    client.close()
    await srv.close()
  }

  section('4. backoff — fast-fail window, doubling, reset on success')
  {
    const deadPort = await new Promise<number>(resolve => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const client = new VulcanClient({ port: deadPort, token: 'tok', ...FAST })
    check('initial next-delay = start', client.nextDelayMs() === FAST.backoffStartMs)
    const r1 = await client.request('x')
    check('connect failure surfaces (handshake class)', !r1.ok && (r1.error.code === 'HANDSHAKE_CLOSED' || r1.error.code === 'CONNECTION_LOST'), !r1.ok ? r1.error.code : '', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must return HANDSHAKE_CLOSED or CONNECTION_LOST when the connect fails')
    check('one failure doubles ONCE (error+close guard)', client.nextDelayMs() === FAST.backoffStartMs * 2, `${client.nextDelayMs()}`, 'the backoff of VulcanClient in src/integrations/vulcan/vulcanClient.ts must double once per failure, not once for error and again for close')
    const r2 = await client.request('y')
    check('inside the window ⇒ EDITOR_UNREACHABLE fast-fail', !r2.ok && r2.error.code === 'EDITOR_UNREACHABLE', '', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must fail fast with EDITOR_UNREACHABLE while the backoff window is open')
    check('fast-fail hint teaches the editor + install', !r2.ok && /vulcan_install/.test(r2.error.hint ?? ''), '', 'the EDITOR_UNREACHABLE error in src/integrations/vulcan/vulcanClient.ts must carry a hint that names vulcan_install')
    await sleep(FAST.backoffStartMs + 30)
    const r3 = await client.request('z')
    check('after the window a reconnect is attempted', !r3.ok && r3.error.code !== 'EDITOR_UNREACHABLE', !r3.ok ? r3.error.code : '', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must try to reconnect once the backoff window has passed')
    check('second failure doubles again', client.nextDelayMs() === FAST.backoffStartMs * 4, `${client.nextDelayMs()}`, 'the backoff of VulcanClient in src/integrations/vulcan/vulcanClient.ts must double again on the second failure')
    const srv = await startFakeServer('tok')
    const c2 = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok', ...FAST })
    await c2.request('warm')
    srv.setMode('drop-on-request')
    const rd = await c2.request('will-drop')
    check('mid-flight drop ⇒ CONNECTION_LOST', !rd.ok && rd.error.code === 'CONNECTION_LOST', '', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must answer an in-flight request with CONNECTION_LOST when the socket drops')
    check('drop armed backoff', c2.nextDelayMs() === FAST.backoffStartMs * 2)
    srv.setMode('echo')
    await sleep(FAST.backoffStartMs + 30)
    const rr = await c2.request('recover')
    check('reconnects and answers after the window', rr.ok === true)
    check('success RESETS backoff', c2.nextDelayMs() === FAST.backoffStartMs, `${c2.nextDelayMs()}`, 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must reset the backoff to backoffStartMs after a successful handshake')
    client.close()
    c2.close()
    await srv.close()
  }

  section('5. events — unsolicited frames buffer + drain')
  {
    const evtServer = net.createServer(socket => {
      const instance = fakeInstance(socket.localPort!)
      let authed = false
      let buf = ''
      socket.on('data', chunk => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (!line.trim()) continue
          const frame = JSON.parse(line) as Record<string, unknown>
          if (!authed) {
            authed = true
            socket.write(JSON.stringify({ ok: true, result: {}, instance }) + '\n')
            continue
          }
          if (frame.op === 'ping') {
            socket.write(JSON.stringify({ id: frame.id, ok: true, result: 'pong', instance }) + '\n')
            continue
          }
          socket.write(JSON.stringify({ event: 'play_started', data: { scene: 'res://main.tscn' } }) + '\n')
          socket.write(JSON.stringify({ event: 'runtime_log', data: { line: 'hello' } }) + '\n')
          socket.write(JSON.stringify({ id: frame.id, ok: true, result: 'played', instance }) + '\n')
        }
      })
    })
    const evtPort = await new Promise<number>(resolve => {
      evtServer.listen(0, '127.0.0.1', () => resolve((evtServer.address() as net.AddressInfo).port))
    })
    const ec = new VulcanClient({ port: evtPort, instance: fakeInstance(evtPort), token: 'tok', ...FAST })
    const pr = await ec.request('scene_play')
    check('request alongside events answers', pr.ok === true && (pr as { result: unknown }).result === 'played')
    const events = ec.drainEvents()
    check('both events buffered in order', events.length === 2 && events[0]?.event === 'play_started' && events[1]?.event === 'runtime_log', '', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must buffer unsolicited event frames in arrival order for drainEvents')
    check('drain clears', ec.drainEvents().length === 0)
    ec.close()
    await new Promise<void>(r => evtServer.close(() => r()))
  }

  section('6. timeout + oversize')
  {
    const srv = await startFakeServer('tok', 'silent-after-hello')
    const client = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok', ...FAST })
    const rt = await client.request('never_answered', undefined, 100)
    check('unanswered request ⇒ REQUEST_TIMEOUT naming the op', !rt.ok && rt.error.code === 'REQUEST_TIMEOUT' && /never_answered/.test(rt.error.message), '', 'the request timeout in VulcanClient in src/integrations/vulcan/vulcanClient.ts must return REQUEST_TIMEOUT with the op name in the message')
    client.close()
    await srv.close()

    const srv2 = await startFakeServer('tok', 'oversize-on-request')
    const c2 = new VulcanClient({ port: srv2.port, instance: srv2.instance, token: 'tok', ...FAST })
    const ro = await c2.request('big', undefined, 2_000)
    check('oversized frame kills the connection (no forever-buffer)', !ro.ok && ro.error.code === 'CONNECTION_LOST', !ro.ok ? ro.error.code : 'ok?!', 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must destroy the connection and return CONNECTION_LOST when a frame exceeds its size limit')
    c2.close()
    await srv2.close()
  }

  section('6. seamark PB-1 — squatted port + queued-request deadlines (never hangs)')
  {
    const squatted = await new Promise<{ port: number; close: () => void }>(resolve => {
      const sockets = new Set<net.Socket>()
      const server = net.createServer(socket => {
        sockets.add(socket)
        socket.write('GARBAGE-NOT-A-FRAME')
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
    const client = new VulcanClient({ port: squatted.port, token: 'tok', ...FAST })
    const r = await client.request('hangs_forever', undefined, 1_500)
    const elapsed = Date.now() - t0
    check('PB-1: squatted-port request SETTLES bounded (typed error, no forever-connecting)', !r.ok && elapsed < 3_000, `elapsed=${elapsed}ms ${JSON.stringify(r).slice(0, 90)}`, 'a request to a port that never completes the hello must settle with a typed error inside its timeout; see the connect and hello timers of VulcanClient in src/integrations/vulcan/vulcanClient.ts')
    check("PB-1: state is not wedged in 'connecting'", client.status() !== 'connecting', client.status(), 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must leave the connecting state when the hello fails or times out')
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
    const c2 = new VulcanClient({ port: garbler.port, token: 'tok', ...FAST })
    const r2 = await c2.request('x', undefined, 1_500)
    check('PB-1: unparseable handshake payload dies FAST (typed, well under the request timeout)', !r2.ok && Date.now() - t1 < 1_200, `elapsed=${Date.now() - t1}ms`, 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must close the connection as soon as the hello payload is not parseable JSON')
    c2.close()
    garbler.close()

    const silent = await new Promise<{ port: number; close: () => void }>(resolve => {
      const sockets = new Set<net.Socket>()
      const server = net.createServer(socket => {
        sockets.add(socket)
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
    const c3 = new VulcanClient({ port: silent.port, token: 'tok', ...FAST, helloTimeoutMs: 30_000 })
    const t2 = Date.now()
    const r3 = await c3.request('queued_op', undefined, 400)
    check('PB-1: queued request times out on ITS OWN deadline (handshake still pending)',
      !r3.ok && r3.error.code === 'REQUEST_TIMEOUT' && /queued_op/.test(r3.error.message) && Date.now() - t2 < 1_500,
      `elapsed=${Date.now() - t2}ms ${JSON.stringify(r3).slice(0, 110)}`, 'a request queued behind a pending handshake in src/integrations/vulcan/vulcanClient.ts must time out on its own deadline with REQUEST_TIMEOUT naming the op')
    c3.close()
    silent.close()
  }

  section('7. the step verbs on the wire + the declared budget')
  {
    const srv = await startFakeServer('tok')
    const client = new VulcanClient({ port: srv.port, instance: srv.instance, token: 'tok', ...FAST })
    const macro = { steps: [{ action: 'left', pressed: true, step_frames: 30 }, { action: 'left', pressed: false }, { action: 'jump', step_frames: 10 }] }
    const [pause, step, ms, seq, resume] = await Promise.all([
      client.request('runtime_pause'),
      client.request('runtime_step', { frames: 30 }),
      client.request('runtime_step', { ms: 500 }),
      client.request('input_sequence', macro),
      client.request('runtime_resume'),
    ])
    const echo = (r: unknown) => r as { ok: boolean; result: { echo: string; args: unknown } }
    check('runtime_pause / runtime_resume ride the frame with no args', echo(pause).ok && echo(pause).result.echo === 'runtime_pause' && echo(resume).result.echo === 'runtime_resume')
    check('runtime_step carries frames intact', echo(step).ok && JSON.stringify(echo(step).result.args) === JSON.stringify({ frames: 30 }))
    check('runtime_step carries ms intact', echo(ms).ok && JSON.stringify(echo(ms).result.args) === JSON.stringify({ ms: 500 }))
    check('a step_frames macro arrives as ONE input_sequence with every step intact', echo(seq).ok && JSON.stringify(echo(seq).result.args) === JSON.stringify(macro), '', 'VulcanClient.request in src/integrations/vulcan/vulcanClient.ts must send an input_sequence macro as one frame with every step unchanged')
    check('the op order on the wire is the send order', JSON.stringify(srv.seenOps.filter(o => o !== 'ping')) === JSON.stringify(['runtime_pause', 'runtime_step', 'runtime_step', 'input_sequence', 'runtime_resume']), srv.seenOps.join(','), 'VulcanClient in src/integrations/vulcan/vulcanClient.ts must write requests in the order they are issued')
    client.close()
    await srv.close()

    check('budget: a frame step is the optable\'s one figure per frame (3600 frames × 50 ms = 180 s)', VULCAN_STEP_WALL_MS_PER_FRAME === 50 && vulcanDeclaredBudgetMs('runtime_step', { frames: 3600 }) === 3600 * VULCAN_STEP_WALL_MS_PER_FRAME && vulcanDeclaredBudgetMs('runtime_step', { frames: 3600 }) === 180_000, '', 'vulcanDeclaredBudgetMs in src/tools/godot/GodotTool.ts must count VULCAN_STEP_WALL_MS_PER_FRAME (src/integrations/vulcan-optable/optable.generated.ts) per frame of runtime_step')
    check('budget: an ms step is its ms', vulcanDeclaredBudgetMs('runtime_step', { ms: 500 }) === 500)
    check('budget: a bare step (default window) declares nothing extra', vulcanDeclaredBudgetMs('runtime_step', undefined) === 0 && vulcanDeclaredBudgetMs('runtime_pause', {}) === 0, '', 'vulcanDeclaredBudgetMs in src/tools/godot/GodotTool.ts must return 0 for a runtime_step without args and for runtime_pause')
    check('budget: a macro sums its frames, waits and ms across the steps', vulcanDeclaredBudgetMs('input_sequence', { steps: [...macro.steps, { wait_ms: 250 }, { step_ms: 100 }] }) === (30 + 10) * VULCAN_STEP_WALL_MS_PER_FRAME + 250 + 100, '', 'vulcanDeclaredBudgetMs in src/tools/godot/GodotTool.ts must sum step_frames, wait_ms and step_ms over the steps of an input_sequence')
    check('budget: the older windows still count (playtest_run duration + settle)', vulcanDeclaredBudgetMs('playtest_run', { duration_ms: 5000, settle_ms: 1500 }) === 6500, '', 'vulcanDeclaredBudgetMs in src/tools/godot/GodotTool.ts must add duration_ms and settle_ms for playtest_run')
    check('budget: non-numbers and negatives count as nothing', vulcanDeclaredBudgetMs('runtime_step', { frames: '30' as unknown as number, ms: -5 }) === 0)
  }

  console.log('\n' + (failures === 0 ? '✅ vulcan protocol proof PASS' : `❌ ${failures} FAILURES`))
  process.exit(failures === 0 ? 0 : 1)
}

void main()
