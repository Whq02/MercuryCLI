#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wire-laws-'))

const peerModule = await import('../../src/runner/wire/peer.ts')
const errors = await import('../../src/runner/wire/errors.ts')
const methods = await import('../../src/runner/wire/methods.ts')
const { Peer, LineSplitter } = peerModule

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — runner wire laws exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

type Frame = Record<string, unknown>
type World = ReturnType<typeof world>

function tap(stream: PassThrough, into: Frame[]): void {
  const splitter = new LineSplitter()
  stream.on('data', chunk => {
    for (const line of splitter.feed(chunk as Buffer)) {
      if (line.kind !== 'line' || line.text.trim() === '') continue
      try {
        into.push(JSON.parse(line.text) as Frame)
      } catch {
        into.push({ unparsed: line.text })
      }
    }
  })
}

function world() {
  const toRunner = new PassThrough()
  const toHost = new PassThrough()
  const hostSaw: Frame[] = []
  const runnerSaw: Frame[] = []
  tap(toHost, hostSaw)
  tap(toRunner, runnerSaw)
  const desyncs: number[] = []
  const runnerLog: string[] = []
  const hostLog: string[] = []
  const runner = new Peer({ input: toRunner, output: toHost, side: 'runner', onDesync: n => desyncs.push(n), log: l => runnerLog.push(l) })
  const host = new Peer({ input: toHost, output: toRunner, side: 'host', log: l => hostLog.push(l) })
  runner.onRequest('initialize', () => ({ protocol: methods.RUNNER_PROTOCOL, runner: { version: 'proof', pid: process.pid }, session_id: null }))
  runner.onRequest('session/facts', () => ({ model: 'm', mode: 'default' }))
  const raw = (line: string): void => {
    toRunner.write(line)
  }
  const rawToHost = (line: string): void => {
    toHost.write(line)
  }
  const initialize = () => host.request('initialize', { protocol: methods.RUNNER_PROTOCOL, host: { name: 'proof', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: true } })
  return { toRunner, toHost, hostSaw, runnerSaw, desyncs, runnerLog, hostLog, runner, host, raw, rawToHost, initialize }
}

const errorsSeen = (frames: Frame[]): Array<{ id: unknown; code: number; data?: unknown }> =>
  frames.filter(f => f.error !== undefined).map(f => ({ id: f.id, code: (f.error as { code: number }).code, data: (f.error as { data?: unknown }).data }))

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return undefined
  } catch (error) {
    return error
  }
}

const row = (seq: number, text: string): Frame => ({ type: 'notice', seq, timestamp: 't', session_id: 's', level: 'warning', text })

section('W1 framing: partial lines buffer across chunks, CRLF trims, the bound drops and resyncs')
{
  const splitter = new LineSplitter()
  const first = splitter.feed('{"a":1}\n{"b"')
  const second = splitter.feed(':2}\r\n\n')
  const tail = splitter.feed('{"c":3}')
  const flushed = splitter.flush()
  check('one line from the first chunk', first.length === 1 && first[0]!.kind === 'line' && first[0]!.text === '{"a":1}')
  check('the split line completes on the second chunk and CRLF trims', second.length === 2 && second[0]!.kind === 'line' && second[0]!.text === '{"b":2}')
  check('a blank line reaches the reader as an empty line', second[1]!.kind === 'line' && second[1]!.text === '')
  check('an unterminated tail waits', tail.length === 0)
  check('flush yields the tail', flushed.length === 1 && flushed[0]!.kind === 'line' && flushed[0]!.text === '{"c":3}')
  const bounded = new LineSplitter(16)
  const over = bounded.feed('x'.repeat(20))
  const resync = bounded.feed('yy\n{"d":4}\n')
  check('an overlong line is dropped once its newline arrives and the reader resyncs on the next line', over.length === 0 && resync.length === 2 && resync[0]!.kind === 'overlong' && resync[1]!.kind === 'line' && resync[1]!.text === '{"d":4}', j(resync))
  const w = world()
  await w.initialize()
  w.raw('{"jsonrpc":"2.0","id":7,"method":"sess')
  await settle(10)
  const before = w.hostSaw.length
  w.raw('ion/facts","params":{}}\n')
  await settle(20)
  const answer = w.hostSaw.find(f => f.id === 7)
  check('the peer serves a request whose bytes arrived in two chunks', w.hostSaw.length === before + 1 && answer !== undefined && j(answer.result) === j({ model: 'm', mode: 'default' }), j(w.hostSaw))
  w.host.end()
}

