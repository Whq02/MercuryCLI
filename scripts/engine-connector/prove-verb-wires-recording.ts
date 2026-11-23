#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { JsonSchema } from '../../sdk/src/rows.ts'
import { METHODS as published } from '../../sdk/src/wire.ts'
import { DAEMON_VERB_BORN_AT, MERCURY_DAEMON_PROTO, MIN_PROTO } from '../../src/daemon/control/protocol.ts'
import { METHODS, RUNNER_PROTOCOL, checkParams, checkResult, type MethodName } from '../../src/daemon/runner-wire/methods.ts'
import { Peer } from '../../src/daemon/runner-wire/peer.ts'
import { permissionModeSchema } from '../../src/permissions/rules/permissionMode.ts'

function samples(schema: JsonSchema, full: boolean): unknown[] {
  if ('const' in schema) return [schema.const]
  if (schema.enum) return [schema.enum[0]]
  const choices = schema.oneOf ?? schema.anyOf
  if (choices) return choices.flatMap(s => samples(s, full))
  if (Array.isArray(schema.type)) return schema.type.flatMap(type => samples({ ...schema, type }, full))
  switch (schema.type) {
    case 'null': return [null]
    case 'boolean': return [false]
    case 'integer': case 'number': return [Math.min(schema.maximum ?? Infinity, Math.max(1, schema.minimum ?? 0, (schema.exclusiveMinimum ?? -1) + 1))]
    case 'string': return ['wire'.padEnd(schema.minLength ?? 0, 'x').slice(0, schema.maxLength)]
    case 'array': return samples(schema.items ?? {}, full).map(item => [item])
    case 'object': {
      if (!schema.properties && schema.additionalProperties) return [{ key: samples(typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {}, full)[0] }]
      const fields = Object.entries(schema.properties ?? {}).filter(([key]) => full || schema.required?.includes(key)).map(([key, value]) => [key, samples(value, full)] as const)
      const first = Object.fromEntries(fields.map(([key, values]) => [key, values[0]]))
      return [first, ...fields.flatMap(([key, values]) => values.slice(1).map(v => ({ ...first, [key]: v }))) ]
    }
    default: return [{ sample: 'value' }]
  }
}

const initIn = { protocol: 1, host: { name: 'wire', version: '1' }, capabilities: { holds_asks: false, elicitation: true, partial_rows: true } } as const
const initOut = { protocol: 1, runner: { version: '1', pid: 42 }, session_id: 'seat' } as const

async function runnerExchange(method: MethodName, params: unknown, result: unknown, from: 'host' | 'runner'): Promise<unknown[]> {
  const sent = new PassThrough()
  const received = new PassThrough()
  const frames: unknown[] = []
  for (const wire of [sent, received]) wire.on('data', (bytes: Buffer) => { if (bytes.length) frames.push(JSON.parse(bytes.toString('utf8'))) })
  const host = new Peer({ side: 'host', input: received, output: sent })
  const runner = new Peer({ side: 'runner', input: sent, output: received })
  try {
    if (method !== 'initialize') {
      runner.onRequest('initialize', () => initOut)
      await host.request('initialize', initIn)
      frames.length = 0
    }
    const source = from === 'host' ? host : runner
    const target = from === 'host' ? runner : host
    const input = checkParams(method, params)
    assert(input.ok, `${method}: invalid parameter sample ${JSON.stringify(input)} — make the params schema of ${method} in src/daemon/runner-wire/methods.ts accept what sdk/src/wire.ts publishes for it`)
    if (METHODS[method].kind === 'request') {
      const output = checkResult(method, result)
      assert(output.ok, `${method}: invalid result sample ${JSON.stringify(output)} — make the result schema of ${method} in src/daemon/runner-wire/methods.ts accept what sdk/src/wire.ts publishes for it`)
      target.onRequest(method, applied => { assert.deepEqual(applied, input.value, `${method}: the receiving peer saw other parameters than were sent; check the Peer in src/daemon/runner-wire/peer.ts`); return output.value })
      assert.deepEqual(await source.request(method, params as never), output.value, `${method}: peer read another answer`)
      assert.equal(frames.length, 2, `${method}: request and answer must both reach the wire`)
    } else {
      let delivered = false
      target.onNotification(method, applied => { assert.deepEqual(applied, input.value, `${method}: the receiving peer saw other parameters than were sent; check the Peer in src/daemon/runner-wire/peer.ts`); delivered = true })
      source.notify(method, params as never)
      await source.writer.flush()
      assert(delivered || method === '$/cancel_request', `${method}: notification did not reach the other peer`)
      assert.equal(frames.length, 1, `${method}: notification has no answer frame`)
    }
    return frames
  } finally {
    host.close()
    runner.close()
  }
}

async function runnerWireRecording(): Promise<Record<string, unknown>> {
  assert.deepEqual(Object.keys(METHODS), Object.keys(published), 'runner/SDK method membership or order differs — make METHODS in src/daemon/runner-wire/methods.ts list the same methods in the same order as METHODS in sdk/src/wire.ts')
  const rows: Record<string, unknown> = {}
  for (const name of Object.keys(published) as MethodName[]) {
    const spec = published[name]
    const seen = new Set<string>()
    const frames: unknown[] = []
    for (const full of [false, true]) {
      const inputs = samples(spec.params, full)
      const outputs = samples(spec.result, full)
      for (let n = 0; n < Math.max(inputs.length, outputs.length); n++) {
        const p = inputs[n % inputs.length]
        const r = outputs[n % outputs.length]
        const key = JSON.stringify([p, r])
        if (seen.has(key)) continue
        seen.add(key)
        for (const from of ['host', 'runner'] as const) if (spec.from === from || spec.from === 'both') frames.push(await runnerExchange(name, p, r, from))
      }
    }
    rows[`runner ${name}`] = frames
  }
  return rows
}

type DaemonWireFixtures = {
  controlKey: string
  cases: Array<{ id: string; frame: Record<string, unknown>; stubReturn?: unknown }>
  clientAliasCases: Array<{ id: string; proto: number; req: Record<string, unknown>; stubReturn: unknown }>
}