section('W2 the handshake: the runner holds its output until initialize is answered')
{
  const w = world()
  w.runner.notify('row', row(1, 'boot') as never)
  w.runner.notify('row', row(2, 'boot too') as never)
  await settle(20)
  check('rows before initialize are held, not written', w.hostSaw.length === 0 && w.runner.holdingOutput)
  w.raw(j({ jsonrpc: '2.0', id: 5, method: 'session/facts', params: {} }) + '\n')
  await settle(20)
  const early = errorsSeen(w.hostSaw)
  check('a request before initialize is answered -32002 through the hold', early.length === 1 && early[0]!.id === 5 && early[0]!.code === errors.RPC_NOT_INITIALIZED, j(w.hostSaw))
  check('the held rows still have not left', w.hostSaw.length === 1)
  const result = await w.initialize()
  await settle(20)
  check('initialize answers protocol 1, the runner pid and a null session id', result.protocol === 1 && result.runner.pid === process.pid && result.session_id === null)
  const kinds = w.hostSaw.map(f => (f.result !== undefined ? 'result' : f.error !== undefined ? 'error' : f.method === 'row' ? `row:${(f.params as Frame).text}` : f.method))
  check('the held rows leave right after the answer, in order', j(kinds) === j(['error', 'result', 'row:boot', 'row:boot too']), j(kinds))
  check('the writer no longer holds', !w.runner.holdingOutput && w.runner.initialized)
  const again = (await rejection(w.initialize())) as InstanceType<typeof errors.RpcError>
  check('a second initialize is refused -32010 already-initialized', again?.code === errors.RPC_REFUSED && (again.data as { kind: string }).kind === 'already-initialized', j(again))
  w.host.end()
}

section('W3 a request that arrives while initialize is pending waits for the answer; a refused initialize leaves the runner uninitialized')
{
  const w = world()
  w.runner.onRequest('initialize', async () => {
    await settle(40)
    return { protocol: 1, runner: { version: 'proof', pid: 1 }, session_id: 'abc' }
  })
  w.raw(j({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocol: 1, host: { name: 'h', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } } }) + '\n')
  w.raw(j({ jsonrpc: '2.0', id: 2, method: 'session/facts', params: {} }) + '\n')
  await settle(100)
  check('both are answered, initialize first, and the facts request is served rather than refused', j(w.hostSaw.map(f => f.id)) === j([1, 2]) && w.hostSaw[1]!.result !== undefined, j(w.hostSaw))
  w.host.end()
  const refusing = world()
  refusing.runner.onRequest('initialize', params => {
    throw errors.refused(`protocol ${params.protocol} is not served`, 'protocol')
  })
  const refusal = (await rejection(refusing.initialize())) as InstanceType<typeof errors.RpcError>
  check('a protocol mismatch is -32010 kind protocol', refusal?.code === errors.RPC_REFUSED && (refusal.data as { kind: string }).kind === 'protocol' && refusal.message.includes('protocol 1'))
  check('the runner stays uninitialized', !refusing.runner.initialized)
  const after = (await rejection(refusing.host.request('session/facts', {}))) as InstanceType<typeof errors.RpcError>
  check('and the next request is still -32002', after?.code === errors.RPC_NOT_INITIALIZED)
  refusing.host.end()
}

section('W4 parse errors: -32700 with a null id, the stream continues, three in a row desync')
{
  const w = world()
  await w.initialize()
  const mark = w.hostSaw.length
  w.raw('this is not json\n')
  await settle(10)
  const facts = await w.host.request('session/facts', {})
  check('the bad line is answered -32700 id null', j(errorsSeen(w.hostSaw.slice(mark))[0]) === j({ id: null, code: errors.RPC_PARSE_ERROR }), j(w.hostSaw.slice(mark)))
  check('and the next request is served', j(facts) === j({ model: 'm', mode: 'default' }))
  check('one bad line does not desync', w.desyncs.length === 0)
  w.raw('bad one\n')
  w.raw('bad two\n')
  await w.host.request('session/facts', {})
  w.raw('bad three\n')
  await settle(10)
  check('a good line between bad lines resets the count', w.desyncs.length === 0, j(w.desyncs))
  w.raw('bad four\n')
  w.raw('bad five\n')
  await settle(10)
  check(`three consecutive bad lines report a desync (${j(w.desyncs)})`, j(w.desyncs) === j([3]))
  check('the runner names the desync on its log', w.runnerLog.some(l => l.includes('out of step')))
  w.host.end()
}

section('W5 invalid requests: a batch, a non-JSON-RPC object, a bad id')
{
  const w = world()
  await w.initialize()
  const mark = w.hostSaw.length
  w.raw(j([{ jsonrpc: '2.0', id: 9, method: 'session/facts', params: {} }]) + '\n')
  w.raw(j({ type: 'control_request', request_id: 'r', request: { subtype: 'interrupt' } }) + '\n')
  w.raw(j({ jsonrpc: '2.0', id: 'nine', method: 'session/facts', params: {} }) + '\n')
  w.raw(j({ jsonrpc: '2.0', id: 3 }) + '\n')
  await settle(20)
  const seen = errorsSeen(w.hostSaw.slice(mark))
  check('each is -32600', seen.length === 4 && seen.every(e => e.code === errors.RPC_INVALID_REQUEST), j(seen))
  check('a batch and a bad id answer with id null; a bare id frame answers with its id', seen[0]!.id === null && seen[1]!.id === null && seen[2]!.id === null && seen[3]!.id === 3, j(seen))
  check('none of them count as a bad line', w.desyncs.length === 0)
  w.host.end()
}

section('W6 method not found and invalid params')
{
  const w = world()
  await w.initialize()
  const unknown = (await rejection(w.host.request('nope' as never, {} as never))) as InstanceType<typeof errors.RpcError>
  check('an unknown method is -32601 naming the method', unknown?.code === errors.RPC_METHOD_NOT_FOUND && (unknown.data as { method: string }).method === 'nope')
  const wrongWay = (await rejection(w.host.request('permission/request' as never, { kind: 'network', host: 'x' } as never))) as InstanceType<typeof errors.RpcError>
  check('a runner-to-host method sent to the runner is -32601', wrongWay?.code === errors.RPC_METHOD_NOT_FOUND)
  const unserved = (await rejection(w.host.request('session/rewind', { user_message_id: 'u', mode: 'code' }))) as InstanceType<typeof errors.RpcError>
  check('a table method this runner has no handler for is -32601', unserved?.code === errors.RPC_METHOD_NOT_FOUND)
  w.runner.onRequest('session/set_effort', params => ({ effort: params.effort, at: 'now' }))
  w.runner.onRequest('queue/add', () => ({ accepted: true }))
  const notFoundBefore = w.hostSaw.filter(f => (f.error as { code?: number } | undefined)?.code === errors.RPC_METHOD_NOT_FOUND).length
  const noEffort = (await rejection(w.host.request('session/set_effort', {} as never))) as InstanceType<typeof errors.RpcError>
  const issues = (noEffort?.data as { issues?: Array<{ path: string }> } | undefined)?.issues ?? []
  check('a schema refusal is -32602 with the issues', noEffort?.code === errors.RPC_INVALID_PARAMS && issues.some(i => i.path === 'effort'), j(noEffort))
  const userFrame = (await rejection(w.host.request('queue/add', { type: 'user', message: {} } as never))) as InstanceType<typeof errors.RpcError>
  check('queue/add refuses a frame that is not an input row', userFrame?.code === errors.RPC_INVALID_PARAMS)
  w.raw(j({ jsonrpc: '2.0', method: 'no/such_notification', params: {} }) + '\n')
  await settle(10)
  check('an unknown notification is ignored, never answered', w.hostSaw.filter(f => (f.error as { code?: number } | undefined)?.code === errors.RPC_METHOD_NOT_FOUND).length === notFoundBefore)
  w.host.end()
}

section('W7 correlation: answers out of order, duplicates and late responses')
{
  const w = world()
  await w.initialize()
  let calls = 0
  w.runner.onRequest('session/facts', async () => {
    calls += 1
    const mine = calls
    if (mine === 1) await settle(60)
    return { call: mine }
  })
  const order: number[] = []
  const a = w.host.request('session/facts', {}).then(r => (order.push(1), r))
  const b = w.host.request('session/facts', {}).then(r => (order.push(2), r))
  const [ra, rb] = await Promise.all([a, b])
  check('the fast second answer does not wait for the slow first', j(order) === j([2, 1]))
  check('each caller receives its own answer', j(ra) === j({ call: 1 }) && j(rb) === j({ call: 2 }))
  const ids = w.runnerSaw.filter(f => f.method === 'session/facts').map(f => f.id as number)
  w.rawToHost(j({ jsonrpc: '2.0', id: ids[0], result: { call: 'dup' } }) + '\n')
  w.rawToHost(j({ jsonrpc: '2.0', id: 999, result: {} }) + '\n')
  await settle(10)
  check('a duplicate and a late response are ignored and logged', w.hostLog.filter(l => l.includes('not pending')).length === 2 && w.host.pendingCount === 0, j(w.hostLog))
  check('ids are positive integers minted per sender', ids.every(id => Number.isInteger(id) && id > 0) && ids[1]! > ids[0]!)
  w.host.end()
}