type DaemonWireRecording = {
  constants: {
    MERCURY_DAEMON_PROTO: number
    MIN_PROTO: number
    DAEMON_VERB_BORN_AT_KEYS: string[]
    DAEMON_VERB_BORN_AT: Record<string, number>
  }
  cases: Array<{ id: string; requestFrame: string; replyFrame: string; handler: { name: string; input: unknown } | null }>
  clientAliasCases: Array<{
    id: string
    proto: number
    wireFrame: string
    rawReplyFrame: string
    normalizedReply: unknown
    handler: { name: string; input: unknown } | null
  }>
}

function sendRawFrame(sockPath: string, encodedFrame: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath)
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { conn.destroy(); reject(new Error(`timeout waiting for reply on ${sockPath}`)) }, timeoutMs)
    conn.on('connect', () => conn.write(encodedFrame))
    conn.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const whole = Buffer.concat(chunks)
      const nl = whole.indexOf(10)
      if (nl < 0) return
      clearTimeout(timer)
      conn.destroy()
      resolve(whole.subarray(0, nl + 1).toString('utf8'))
    })
    conn.on('error', err => { clearTimeout(timer); reject(err) })
    conn.on('close', () => {
      clearTimeout(timer)
      if (Buffer.concat(chunks).indexOf(10) < 0) reject(new Error('socket closed without newline-terminated reply frame'))
    })
  })
}