section('W8 the host abandons a request: $/cancel_request, -32800 at both ends, the late answer dropped')
{
  const w = world()
  await w.initialize()
  let signal: AbortSignal | null = null
  let finish: ((v: unknown) => void) | null = null
  w.runner.onRequest('session/rewind', (_params, ctx) => {
    signal = ctx.signal
    return new Promise(resolve => {
      finish = resolve as (v: unknown) => void
    })
  })
  const ac = new AbortController()
  const p = w.host.request('session/rewind', { user_message_id: 'u', mode: 'code' }, { signal: ac.signal })
  await settle(10)
  ac.abort()
  const rejected = (await rejection(p)) as InstanceType<typeof errors.RpcError>
  await settle(10)
  const cancelFrame = w.runnerSaw.find(f => f.method === '$/cancel_request')
  const rewindId = w.runnerSaw.find(f => f.method === 'session/rewind')?.id
  check('the host settles its waiter -32800', rejected?.code === errors.RPC_CANCELLED)
  check('a $/cancel_request naming the request leaves the host', cancelFrame !== undefined && (cancelFrame.params as Frame).request_id === rewindId, j(cancelFrame))
  check("the handler's signal aborts", signal !== null && (signal as AbortSignal).aborted)
  const answers = w.hostSaw.filter(f => f.id === rewindId)
  check('the runner answers -32800 once', answers.length === 1 && (answers[0]!.error as { code: number }).code === errors.RPC_CANCELLED, j(answers))
  finish!({ rewound: true })
  await settle(10)
  check("the handler's later result is dropped, never a second answer", w.hostSaw.filter(f => f.id === rewindId).length === 1 && w.runner.inFlightCount === 0)
  check('the host ignores the late -32800 as not pending', w.hostLog.some(l => l.includes('not pending')))
  w.host.end()
}

section('W9 the runner withdraws an ask: the host drops its card and its later answer is ignored')
{
  const w = world()
  await w.initialize()
  let aborted = false
  let park: ((v: unknown) => void) | null = null
  w.host.onRequest('permission/request', (_params, ctx) => {
    ctx.signal.addEventListener('abort', () => {
      aborted = true
    })
    return new Promise(resolve => {
      park = resolve as (v: unknown) => void
    })
  })
  const ac = new AbortController()
  const ask = w.runner.request('permission/request', { kind: 'tool', tool_use_id: 'toolu_1', tool_name: 'Bash', input: { command: 'ls' } }, { signal: ac.signal })
  await settle(10)
  check('the ask reaches the host as a request', w.hostSaw.some(f => f.method === 'permission/request' && (f.params as Frame).tool_use_id === 'toolu_1'))
  ac.abort()
  const rejected = (await rejection(ask)) as InstanceType<typeof errors.RpcError>
  await settle(10)
  check('the runner stops waiting with -32800', rejected?.code === errors.RPC_CANCELLED)
  check("the host's card aborts", aborted)
  const askId = w.hostSaw.find(f => f.method === 'permission/request')?.id
  const answersFor = (): Frame[] => w.runnerSaw.filter(f => f.id === askId && f.method === undefined)
  check('the host answers the withdrawn ask -32800', answersFor().length === 1 && (answersFor()[0]!.error as { code?: number } | undefined)?.code === errors.RPC_CANCELLED)
  park!({ outcome: 'allow' })
  await settle(10)
  check('a later allow from the card is never written', answersFor().length === 1)
  w.host.end()
}

section('W10 the ordered writer: rows, requests and responses leave in production order')
{
  const w = world()
  await w.initialize()
  w.host.onRequest('permission/request', () => ({ outcome: 'deny', message: 'no' }))
  const mark = w.hostSaw.length
  w.runner.notify('row', row(1, 'A') as never)
  const ask = w.runner.request('permission/request', { kind: 'network', host: 'example.test' })
  w.runner.notify('row', row(2, 'B') as never)
  await ask
  const kinds = w.hostSaw.slice(mark).map(f => (f.method === 'row' ? `row:${(f.params as Frame).text}` : f.method))
  check('A, the ask, B', j(kinds) === j(['row:A', 'permission/request', 'row:B']), j(kinds))
  w.host.end()
}

section('W11 scopes: a slow session verb never delays an interrupt or a response; session verbs run in order; a held queue waits')
{
  const w = world()
  await w.initialize()
  const marks: string[] = []
  w.runner.onRequest('session/set_model', async () => {
    marks.push('model:start')
    await settle(120)
    marks.push('model:end')
    return { model: 'm', at: 'now' }
  })
  w.runner.onRequest('session/set_effort', () => {
    marks.push('effort:start')
    return { effort: 'high', at: 'now' }
  })
  w.runner.onRequest('turn/interrupt', () => {
    marks.push('interrupt')
    return { interrupted: true }
  })
  w.runner.onRequest('queue/add', () => {
    marks.push('queue')
    return { accepted: true }
  })
  const t0 = Date.now()
  const model = w.host.request('session/set_model', { model: 'm' })
  const effort = w.host.request('session/set_effort', { effort: 'high' })
  const interrupt = await w.host.request('turn/interrupt', {})
  const interruptMs = Date.now() - t0
  check(`turn/interrupt answered in ${interruptMs} ms while set_model held the session scope`, interrupt.interrupted && interruptMs < 80)
  await Promise.all([model, effort])
  check('set_effort starts only after set_model ends', j(marks.filter(m => m !== 'interrupt' && m !== 'queue')) === j(['model:start', 'model:end', 'effort:start']), j(marks))
  const release = w.runner.holdScope('queue')
  const add = w.host.request('queue/add', { type: 'prompt', content: 'hello', id: 'c-1' })
  await settle(30)
  check('a held queue scope keeps queue/add waiting', !marks.includes('queue'))
  const again = await w.host.request('turn/interrupt', {})
  check('while turn/interrupt still passes', again.interrupted)
  release()
  const added = await add
  check('releasing the hold serves the queued add', added.accepted === true && marks.includes('queue'))
  w.host.end()
}

section('W12 deadlines belong to the sender: the table default, a PeerDeadline and the cancel that follows')
{
  const w = world()
  await w.initialize()
  let shellSignal: AbortSignal | null = null
  w.runner.onRequest('shell/background', (_p, ctx) => {
    shellSignal = ctx.signal
    return new Promise(() => {})
  })
  const t0 = Date.now()
  const late = (await rejection(w.host.request('shell/background', {}, { deadlineMs: 40 }))) as Error & { deadlineMs?: number; method?: string }
  const waited = Date.now() - t0
  check(`the waiter settles as PeerDeadline after ${waited} ms`, late?.name === 'PeerDeadline' && late.deadlineMs === 40 && late.method === 'shell/background' && waited < 500)
  await settle(10)
  const cancel = w.runnerSaw.find(f => f.method === '$/cancel_request')
  check('a $/cancel_request with reason deadline follows', cancel !== undefined && (cancel.params as Frame).reason === 'deadline')
  check("the runner's handler signal aborts", shellSignal !== null && (shellSignal as AbortSignal).aborted)
  check('the table default rides when no deadline is given', methods.deadlineOf('turn/interrupt') === 5_000 && methods.deadlineOf('schedule/roster') === null && methods.deadlineOf('initialize') === null)
  w.host.end()
}

section('W13 close settles every pending request; a closed peer refuses new requests')
{
  const w = world()
  await w.initialize()
  w.runner.onRequest('session/facts', () => new Promise(() => {}))
  const hanging = w.host.request('session/facts', {})
  await settle(10)
  w.host.close('the proof closed it')
  const closed = (await rejection(hanging)) as Error
  check('the pending request rejects PeerClosed with the reason', closed?.name === 'PeerClosed' && closed.message.includes('the proof closed it'))
  const next = (await rejection(w.host.request('session/facts', {}))) as Error
  check('a request after close rejects PeerClosed at once', next?.name === 'PeerClosed' && w.host.closed)
  const w2 = world()
  await w2.initialize()
  w2.host.onRequest('permission/request', () => new Promise(() => {}))
  const ask = w2.runner.request('permission/request', { kind: 'network', host: 'h' })
  await settle(10)
  w2.host.end('session over')
  await w2.runner.done
  const askClosed = (await rejection(ask)) as Error
  check("closing the runner's stdin settles the runner's pending ask as PeerClosed and resolves done", askClosed?.name === 'PeerClosed' && w2.runner.closed)
}

section('W14 BOM and split UTF-8 reach the actual peer intact')
{
  const w = world()
  const bytes = Buffer.from('\ufeff' + j({ jsonrpc: '2.0', id: 81, method: 'initialize', params: { protocol: 1, host: { name: '界', version: '1' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } } }) + '\r\n')
  const split = bytes.indexOf(Buffer.from('界')) + 1
  w.toRunner.write(bytes.subarray(0, split))
  w.toRunner.write(bytes.subarray(split))
  await settle(20)
  check('BOM initialize with CRLF and a split UTF-8 character is accepted', w.hostSaw.some(frame => frame.id === 81 && (frame.result as Frame)?.protocol === 1), j(w.hostSaw))
  w.host.end()
  const scratch = scratchHome('wire-framing-')
  const frames: Frame[] = []
  const splitter = new LineSplitter()
  let reply!: (frame: Frame) => void
  const answered = new Promise<Frame>(resolve => { reply = resolve })
  const distAt = process.argv.indexOf('--dist')
  const host = hostRunner({ dist: distAt < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[distAt + 1]!, node: Bun.which('node')!, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, raw: chunk => {
    for (const line of splitter.feed(chunk)) {
      if (line.kind !== 'line') continue
      const frame = JSON.parse(line.text) as Frame
      frames.push(frame)
      if (frame.id === 81 || frame.error !== undefined) reply(frame)
    }
  } })
  try {
    host.child.stdin!.write(bytes.subarray(0, split))
    host.child.stdin!.write(bytes.subarray(split))
    const response = await answered
    check('the built runner accepts BOM, CRLF and split UTF-8 initialize', response.id === 81 && (response.result as Frame)?.protocol === 1, j(frames))
    if (response.result !== undefined) {
      host.child.stdin!.write('not json\n')
      const facts = await host.request('session/facts', {})
      check('a real malformed line still refuses and the next request succeeds', frames.some(frame => (frame.error as Frame)?.code === errors.RPC_PARSE_ERROR) && typeof facts.model === 'object')
    }
  } finally {
    await host.stop()
    rmSync(scratch.home, { recursive: true, force: true })
    rmSync(scratch.cwd, { recursive: true, force: true })
  }
}