async function daemonWireRecording(
  fixtures: DaemonWireFixtures,
): Promise<DaemonWireRecording> {
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-wire-'))
  const homeDir = join(scratch, 'home')
  const daemonDir = join(scratch, 'daemon')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(daemonDir, { recursive: true })
  const prevEnv = {
    MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR,
    MERCURY_DAEMON_DIR: process.env.MERCURY_DAEMON_DIR,
    MERCURY_HOME: process.env.MERCURY_HOME,
    MERCURY_CREDENTIAL_STORE: process.env.MERCURY_CREDENTIAL_STORE,
  }
  let sockPath: string | undefined
  let handle: { close(): Promise<void> } | undefined
  let sockReset: { forgetDaemonProtoForTesting(): void; clearControlKeyMemo(): void } | undefined
  try {
    process.env.MERCURY_CONFIG_DIR = homeDir
    process.env.MERCURY_DAEMON_DIR = daemonDir
    delete process.env.MERCURY_HOME
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    writeFileSync(join(daemonDir, 'control.key'), fixtures.controlKey, { mode: 0o600 })

    const protoMod = await import('../../src/daemon/control/protocol.ts')
    const sockMod = await import('../../src/daemon/control/controlSocket.ts')
    const serverMod = await import('../../src/daemon/control/controlServer.ts')
    sockReset = sockMod
    const { MERCURY_DAEMON_PROTO, MIN_PROTO, DAEMON_VERB_BORN_AT, encodeFrame } = protoMod
    const { controlSockPath, clearControlKeyMemo, forgetDaemonProtoForTesting, noteDaemonProto, sessionOpWireFrame, daemonControlRpc } = sockMod
    clearControlKeyMemo()
    forgetDaemonProtoForTesting()

    let nextStubReturn: unknown = undefined
    let lastHandler: { name: string; input: unknown } | null = null
    const capture = (name: string, input: unknown): unknown => {
      lastHandler = { name, input: JSON.parse(JSON.stringify(input)) }
      return nextStubReturn
    }
    const deps = {
      roster: {} as never,
      breaker: { shouldSuppressFire: () => false } as never,
      dir: '/workspace/demo',
      startedAt: 1700000000000,
      maxInflight: 4,
      controlKey: fixtures.controlKey,
      isReady: () => true,
      onShutdown: () => ({ reaped: 0, workers: [] }),
      concourseAdmit: async (req: unknown) => capture('concourseAdmit', req),
      concourseDispatch: async (req: unknown) => capture('concourseDispatch', req),
      concourseList: () => capture('concourseList', {}),
      concourseRelease: (runnerId: string) => capture('concourseRelease', { runnerId }),
      concourseWithdraw: async (clientMessageId: string) => capture('concourseWithdraw', { clientMessageId }),
      concourseWarm: async (req: unknown) => capture('concourseWarm', req),
      concourseControl: (req: unknown) => capture('concourseControl', req),
      sessionRewind: async (req: unknown) => capture('sessionRewind', req),
      sessionFileRestore: async (req: unknown) => capture('sessionFileRestore', req),
    }

    sockPath = controlSockPath()
    handle = await serverMod.startControlServer(deps as unknown as Parameters<typeof serverMod.startControlServer>[0])

    const cases: DaemonWireRecording['cases'] = []
    for (const entry of fixtures.cases) {
      if (entry.frame.permissionMode !== undefined) permissionModeSchema().parse(entry.frame.permissionMode)
      if (entry.frame.action === 'set-permission-mode') permissionModeSchema().parse(entry.frame.mode)
      nextStubReturn = entry.stubReturn
      lastHandler = null
      const requestFrame = encodeFrame(entry.frame)
      const replyFrame = await sendRawFrame(sockPath, requestFrame)
      cases.push({ id: entry.id, requestFrame, replyFrame, handler: lastHandler })
    }

    const clientAliasCases: DaemonWireRecording['clientAliasCases'] = []
    for (const entry of fixtures.clientAliasCases) {
      noteDaemonProto(entry.proto, '1.0.10-fixture')
      nextStubReturn = entry.stubReturn
      const wireFrame = encodeFrame(
        sessionOpWireFrame({ ...entry.req, proto: entry.proto, auth: fixtures.controlKey } as { op: string; proto?: number }),
      )
      lastHandler = null
      const rawReplyFrame = await sendRawFrame(sockPath, wireFrame)
      lastHandler = null
      const normalizedReply = await daemonControlRpc(entry.req as never, { timeoutMs: 4000, protoRetry: false })
      clientAliasCases.push({ id: entry.id, proto: entry.proto, wireFrame, rawReplyFrame, normalizedReply, handler: lastHandler })
    }

    return {
      constants: {
        MERCURY_DAEMON_PROTO,
        MIN_PROTO,
        DAEMON_VERB_BORN_AT_KEYS: Object.keys(DAEMON_VERB_BORN_AT),
        DAEMON_VERB_BORN_AT: { ...DAEMON_VERB_BORN_AT },
      },
      cases,
      clientAliasCases,
    }
  } finally {
    if (handle) await handle.close()
    sockReset?.forgetDaemonProtoForTesting()
    sockReset?.clearControlKeyMemo()
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (sockPath && process.platform !== 'win32') rmSync(sockPath, { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

interface ConnectorWireExchange {
  requestFrame: string
  replyFrame: string
}

interface ConnectorWireCase {
  id: string
  operation: string
  variant: string
  exchanges: ConnectorWireExchange[]
  receipt: unknown
}

interface ConnectorWireRecordingResult {
  sessionId: string
  cases: ConnectorWireCase[]
}

const CLOCK_ZERO = Date.UTC(2026, 10, 20, 12, 0, 0)
const FIXED_AUTH_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SESSION_ID = 'demo-session-1'
const RUNNER_ID = 'demo-runner-1'
const WAIT_LIMIT_MS = 5_000
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const realSetImmediate = globalThis.setImmediate
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const nextTurn = (): Promise<void> => new Promise(resolveTurn => realSetImmediate(resolveTurn))

type Obj = Record<string, unknown>
type Inbound = { rawFrame: string; parsed: Obj; reply: (obj: Obj) => void; closed: Promise<void> }
type FrameHandler = (frame: Inbound) => void | Promise<void>
type ReplySpec = Obj | ((req: Obj) => Obj)

type SimpleCaseSpec = {
  id: string
  op: string
  variant: string
  reply: ReplySpec
  call: (c: Record<string, (...args: unknown[]) => unknown>) => unknown
  resetFacts?: boolean
  forgetProto?: boolean
  waitExchanges?: number
  sortByAction?: boolean
}

const ctrl = (outcome: string, extra: Obj = {}): Obj => ({ ok: true, op: 'sessionControl', outcome, ...extra })
const err = (code: string, error: string, extra: Obj = {}): Obj => ({ ok: false, code, error, ...extra })
const dispatchOk = (stateRevision: number, state = 'accepted'): ReplySpec => req => ({
  ok: true,
  op: 'sessionDispatch',
  clientMessageId: req.clientMessageId,
  state,
  stateRevision,
})

function buildSimpleCases(): SimpleCaseSpec[] {
  const mode = permissionModeSchema().parse('implement')
  const standard = permissionModeSchema().parse('default')
  const rewindOk = (op: string, mode: string, extra: Obj = {}): Obj => ({ ok: true, op, outcome: 'applied', mode, ...extra })
  const codeDiff = (ins: number, del: number): Obj => ({ filesChanged: ['src/demo.ts'], insertions: ins, deletions: del })
  const answerFollowUp = (rev: number): ReplySpec => req =>
    req.op === 'sessionDispatch' ? (dispatchOk(rev) as (r: Obj) => Obj)(req) : ctrl('applied')
  const boardJson = (payload: Obj): Obj => ctrl('applied', { detail: JSON.stringify(payload) })
  const leaveJson = (payload: Obj): Obj => ctrl('applied', { detail: JSON.stringify(payload) })

  return [
    { id: 'rewind.sessionRewind.minimal.applied', op: 'rewind', variant: 'sessionRewind minimal applied', reply: rewindOk('sessionRewind', 'conversation', { conversation: { turnUuid: 'turn-1', removed: 2 } }), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'conversation' }) },
    { id: 'rewind.sessionRewind.full.dryRun', op: 'rewind', variant: 'sessionRewind full dryRun', reply: rewindOk('sessionRewind', 'both', { dryRun: true, detail: 'preview ok', code: codeDiff(3, 1), conversation: { turnUuid: 'turn-1', removed: 1 } }), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'both', dryRun: true }) },
    { id: 'rewind.sessionRewind.noop', op: 'rewind', variant: 'sessionRewind noop', reply: { ok: true, op: 'sessionRewind', outcome: 'noop', mode: 'code', detail: 'nothing changed' }, call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'code' }) },
    { id: 'rewind.sessionRewind.refused.turnActive', op: 'rewind', variant: 'sessionRewind refused turn-active', reply: { ok: true, op: 'sessionRewind', outcome: 'refused', mode: 'both', refusal: 'turn-active', detail: 'turn in progress' }, call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'both' }) },
    { id: 'rewind.sessionRewind.refused.daemonOlder', op: 'rewind', variant: 'sessionRewind refused daemon-older', forgetProto: true, reply: err('EUNKNOWN', 'unknown op: sessionRewind'), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'both' }) },
    { id: 'rewind.sessionRewind.refused.error', op: 'rewind', variant: 'sessionRewind refused error', reply: err('EREFUSED', 'checkpoint missing'), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'both' }) },
    { id: 'rewind.fileRestore.restore.minimal', op: 'rewind', variant: 'sessionFileRestore restore minimal', reply: rewindOk('sessionFileRestore', 'code', { code: codeDiff(1, 2) }), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'code', filePath: 'src/demo.ts' }) },
    { id: 'rewind.fileRestore.restore.dryRun', op: 'rewind', variant: 'sessionFileRestore restore dryRun', reply: rewindOk('sessionFileRestore', 'code', { dryRun: true, code: codeDiff(1, 2) }), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'code', filePath: 'src/demo.ts', dryRun: true }) },
    { id: 'rewind.fileRestore.undo.minimal', op: 'rewind', variant: 'sessionFileRestore undo minimal', reply: rewindOk('sessionFileRestore', 'code', { detail: 'undone', code: codeDiff(2, 1) }), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'code', undo: true }) },
    { id: 'rewind.fileRestore.undo.dryRun', op: 'rewind', variant: 'sessionFileRestore undo dryRun', reply: rewindOk('sessionFileRestore', 'code', { dryRun: true, code: codeDiff(2, 1) }), call: c => c.rewind!({ userMessageId: 'msg-1', mode: 'code', undo: true, dryRun: true }) },
    { id: 'sendAgentNote.accepted', op: 'sendAgentNote', variant: 'accepted', reply: dispatchOk(1), call: c => c.sendAgentNote!('agent-a', '  please check tests  ') },
    { id: 'sendAgentNote.refused', op: 'sendAgentNote', variant: 'refused', reply: err('EREFUSED', 'agent finished'), call: c => c.sendAgentNote!('agent-a', 'follow up') },
    { id: 'backgroundShell.applied.minimal', op: 'backgroundShell', variant: 'applied minimal', reply: ctrl('applied'), call: c => c.backgroundShell!() },
    { id: 'backgroundShell.applied.detail', op: 'backgroundShell', variant: 'applied detail', reply: ctrl('applied', { detail: 'backgrounded shell 1' }), call: c => c.backgroundShell!() },
    { id: 'backgroundShell.refused', op: 'backgroundShell', variant: 'refused', reply: err('EREFUSED', 'no foreground shell'), call: c => c.backgroundShell!() },
    { id: 'sendNow.applied.minimal', op: 'sendNow', variant: 'applied minimal', reply: ctrl('applied'), call: c => c.sendNow!() },
    { id: 'sendNow.applied.detail', op: 'sendNow', variant: 'applied detail', reply: ctrl('applied', { detail: 'promoted 1 send' }), call: c => c.sendNow!() },
    { id: 'sendNow.refused', op: 'sendNow', variant: 'refused', reply: ctrl('refused', { detail: 'queue empty' }), call: c => c.sendNow!() },
    { id: 'pauseGate.pause.applied', op: 'pauseGate', variant: 'pause true applied', reply: ctrl('applied', { detail: 'gate paused' }), call: c => c.pauseGate!(true) },
    { id: 'pauseGate.unpause.applied', op: 'pauseGate', variant: 'pause false applied', reply: ctrl('applied'), call: c => c.pauseGate!(false) },
    { id: 'pauseGate.refused', op: 'pauseGate', variant: 'refused', reply: err('EREFUSED', 'no crew'), call: c => c.pauseGate!(true) },
    { id: 'postBoard.minimal.ok', op: 'postBoard', variant: 'minimal ok', reply: boardJson({ ok: true, event_id: 'ev-1', seq: 12, replay: false, address: '@all', recipients: ['seat-a', 'seat-b'] }), call: c => c.postBoard!({ clientOpId: 'op-board-1', channel: 'general', text: 'ready' }) },
    { id: 'postBoard.full.ok', op: 'postBoard', variant: 'full with target ok', reply: boardJson({ ok: true, event_id: 'ev-2', seq: 13, replay: true, address: '@seat-b', recipients: ['seat-b'] }), call: c => c.postBoard!({ clientOpId: 'op-board-2', channel: 'whisper', target: 'seat-b', text: 'check diff' }) },
    { id: 'postBoard.refused.candidates', op: 'postBoard', variant: 'refused with candidates', reply: boardJson({ ok: false, reason: 'ambiguous target', candidates: ['seat-a', 'seat-b'] }), call: c => c.postBoard!({ clientOpId: 'op-board-3', channel: 'team', target: 'seat', text: 'hi' }) },
    { id: 'postBoard.nonJsonDetail', op: 'postBoard', variant: 'non-json detail', reply: ctrl('applied', { detail: 'plain error' }), call: c => c.postBoard!({ clientOpId: 'op-board-5', channel: 'general', text: 'plain' }) },
    { id: 'postBoard.refused.daemon', op: 'postBoard', variant: 'refused daemon error', reply: err('EREFUSED', 'board closed'), call: c => c.postBoard!({ clientOpId: 'op-board-4', channel: 'general', text: 'hi' }) },
    { id: 'leave.stored', op: 'leave', variant: 'stored with noteChars', reply: leaveJson({ note: 'stored', noteChars: 42 }), call: c => c.leave!() },
    { id: 'leave.skipped', op: 'leave', variant: 'skipped', reply: leaveJson({ note: 'skipped' }), call: c => c.leave!() },
    { id: 'leave.none', op: 'leave', variant: 'none', reply: leaveJson({ note: 'none' }), call: c => c.leave!() },
    { id: 'leave.unreadableReceipt', op: 'leave', variant: 'unreadable detail', reply: ctrl('applied', { detail: 'not-json' }), call: c => c.leave!() },
    { id: 'leave.refused', op: 'leave', variant: 'refused', reply: err('EREFUSED', 'cannot leave now'), call: c => c.leave!() },
    { id: 'stopAgent.minimal.applied', op: 'stopAgent', variant: 'minimal applied', reply: ctrl('applied'), call: c => c.stopAgent!('agent-a') },
    { id: 'stopAgent.full.applied', op: 'stopAgent', variant: 'full with note applied', reply: ctrl('applied', { detail: 'stopped agent-a' }), call: c => c.stopAgent!('agent-a', 'wrap up') },
    { id: 'stopAgent.refused', op: 'stopAgent', variant: 'refused', reply: ctrl('refused', { detail: 'unknown agent' }), call: c => c.stopAgent!('agent-a') },
    { id: 'resumeAgent.minimal.applied', op: 'resumeAgent', variant: 'minimal applied', reply: ctrl('applied'), call: c => c.resumeAgent!('agent-a') },
    { id: 'resumeAgent.full.applied', op: 'resumeAgent', variant: 'full with note applied', reply: ctrl('applied', { detail: 'resumed agent-a' }), call: c => c.resumeAgent!('agent-a', 'continue') },
    { id: 'resumeAgent.refused', op: 'resumeAgent', variant: 'refused', reply: err('EREFUSED', 'agent exited'), call: c => c.resumeAgent!('agent-a') },
    { id: 'setModel.minimal.applied', op: 'setModel', variant: 'minimal applied', resetFacts: true, reply: ctrl('applied'), call: c => c.setModel!('claude-opus-4-6') },
    { id: 'setModel.applied.defaultDetailSuppressed', op: 'setModel', variant: 'applied default detail suppressed', resetFacts: true, reply: ctrl('applied', { detail: `${RUNNER_ID} → claude-opus-4-6` }), call: c => c.setModel!('claude-opus-4-6') },
    { id: 'setModel.applied.customDetail', op: 'setModel', variant: 'applied custom detail note', resetFacts: true, reply: ctrl('applied', { detail: 'alias resolved' }), call: c => c.setModel!('claude-opus-4-6') },
    { id: 'setModel.full.appliedRespawned', op: 'setModel', variant: 'full with words respawned', resetFacts: true, reply: ctrl('applied', { detail: 'respawned on gpt-5', respawned: true }), call: c => c.setModel!('gpt-5', 'switch provider') },
    { id: 'setModel.queued', op: 'setModel', variant: 'queued', resetFacts: true, reply: ctrl('queued'), call: c => c.setModel!('claude-haiku-4-5') },
    { id: 'setModel.noop', op: 'setModel', variant: 'noop', resetFacts: true, reply: ctrl('noop'), call: c => c.setModel!('claude-sonnet-4-6') },
    { id: 'setModel.refused', op: 'setModel', variant: 'refused', resetFacts: true, reply: ctrl('refused', { detail: 'unknown model' }), call: c => c.setModel!('bad-model') },
    { id: 'setEffort.applied', op: 'setEffort', variant: 'applied', resetFacts: true, reply: ctrl('applied'), call: c => c.setEffort!('high') },
    { id: 'setEffort.queued', op: 'setEffort', variant: 'queued', resetFacts: true, reply: ctrl('queued'), call: c => c.setEffort!('max') },
    { id: 'setEffort.noop', op: 'setEffort', variant: 'noop', resetFacts: true, reply: ctrl('noop'), call: c => c.setEffort!('low') },
    { id: 'setEffort.refused', op: 'setEffort', variant: 'refused', resetFacts: true, reply: ctrl('refused', { detail: 'effort unsupported' }), call: c => c.setEffort!('minimal') },
    { id: 'mcpAction.authenticate.applied', op: 'mcpAction', variant: 'authenticate applied', reply: ctrl('applied', { detail: 'signed in' }), call: c => c.mcpAction!('srv-a', 'authenticate') },
    { id: 'mcpAction.reconnect.applied', op: 'mcpAction', variant: 'reconnect applied', reply: ctrl('applied'), call: c => c.mcpAction!('srv-a', 'reconnect') },
    { id: 'mcpAction.cancelAuth.refused', op: 'mcpAction', variant: 'cancel-auth refused', reply: ctrl('refused', { detail: 'no sign-in in progress' }), call: c => c.mcpAction!('srv-a', 'cancel-auth') },
    {
      id: 'mcpTools.connected',
      op: 'mcpTools',
      variant: 'connected with tools',
      reply: ctrl('applied', {
        mcpTools: {
          server: 'srv-a',
          state: 'connected',
          tools: [
            { name: 'search', registeredAs: 'mcp__srv-a__search', description: 'search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, loading: 'listed' },
            { name: 'big', registeredAs: 'mcp__srv-a__big', description: 'truncated…', descriptionCut: true, inputSchema: {}, schemaWithheldBytes: 4096, loading: 'deferred' },
          ],
          omitted: 1,
          detail: '1 omitted',
        },
      }),
      call: c => c.mcpTools!('srv-a'),
    },
    { id: 'mcpTools.malformed', op: 'mcpTools', variant: 'malformed payload', reply: ctrl('applied', { mcpTools: { bad: true } }), call: c => c.mcpTools!('srv-a') },
    { id: 'mcpTools.refused', op: 'mcpTools', variant: 'refused', reply: err('EREFUSED', 'runner absent'), call: c => c.mcpTools!('srv-a') },
    { id: 'setKit.minimal.applied', op: 'setKit', variant: 'minimal applied', reply: ctrl('applied'), call: c => c.setKit!({ mcp: [{ name: 'srv-a', on: true }] }) },
    { id: 'setKit.full.queued', op: 'setKit', variant: 'full queued', reply: ctrl('queued', { detail: 'applies next turn' }), call: c => c.setKit!({ mcp: [{ name: 'srv-a', on: false }], mcpKnown: ['srv-a', 'srv-b'], skills: [{ name: 'demo-skill', state: 'invocable' }], extensions: [{ name: 'ext-one', on: true }] }) },
    { id: 'setKit.noop', op: 'setKit', variant: 'noop', reply: ctrl('noop'), call: c => c.setKit!({ skills: [{ name: 'demo-skill', state: 'off' }] }) },
    { id: 'setKit.refused', op: 'setKit', variant: 'refused', reply: ctrl('refused', { detail: 'kit locked' }), call: c => c.setKit!({ extensions: [{ name: 'ext-one', on: false }] }) },
    { id: 'setSpawnSwitch.subagents.on', op: 'setSpawnSwitch', variant: 'subagents on applied', reply: ctrl('applied', { detail: 'subagents on' }), call: c => c.setSpawnSwitch!('subagents', true) },
    { id: 'setSpawnSwitch.workflows.off', op: 'setSpawnSwitch', variant: 'workflows off queued', reply: ctrl('queued'), call: c => c.setSpawnSwitch!('workflows', false) },
    { id: 'setSpawnSwitch.refused', op: 'setSpawnSwitch', variant: 'refused', reply: err('EREFUSED', 'locked by policy'), call: c => c.setSpawnSwitch!('subagents', false) },
    { id: 'setPermissionMode.applied', op: 'setPermissionMode', variant: 'applied', resetFacts: true, reply: ctrl('applied', { detail: 'mode set' }), call: c => c.setPermissionMode!(mode) },
    { id: 'setPermissionMode.noop', op: 'setPermissionMode', variant: 'noop', resetFacts: true, reply: ctrl('noop'), call: c => c.setPermissionMode!(standard) },
    { id: 'setPermissionMode.refused', op: 'setPermissionMode', variant: 'refused', resetFacts: true, reply: ctrl('refused', { detail: 'not permitted' }), call: c => c.setPermissionMode!(mode) },
    { id: 'answerAsk.allow.minimal', op: 'answerAsk', variant: 'allow minimal', reply: ctrl('applied'), call: c => c.answerAsk!('ask-1', { kind: 'allow' }) },
    { id: 'answerAsk.allow.full', op: 'answerAsk', variant: 'allow full with feedback and contentBlocks', reply: answerFollowUp(1), waitExchanges: 2, call: c => c.answerAsk!('ask-2', { kind: 'allow', updatedInput: { command: 'ls -la' }, permissionUpdates: [{ type: 'setMode', mode: standard, destination: 'session' }], feedback: 'run carefully', contentBlocks: [{ type: 'text', text: 'extra note' }] }) },
    { id: 'answerAsk.deny.minimal', op: 'answerAsk', variant: 'deny minimal', reply: ctrl('applied'), call: c => c.answerAsk!('ask-3', { kind: 'deny' }) },
    { id: 'answerAsk.deny.full', op: 'answerAsk', variant: 'deny full with feedback and contentBlocks', reply: answerFollowUp(2), waitExchanges: 2, call: c => c.answerAsk!('ask-4', { kind: 'deny', feedback: 'not now', contentBlocks: [{ type: 'text', text: 'block note' }] }) },
    { id: 'answerAsk.abort', op: 'answerAsk', variant: 'abort', reply: ctrl('applied'), call: c => c.answerAsk!('ask-5', { kind: 'abort' }) },
    { id: 'answerAsk.refused', op: 'answerAsk', variant: 'refused', reply: ctrl('refused', { detail: 'already answered' }), call: c => c.answerAsk!('ask-6', { kind: 'allow' }) },
    { id: 'sendWords.minimal.accepted', op: 'sendWords', variant: 'minimal accepted', reply: dispatchOk(1), call: c => c.sendWords!('hello world') },
    { id: 'sendWords.full.bashImageMeta', op: 'sendWords', variant: 'full bash image metaFrom', reply: dispatchOk(2), call: c => c.sendWords!('echo hi', { mode: 'bash', metaFrom: { command: '/bash' }, pastedContents: { 1: { id: 1, type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png' } } }) },
    { id: 'sendWords.held', op: 'sendWords', variant: 'held', reply: err('EREFUSED', 'session-paused: waiting', { heldReason: 'paused' }), call: c => c.sendWords!('hold me') },
    { id: 'sendWords.refused', op: 'sendWords', variant: 'refused', reply: err('EREFUSED', 'workspace closed'), call: c => c.sendWords!('reject me') },
    { id: 'dispatchSlash.bare', op: 'dispatchSlash', variant: 'bare command', reply: dispatchOk(3), call: c => c.dispatchSlash!('help') },
    { id: 'dispatchSlash.slashed', op: 'dispatchSlash', variant: 'leading slash command', reply: dispatchOk(4), call: c => c.dispatchSlash!('/status') },
  ]
}

function makeNormalizer(): { str: (s: string) => string; val: (v: unknown) => unknown } {
  const uuidMap = new Map<string, string>()
  const pidToken = `operator:${process.pid}`
  const str = (input: string): string =>
    input.replaceAll(pidToken, 'operator:<pid>').replace(UUID_RE, match => {
      const lower = match.toLowerCase()
      let mapped = uuidMap.get(lower)
      if (mapped === undefined) {
        mapped = `00000000-0000-4000-8000-${String(uuidMap.size + 1).padStart(12, '0')}`
        uuidMap.set(lower, mapped)
      }
      return mapped
    })
  const val = (v: unknown): unknown => {
    if (typeof v === 'string') return str(v)
    if (Array.isArray(v)) return v.map(val)
    if (v !== null && typeof v === 'object') {
      const out: Obj = {}
      for (const [k, item] of Object.entries(v as Obj)) out[k] = val(item)
      return out
    }
    return v
  }
  return { str, val }
}

function createWireServer(
  encodeFrame: (obj: unknown) => string,
  norm: { str: (s: string) => string },
): {
  server: net.Server
  setHandler: (h: FrameHandler | null) => void
  resetExchanges: () => void
  exchanges: () => ConnectorWireExchange[]
  waitForExchanges: (count: number, label: string) => Promise<void>
} {
  let activeExchanges: ConnectorWireExchange[] = []
  let activeHandler: FrameHandler | null = null
  const waiters: Array<() => void> = []
  const notify = (): void => {
    for (const wake of waiters.splice(0)) wake()
  }
  const server = net.createServer(sock => {
    let buf = ''
    let markClosed: () => void = () => {}
    const closed = new Promise<void>(resolveClose => {
      markClosed = resolveClose
    })
    sock.on('error', () => {})
    sock.on('close', () => markClosed())
    sock.on('data', chunk => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const rawLine = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const rawFrame = `${rawLine}\n`
      const parsed = JSON.parse(rawLine) as Obj
      if (parsed.op === 'hello') {
        sock.end(
          encodeFrame({
            ok: true,
            op: 'hello',
            proto: parsed.proto,
            minProto: 1,
            ready: true,
            version: typeof parsed.clientVersion === 'string' ? parsed.clientVersion : '1.0.0',
            buildTree: null,
            pid: process.pid,
            startedAt: CLOCK_ZERO,
            ownerPid: null,
            foreground: false,
            live: 0,
            liveSessions: 0,
            warm: 0,
            restartArmed: false,
          }),
        )
        return
      }
      const reply = (obj: Obj): void => {
        const rawReply = encodeFrame(obj)
        activeExchanges.push({ requestFrame: norm.str(rawFrame), replyFrame: norm.str(rawReply) })
        sock.end(rawReply)
        notify()
      }
      if (activeHandler === null) {
        reply(err('EUNKNOWN', 'unexpected frame with no active handler'))
        return
      }
      void Promise.resolve(activeHandler({ rawFrame, parsed, reply, closed }))
    })
  })
  return {
    server,
    setHandler: h => {
      activeHandler = h
    },
    resetExchanges: () => {
      activeExchanges = []
    },
    exchanges: () => [...activeExchanges],
    waitForExchanges: async (count, label) => {
      if (activeExchanges.length >= count) return
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = realSetTimeout(() => rejectWait(new Error(`${label}: timed out waiting for ${count} wire exchange(s) (got ${activeExchanges.length}); the connector in src/engine/connector/daemonConnector.ts did not send the expected frames`)), WAIT_LIMIT_MS)
        const check = (): void => {
          if (activeExchanges.length >= count) {
            realClearTimeout(timer)
            resolveWait()
          } else {
            waiters.push(check)
          }
        }
        waiters.push(check)
      })
    },
  }
}

async function connectorWireRecording(): Promise<ConnectorWireRecordingResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'connector-wire-rec-'))
  const homeDir = join(scratch, 'home')
  const daemonDir = join(scratch, 'daemon')
  const workDir = join(scratch, 'work')
  for (const dir of [homeDir, daemonDir, workDir]) mkdirSync(dir, { recursive: true })

  const envKeys = ['MERCURY_CONFIG_DIR', 'MERCURY_DAEMON_DIR', 'MERCURY_HOME', 'MERCURY_LOCAL_PROBE_TARGETS', 'MERCURY_CONNECTOR_TRACE', 'MERCURY_COMPUTER_USE', 'MERCURY_DESKTOP_DRIVER', 'MERCURY_DESKTOP_FAKE_SCENE', 'MERCURY_DESKTOP_FAKE_LOG'] as const
  const savedEnv = new Map<string, string | undefined>(envKeys.map(k => [k, process.env[k]]))
  const globalRecord = globalThis as Record<string, unknown>
  const hadMacro = 'MACRO' in globalRecord
  const savedMacro = globalRecord.MACRO
  const RealDate = globalThis.Date

  process.env.MERCURY_CONFIG_DIR = homeDir
  process.env.MERCURY_DAEMON_DIR = daemonDir
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  process.env.MERCURY_DESKTOP_DRIVER = 'fake'
  delete process.env.MERCURY_HOME
  delete process.env.MERCURY_CONNECTOR_TRACE
  delete process.env.MERCURY_COMPUTER_USE
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  delete process.env.MERCURY_DESKTOP_FAKE_LOG
  if (!hadMacro) globalRecord.MACRO = { VERSION: '1.0.0' }
  globalRecord.Date = new Proxy(RealDate, {
    construct: (target, args: unknown[]) => (args.length === 0 ? new target(CLOCK_ZERO) : new (target as new (...a: unknown[]) => Date)(...args)),
    apply: target => new target(CLOCK_ZERO).toString(),
    get: (target, prop, receiver) => (prop === 'now' ? () => CLOCK_ZERO : Reflect.get(target, prop, receiver)),
  })

  const bootstrap = await import('../../src/boot/process-state/processState.ts')
  const savedInteractive = bootstrap.getIsInteractive()
  bootstrap.setIsInteractive(false)
  ;(await import('../../src/platform/config/globalConfig.ts')).enableConfigs()

  const { MERCURY_DAEMON_PROTO, encodeFrame } = await import('../../src/daemon/control/protocol.ts')
  const { clearControlKeyMemo, controlKeyPath, controlSockPath, daemonStatePath, forgetDaemonProtoForTesting } = await import('../../src/daemon/control/controlSocket.ts')
  const { _resetDaemonUsableMemoForProofs } = await import('../../src/daemon/switchboard/ensureDaemon.ts')
  const { resetDesktopDriverForTest } = await import('../../src/integrations/desktop/resolveDriver.ts')
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const { publishSessionAsks, publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')

  clearControlKeyMemo()
  forgetDaemonProtoForTesting()
  _resetDaemonUsableMemoForProofs()
  resetDesktopDriverForTest()
  writeFileSync(controlKeyPath(), FIXED_AUTH_KEY, { mode: 0o600 })

  const norm = makeNormalizer()
  const wire = createWireServer(encodeFrame, norm)
  const sockPath = controlSockPath()
  await new Promise<void>((resolveListen, rejectListen) => {
    wire.server.once('error', rejectListen)
    wire.server.listen(sockPath, () => resolveListen())
  })
  writeFileSync(
    daemonStatePath(),
    JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: CLOCK_ZERO, dir: daemonDir, controlSock: sockPath, proto: MERCURY_DAEMON_PROTO }),
  )

  let connector: InstanceType<typeof DaemonSessionConnector> | null = null
  try {
    let readFactsHand: () => void = () => {}
    let factsSeq = 0
    const writeFacts = (overrides: Obj = {}): void => {
      factsSeq += 1
      publishSessionFacts({
        schema: 1,
        sessionId: SESSION_ID,
        atMs: CLOCK_ZERO + factsSeq * 1000,
        pendingModel: null,
        busy: false,
        model: { effective: 'claude-sonnet-5-5', setting: null },
        effort: 'medium',
        usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
        identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
        skills: [],
        mcp: [],
        permissionMode: 'default',
        workspace: { cwd: workDir, originalCwd: workDir, projectRoot: workDir },
        queue: [],
        ...overrides,
      } as never)
      readFactsHand()
    }

    publishSessionAsks({
      schema: 1,
      sessionId: SESSION_ID,
      asks: [1, 2, 3, 4, 5, 6].map(n => ({ requestId: `ask-${n}`, toolUseId: `toolu_ask_${n}`, toolName: 'Bash', input: { command: `echo step-${n}` }, description: `run step ${n}`, askedAt: CLOCK_ZERO + n })) as never,
    })

    connector = new DaemonSessionConnector(
      { sessionId: SESSION_ID, runnerId: RUNNER_ID, title: 'Demo Session', projectLabel: 'demo', workspaceId: workDir, home: homeDir, modelKey: 'claude-sonnet-5-5', effort: 'medium' },
      { factsRead: read => void (readFactsHand = read) },
    )
    writeFacts()

    const cases: ConnectorWireCase[] = []
    const runCase = async (id: string, operation: string, variant: string, handler: FrameHandler, invoke: () => unknown, opts: { waitExchanges?: number; sortByAction?: boolean } = {}): Promise<void> => {
      wire.resetExchanges()
      wire.setHandler(handler)
      const receipt = await invoke()
      if (opts.waitExchanges !== undefined) await wire.waitForExchanges(opts.waitExchanges, id)
      await nextTurn()
      const recorded = wire.exchanges()
      if (opts.sortByAction) {
        recorded.sort((a, b) => String((JSON.parse(a.requestFrame) as { action?: unknown }).action ?? '').localeCompare(String((JSON.parse(b.requestFrame) as { action?: unknown }).action ?? '')))
      }
      wire.setHandler(null)
      cases.push({ id, operation, variant, exchanges: recorded, receipt: receipt === undefined ? null : norm.val(receipt) })
    }
    const staticHandler = (spec: ReplySpec): FrameHandler => frame => frame.reply(typeof spec === 'function' ? spec(frame.parsed) : spec)

    for (const spec of buildSimpleCases()) {
      if (spec.resetFacts) writeFacts()
      if (spec.forgetProto) forgetDaemonProtoForTesting()
      await runCase(spec.id, spec.op, spec.variant, staticHandler(spec.reply), () => spec.call(connector as never), { waitExchanges: spec.waitExchanges, sortByAction: spec.sortByAction })
    }

    for (const [id, variant, interruptReply, leaveNote] of [
      ['leave.aborted.interruptApplied', 'aborted mid-flight interrupt applied', ctrl('applied'), 'skipped'],
      ['leave.aborted.interruptRefused', 'aborted mid-flight interrupt refused', ctrl('refused', { detail: 'already stopping' }), 'none'],
    ] as const) {
      const ac = new AbortController()
      let heldLeave: Inbound | null = null
      await runCase(
        id,
        'leave',
        variant,
        async frame => {
          if (frame.parsed.action === 'leave') {
            heldLeave = frame
            ac.abort()
            return
          }
          if (frame.parsed.action === 'interrupt') {
            frame.reply(interruptReply)
            await frame.closed
            await nextTurn()
            heldLeave?.reply(ctrl('applied', { detail: JSON.stringify({ note: leaveNote }) }))
          }
        },
        () => connector!.leave({ signal: ac.signal }),
      )
    }

    writeFacts({ busy: true })
    const queueOne = async (text: string): Promise<string> => {
      wire.resetExchanges()
      wire.setHandler(staticHandler(dispatchOk(5, 'queued')))
      await connector!.sendWords(text)
      wire.setHandler(null)
      const recallable = connector!.recallableSend()
      if (recallable === null) throw new Error(`expected recallable send for ${text}; sendWords on the connector in src/engine/connector/daemonConnector.ts must leave a queued send that recallableSend returns`)
      return recallable.clientMessageId
    }
    for (const [id, variant, text, reply] of [
      ['withdrawSend.withdrawn', 'withdrawn', 'queued prompt 1', ctrl('applied', { withdrawn: true, text: 'queued prompt 1' })],
      ['withdrawSend.taken', 'reason taken', 'queued prompt 2', ctrl('applied', { withdrawn: false, reason: 'taken' })],
      ['withdrawSend.unknown', 'reason unknown', 'queued prompt 3', ctrl('applied', { withdrawn: false, reason: 'unknown' })],
      ['withdrawSend.refused', 'refused', 'queued prompt 4', ctrl('refused', { detail: 'withdraw refused' })],
    ] as const) {
      const msgId = await queueOne(text)
      await runCase(id, 'withdrawSend', variant, staticHandler(reply), () => connector!.withdrawSend(msgId))
    }

    writeFacts({ busy: true, turnStartedAt: CLOCK_ZERO })
    await runCase('interrupt.soft', 'interrupt', 'soft interrupt', staticHandler(ctrl('applied')), () => connector!.interrupt(), { waitExchanges: 1 })
    await runCase('interrupt.hard', 'interrupt', 'hard interrupt', staticHandler(ctrl('applied')), () => connector!.interrupt(), { waitExchanges: 1 })
    writeFacts({ busy: false })

    await runCase('attach.sessionFactsAndFocus', 'attach', 'session-facts and focus', staticHandler(ctrl('applied')), () => connector!.attach(), { sortByAction: true, waitExchanges: 2 })
    await runCase('detach.blur', 'detach', 'blur', staticHandler(ctrl('applied')), () => connector!.detach(), { waitExchanges: 1 })

    return { sessionId: SESSION_ID, cases }
  } finally {
    if (connector?.isAttached()) connector.detach()
    await new Promise<void>(resolveClose => wire.server.close(() => resolveClose()))
    clearControlKeyMemo()
    forgetDaemonProtoForTesting()
    _resetDaemonUsableMemoForProofs()
    resetDesktopDriverForTest()
    bootstrap.setIsInteractive(savedInteractive)
    globalRecord.Date = RealDate
    if (hadMacro) globalRecord.MACRO = savedMacro
    else delete globalRecord.MACRO
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function verbWiresRecording(input: DaemonWireFixtures): Promise<Record<string, unknown>> {
  const runner = await runnerWireRecording()
  const connector = await connectorWireRecording()
  const daemon = await daemonWireRecording(input)
  return {
    protocols: [MERCURY_DAEMON_PROTO, MIN_PROTO, RUNNER_PROTOCOL, DAEMON_VERB_BORN_AT],
    ...runner,
    ...Object.fromEntries(connector.cases.map(c => [`connector ${c.id}`, [c.exchanges, c.receipt]])),
    ...Object.fromEntries([...daemon.cases, ...daemon.clientAliasCases].map(c => [`daemon ${c.id}`, c])),
  }
}

if (import.meta.main) {
  const recordingFile = new URL('./verb-wires-recording.json', import.meta.url)
  const stored: { input: string; expected: Record<string, string> } = JSON.parse(readFileSync(recordingFile, 'utf8'))
  const input = JSON.parse(inflateRawSync(Buffer.from(stored.input, 'base64')).toString('utf8')) as DaemonWireFixtures
  const actual = await verbWiresRecording(input)
  const { expected } = stored
  if (process.argv.includes('--record')) {
    const moved: string[] = []
    const next: Record<string, string> = {}
    for (const [name, row] of Object.entries(actual)) {
      const now = Buffer.from(JSON.stringify(row))
      const kept = expected[name]
      if (kept !== undefined && inflateRawSync(Buffer.from(kept, 'base64')).equals(now)) next[name] = kept
      else {
        next[name] = deflateRawSync(now).toString('base64')
        moved.push(name)
      }
    }
    const gone = Object.keys(expected).filter(name => !(name in actual))
    writeFileSync(recordingFile, `${JSON.stringify({ input: stored.input, expected: next }, null, 2)}\n`)
    console.log(`recorded ${Object.keys(next).length} wire recordings: ${moved.length} moved${moved.length > 0 ? ` (${moved.join(', ')})` : ''}, ${gone.length} gone${gone.length > 0 ? ` (${gone.join(', ')})` : ''}`)
    process.exit(0)
  }
  assert.deepEqual(Object.keys(actual), Object.keys(expected), 'the recorded faces and verbs must not change — a wire face or verb was added, removed or renamed; undo it in src/daemon/runner-wire/methods.ts, src/daemon/control/protocol.ts or src/engine/connector/daemonConnector.ts, or update scripts/engine-connector/verb-wires-recording.json on purpose')
  for (const [name, row] of Object.entries(actual)) {
    const now = Buffer.from(JSON.stringify(row))
    const then = inflateRawSync(Buffer.from(expected[name]!, 'base64'))
    if (!then.equals(now)) {
      let i = 0
      while (i < Math.min(then.length, now.length) && then[i] === now[i]) i++
      throw Error(`${name}: wire recording differs at byte ${i}; keep the base frame: undo the change to the frame in src/daemon/runner-wire/methods.ts, src/daemon/control/protocol.ts, src/daemon/control/controlSocket.ts or src/engine/connector/daemonConnector.ts that moved it, or when the change is meant re-take the recording with bun scripts/engine-connector/prove-verb-wires-recording.ts --record (recording: scripts/engine-connector/verb-wires-recording.json). Before: ${then.toString('utf8', Math.max(0, i - 30), i + 100)} After: ${now.toString('utf8', Math.max(0, i - 30), i + 100)}`)
    }
  }
  console.log(`${Object.keys(actual).length} wire recordings match`)
}