section('W15 cancellation before send and before dispatch cannot apply a request')
{
  const w = world()
  await w.initialize()
  let applied = 0
  w.runner.onRequest('session/set_mode', () => { applied++; return { mode: 'default' } })
  const ac = new AbortController()
  ac.abort()
  const mark = w.runnerSaw.length
  const error = await rejection(w.host.request('session/set_mode', { mode: 'default' }, { signal: ac.signal })) as InstanceType<typeof errors.RpcError>
  await settle(10)
  check('a pre-aborted request rejects cancellation without any wire writes', error?.code === errors.RPC_CANCELLED && w.runnerSaw.length === mark, j(w.runnerSaw.slice(mark)))
  check('a pre-aborted request has no receiver effect', applied === 0)
  applied = 0
  const release = w.runner.holdScope('session')
  const queued = new AbortController()
  const pending = rejection(w.host.request('session/set_mode', { mode: 'default' }, { signal: queued.signal }))
  queued.abort()
  release()
  const queuedError = await pending as InstanceType<typeof errors.RpcError>
  await settle(10)
  check('cancellation while waiting for a scope prevents dispatch', queuedError?.code === errors.RPC_CANCELLED && applied === 0 && w.runner.inFlightCount === 0)
  w.host.end()
  const held = world()
  let asks = 0
  held.host.onRequest('permission/request', () => { asks++; return { outcome: 'allow' } })
  const signal = new AbortController()
  const answer = rejection(held.runner.request('permission/request', { kind: 'network', host: 'proof.test' }, { signal: signal.signal }))
  signal.abort()
  await answer
  await held.initialize()
  await settle(10)
  check('a cancelled request held by the handshake never reaches its handler', asks === 0 && !held.hostSaw.some(frame => frame.method === 'permission/request'), j(held.hostSaw))
  held.host.end()
}

section('W16 incompatible versions refuse explicitly and settle the connection')
{
  const read = await import('../../src/rows/read.ts')
  for (const type of ['session', 'outcome']) {
    for (const schema of [2, undefined]) {
      let caught: unknown
      try { read.parseRow(j({ type, schema, session_id: 's' })) } catch (error) { caught = error }
      check(`${type} schema ${schema}: the reader throws a named schema error`, caught instanceof Error && caught.name === 'RowSchemaMismatch', String(caught))
    }
    const input = new PassThrough()
    const output = new PassThrough()
    const problems: Array<InstanceType<typeof errors.RpcError>> = []
    const host = new Peer({ input, output, side: 'host', onProtocolError: error => problems.push(error) })
    let delivered = 0
    let aborted = false
    host.onNotification('row', () => { delivered++ })
    host.onRequest('permission/request', (_params, ctx) => { ctx.signal.addEventListener('abort', () => { aborted = true }); return new Promise(() => {}) })
    input.write(j({ jsonrpc: '2.0', id: 99, method: 'permission/request', params: { kind: 'network', host: 'proof.test' } }) + '\n')
    const pending = rejection(host.request('session/facts', {}, { deadlineMs: 1000 }))
    input.write(j({ jsonrpc: '2.0', method: 'row', params: { type, schema: 2, session_id: 's' } }) + '\n')
    const error = await pending as InstanceType<typeof errors.RpcError>
    check(`${type} schema 2: pending work receives typed protocol refusal, never a timeout`, error?.code === errors.RPC_REFUSED && (error.data as Frame)?.kind === 'protocol', String(error))
    check(`${type} schema 2: the host is told once, no row delivered, asks aborted`, problems.length === 1 && host.closed && delivered === 0 && aborted && host.pendingCount === 0 && host.inFlightCount === 0, j({ problems: problems.length, closed: host.closed, delivered, aborted }))
    host.end()
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const problems: unknown[] = []
  const host = new Peer({ input, output, side: 'host', onProtocolError: error => problems.push(error) })
  const initialize = host.send('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } })
  const initError = rejection(initialize.answer)
  const facts = rejection(host.request('session/facts', {}, { deadlineMs: 1000 }))
  input.write(j({ jsonrpc: '2.0', id: initialize.id, result: { protocol: 2, runner: { version: 'proof', pid: 1 }, session_id: 's' } }) + '\n')
  const replies = await Promise.all([initError, facts]) as Array<InstanceType<typeof errors.RpcError>>
  check('protocol 2 initialize settles both itself and concurrent work with typed protocol refusal', replies.every(error => error?.code === errors.RPC_REFUSED && (error.data as Frame)?.kind === 'protocol'), j(replies))
  check('protocol 2 closes once and notifies its host', host.closed && problems.length === 1 && host.pendingCount === 0)
  host.end()
  const w = world()
  const bad = await rejection(w.host.request('initialize', { protocol: 2, host: { name: 'proof', version: '1' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } } as never)) as InstanceType<typeof errors.RpcError>
  check('the shared dispatcher refuses a protocol 2 request before its handler', bad?.code === errors.RPC_REFUSED && (bad.data as Frame)?.kind === 'protocol' && !w.runner.initialized, j(bad))
  w.host.end()
  check('both initialize schemas demand the served protocol', !methods.checkParams('initialize', { protocol: 2, host: { name: 'proof', version: '1' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }).ok && !methods.checkResult('initialize', { protocol: 2, runner: { version: 'proof', pid: 1 }, session_id: null }).ok)
}

section('W17 cancellation crosses the initialize barrier')
{
  const params = { protocol: 1, host: { name: 'proof', version: '1' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }
  const w = world()
  let release!: () => void
  let applied = 0
  w.runner.onRequest('initialize', () => new Promise(resolve => { release = () => resolve({ protocol: 1, runner: { version: 'proof', pid: 1 }, session_id: null }) }))
  w.runner.onRequest('session/set_mode', () => { applied++; return { mode: 'default' } })
  w.raw([
    { jsonrpc: '2.0', id: 71, method: 'initialize', params },
    { jsonrpc: '2.0', id: 72, method: 'session/set_mode', params: { mode: 'default' } },
    { jsonrpc: '2.0', method: '$/cancel_request', params: { request_id: 72 } },
  ].map(j).join('\n') + '\n')
  release()
  await settle(20)
  check('a request cancelled in the initialize chunk never runs', applied === 0 && w.hostSaw.some(frame => frame.id === 72 && (frame.error as Frame)?.code === errors.RPC_CANCELLED), j(w.hostSaw))
  w.host.end()
  const retry = world()
  let late!: () => void
  retry.runner.onRequest('initialize', () => new Promise(resolve => { late = () => resolve({ protocol: 1, runner: { version: 'late', pid: 1 }, session_id: null }) }))
  retry.raw([
    { jsonrpc: '2.0', id: 81, method: 'initialize', params },
    { jsonrpc: '2.0', id: 82, method: 'session/facts', params: {} },
    { jsonrpc: '2.0', method: '$/cancel_request', params: { request_id: 81 } },
  ].map(j).join('\n') + '\n')
  retry.runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: 'retry', pid: 1 }, session_id: null }))
  const initialized = await rejection(retry.initialize())
  const facts = await rejection(retry.host.request('session/facts', {}, { deadlineMs: 1000 }))
  late()
  await settle(20)
  check('cancelled initialize permits a fresh handshake and facts request', initialized === undefined && facts === undefined && retry.runner.initialized, j({ initialized, facts }))
  check('cancelled initialize settles queued waiters and never answers twice', retry.hostSaw.filter(frame => frame.id === 81).length === 1 && retry.hostSaw.some(frame => frame.id === 81 && (frame.error as Frame)?.code === errors.RPC_CANCELLED) && retry.hostSaw.some(frame => frame.id === 82 && (frame.error as Frame)?.code === errors.RPC_NOT_INITIALIZED), j(retry.hostSaw))
  retry.host.end()
}

section('W18 a notification the side does not read is logged and ignored before its params are judged: a row to the runner is never a protocol failure')
{
  const w = world()
  const problems: unknown[] = []
  const strict = new Peer({ input: w.toRunner, output: new PassThrough(), side: 'runner', log: l => w.runnerLog.push(l), onProtocolError: error => problems.push(error) })
  w.runner.close('the strict runner takes the input')
  w.raw(j({ jsonrpc: '2.0', method: 'row', params: { type: 'outcome', schema: 2, session_id: 's' } }) + '\n')
  w.raw(j({ jsonrpc: '2.0', method: 'row', params: { type: 'session', schema: 2, session_id: 's' } }) + '\n')
  await settle(20)
  check('a schema-2 row sent to the runner side leaves the runner open — hosts send no rows, so none is judged', !strict.closed && problems.length === 0, j({ closed: strict.closed, problems: problems.length }))
  check('…and the line is logged as a notification this side does not read', w.runnerLog.filter(l => l.includes('notification row is not one this side reads')).length === 2, j(w.runnerLog))
  strict.end()
  w.host.end()
}

section('M the method table is the one source')
{
  const names = methods.METHOD_NAMES
  check('RUNNER_PROTOCOL is 1', methods.RUNNER_PROTOCOL === 1)
  check(`${names.length} methods declared (26 in the design)`, names.length === 26, names.join(' '))
  check('every method name is noun/verb in snake case', names.every(n => /^(\$\/)?[a-z_]+(\/[a-z_]+)?$/.test(n)), names.filter(n => !/^(\$\/)?[a-z_]+(\/[a-z_]+)?$/.test(n)).join(' '))
  check('every spec names itself by its key', names.every(n => methods.METHODS[n].name === n))
  const table: Record<string, [string, number | null]> = {
    initialize: ['none', null],
    'session/claim': ['session', 45_000],
    'session/facts': ['none', 30_000],
    'session/set_model': ['session', 5_000],
    'session/set_effort': ['session', 5_000],
    'session/set_mode': ['session', 5_000],
    'session/set_spawn_switch': ['session', 5_000],
    'session/set_kit': ['mcp', 30_000],
    'session/rewind': ['session', 30_000],
    'session/pause_gate': ['session', 10_000],
    'session/quiesce': ['session', 10_000],
    'queue/add': ['queue', 5_000],
    'queue/withdraw': ['queue', 5_000],
    'turn/interrupt': ['none', 5_000],
    'agent/stop': ['none', 10_000],
    'agent/resume': ['none', 10_000],
    'shell/background': ['none', 10_000],
    'schedule/roster': ['session', null],
  }
  const hostRequests = methods.methodsFrom('host', 'request').map(s => s.name)
  check('the host requests are the eighteen of the design', j([...hostRequests].sort()) === j(Object.keys(table).sort()), hostRequests.join(' '))
  check('each host request carries the design scope and deadline', Object.entries(table).every(([name, [scope, deadline]]) => methods.scopeOf(name) === scope && methods.deadlineOf(name) === deadline), Object.entries(table).filter(([name, [scope, deadline]]) => !(methods.scopeOf(name) === scope && methods.deadlineOf(name) === deadline)).map(([n]) => n).join(' '))
  check('host notifications: credentials/changed and $/cancel_request', j(methods.methodsFrom('host', 'notification').map(s => s.name).sort()) === j(['$/cancel_request', 'credentials/changed']))
  check('runner requests: permission/request, elicitation/request and schedule/edit', j(methods.methodsFrom('runner', 'request').map(s => s.name).sort()) === j(['elicitation/request', 'permission/request', 'schedule/edit']))
  check('schedule/edit is unchained and bounded at ten seconds', methods.scopeOf('schedule/edit') === 'none' && methods.deadlineOf('schedule/edit') === 10_000)
  check('runner notifications: row, session/applied, elicitation/complete and $/cancel_request', j(methods.methodsFrom('runner', 'notification').map(s => s.name).sort()) === j(['$/cancel_request', 'elicitation/complete', 'row', 'session/applied']))
  check('the elicitation methods are the only capability-gated ones', names.filter(n => methods.METHODS[n].capability !== undefined).sort().join(' ') === 'elicitation/complete elicitation/request' && names.filter(n => methods.METHODS[n].capability !== undefined).every(n => methods.METHODS[n].capability === 'elicitation'))
  check('every scope is one of the four', names.every(n => (methods.METHOD_SCOPES as readonly string[]).includes(methods.METHODS[n].scope)))
  check('the capabilities are holds_asks, elicitation and partial_rows', j(methods.CAPABILITIES) === j(['holds_asks', 'elicitation', 'partial_rows']))
  check('the error codes are the eight of the design', j([...errors.RPC_ERROR_CODES].sort((a, b) => a - b)) === j([-32800, -32700, -32603, -32602, -32601, -32600, -32010, -32002]))
  check('the refusal kinds carry the design words', ['protocol', 'claim', 'effort', 'mode', 'kit', 'no-shell', 'nothing-to-resume', 'already-initialized'].every(k => (errors.REFUSAL_KINDS as readonly string[]).includes(k)))
  check('a refusal carries its kind in data', j(errors.refused('no', 'claim').toJSON()) === j({ code: -32010, message: 'no', data: { kind: 'claim' } }))
  check('rpcErrorOf maps a thrown Error to -32603 with its words', j(errors.rpcErrorOf(new Error('boom'))) === j({ code: -32603, message: 'boom' }))
  check('checkParams accepts a prompt row for queue/add and refuses an unknown method param shape', methods.checkParams('queue/add', { type: 'prompt', content: 'x' }).ok && !methods.checkParams('turn/interrupt', { hard: 'yes' }).ok)
  check('checkParams reads absent params as {}', methods.checkParams('session/facts', undefined).ok && methods.checkParams('credentials/changed', undefined).ok)
  check('the row notification carries a vocabulary row', methods.checkParams('row', row(1, 'x')).ok && !methods.checkParams('row', { type: 'assistant' }).ok)
  check('permission answers: allow with rules, deny with stop', methods.checkResult('permission/request', { outcome: 'allow', rules: [] }).ok && methods.checkResult('permission/request', { outcome: 'deny', stop: true }).ok && !methods.checkResult('permission/request', { behavior: 'allow' }).ok)
  check('BAD_LINE_LIMIT is 3 and the line bound is 32 MiB', errors.BAD_LINE_LIMIT === 3 && errors.MAX_LINE_BYTES === 32 * 1024 * 1024)
}

clearTimeout(guard)
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ prove-runner-wire-laws: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-runner-wire-laws: the peer keeps every law of the runner wire')
