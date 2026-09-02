#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-turn.ts — the coordinator's
//  REAL agent turn, structurally.
//
//  §1 the read sandbox — read_file/grep/list_dir refuse every path that
//     resolves outside the workspace root: `..` walks, absolute paths, and
//     symlink escapes (lexical AND realpath checks).
//  §2 Q3's two-step — stop_session on a workflows-allowed session returns a
//     typed needs-your-confirmation result WITHOUT touching the daemon;
//     operatorConfirmed:true releases through the real door; an untagged
//     session stops without ceremony.
//  §3 idempotent identities — launch_session mints a durable clientMessageId
//     per call (fresh per call, stamped as the receipt opId), rides the
//     sessionDispatch door, and grants workflows through sessionControl
//     ONLY after a successful launch (never after a refusal).
//  §4 door truth — message/pause/resume/answer ride the exact daemon ops
//     with the coordinator seat stamped as `by`.
//  §5 the persona — no banned vocabulary (the two-name law +: the
//     word "agent" and the kernel nouns never appear), the required plain
//     words do, and the lane's contract IS the persona (one home, v5+).
//  §6 the caps + the ruled tool roster — 8 calls · 8192 output tokens ·
//     120s wall; the tool set is exactly the operator-ruled twelve.
//
//  Hermetic: injected rpc/board recorders; no daemon socket, no provider
//  call, no config home write.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'switchboard-turn-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}

import { checker } from '../engine-durability/harness.ts'

const t = checker()

const tools = await import('../../src/services/concourse/coordinatorTools.ts')
const persona = await import('../../src/services/concourse/coordinatorPersona.ts')
const call = await import('../../src/services/concourse/coordinatorCall.ts')
const lane = await import('../../src/services/concourse/coordinatorLane.ts')

// ── the sandbox estate ──────────────────────────────────────────────────────

const root = join(scratch, 'root')
const outside = join(scratch, 'outside')
mkdirSync(join(root, 'src'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(root, 'src', 'inside.ts'), 'export const ok = 1\n')
writeFileSync(join(outside, 'secret.txt'), 'not yours\n')
symlinkSync(outside, join(root, 'escape-dir'))
symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file.txt'))

t.section('§1 — the read sandbox refuses everything outside the workspace root')
{
  const inside = (p: string) => tools.resolveReadSandboxPath(root, p)
  t.check('a plain inside path resolves', inside('src/inside.ts') !== null)
  t.check("'.' (the root itself) resolves", inside('.') !== null)
  t.check('an inside path with a folded .. resolves', inside('src/../src/inside.ts') !== null)
  t.check('an absolute inside path resolves', inside(join(root, 'src', 'inside.ts')) !== null)
  t.check('a .. walk out is refused', inside('../outside/secret.txt') === null)
  t.check('a deep .. walk out is refused', inside('src/../../outside/secret.txt') === null)
  t.check('an absolute outside path is refused', inside(join(outside, 'secret.txt')) === null)
  t.check('a symlinked FILE escape is refused (realpath check)', inside('escape-file.txt') === null)
  t.check('a symlinked DIR escape is refused (realpath check)', inside('escape-dir/secret.txt') === null)
  t.check(
    'a nonexistent leaf under a symlinked-out parent is refused',
    inside('escape-dir/never-written.txt') === null,
  )
  t.check('a NUL-poisoned path is refused', inside('src/\0inside.ts') === null)

  // The same law through the REAL tools (the sandbox IS these functions).
  const defs = tools.coordinatorToolSet()
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: root,
    by: 'coordinator-test',
    rpc: async () => {
      throw new Error('the read tools must never reach the daemon')
    },
    readWorkers: async () => ({}),
  })
  const runTool = async (name: string, input: unknown) => {
    const def = defs.find(d => d.name === name)
    if (def === undefined) throw new Error(`no tool ${name}`)
    const out = await def.run(input, ctx)
    return JSON.parse(out.content) as Record<string, unknown>
  }
  const readOut = await runTool('read_file', { path: '../outside/secret.txt' })
  t.check('read_file refuses the escape typed', readOut.ok === false && String(readOut.refused).includes('workspace root'), JSON.stringify(readOut))
  const grepOut = await runTool('grep', { pattern: 'secret', path: '../outside' })
  t.check('grep refuses the escape typed', grepOut.ok === false && String(grepOut.refused).includes('workspace root'), JSON.stringify(grepOut))
  const listOut = await runTool('list_dir', { path: 'escape-dir' })
  t.check('list_dir refuses the symlink escape typed', listOut.ok === false && String(listOut.refused).includes('workspace root'), JSON.stringify(listOut))
  const readIn = await runTool('read_file', { path: 'src/inside.ts' })
  t.check('read_file reads the inside file', readIn.ok === true && String(readIn.text).includes('export const ok'), JSON.stringify(readIn).slice(0, 120))
}

// ── a recording rpc + a board for the verb tools ────────────────────────────

type Call = { req: Record<string, unknown> }
function recordingCtx(opts: {
  replies?: (req: Record<string, unknown>) => Record<string, unknown>
  workers?: Record<string, { runnerId: string; sessionId: string; workflowsAllowed?: true }>
}): { ctx: import('../../src/services/concourse/coordinatorTools.ts').CoordinatorToolContext; calls: Call[] } {
  const calls: Call[] = []
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: root,
    by: 'coordinator-seat',
    rpc: async req => {
      const r = req as Record<string, unknown>
      calls.push({ req: r })
      return opts.replies?.(r) ?? { ok: true, outcome: 'applied' }
    },
    readWorkers: async () => (opts.workers ?? {}) as never,
  })
  return { ctx, calls }
}
const defs = tools.coordinatorToolSet()
const toolByName = (name: string) => {
  const d = defs.find(x => x.name === name)
  if (d === undefined) throw new Error(`no tool ${name}`)
  return d
}

t.section('§2 — Q3: stop on a workflows-allowed session is a TWO-STEP')
{
  const tagged = { w1: { runnerId: 'concourse-w1', sessionId: 'sess-tagged', workflowsAllowed: true as const } }
  // Operator fix 4: stop rides sessionControl action 'stop'
  // (the x law — row stays ◇ STOPPED, resumable), never sessionRelease.
  const { ctx, calls } = recordingCtx({ workers: tagged, replies: () => ({ ok: true, outcome: 'applied' }) })
  const stop = toolByName('stop_session')
  const first = await stop.run({ sessionId: 'sess-tagged' }, ctx)
  const firstOut = JSON.parse(first.content) as Record<string, unknown>
  t.check('the unconfirmed stop returns needsConfirmation:true', firstOut.needsConfirmation === true && firstOut.ok === false, first.content)
  t.check('…naming the tool and session (the UI relay shape)', firstOut.tool === 'stop_session' && firstOut.sessionId === 'sess-tagged')
  t.check('…and touches the daemon ZERO times', calls.length === 0, String(calls.length))
  t.check(
    '…with a visible noop receipt saying confirmation is needed',
    first.receipts?.length === 1 && first.receipts[0]?.outcome === 'noop' && String(first.receipts[0]?.detail).includes('confirmation'),
    JSON.stringify(first.receipts),
  )
  const second = await stop.run({ sessionId: 'sess-tagged', operatorConfirmed: true }, ctx)
  const secondOut = JSON.parse(second.content) as Record<string, unknown>
  t.check('operatorConfirmed:true stops through the REAL door', secondOut.ok === true && calls.length === 1, JSON.stringify(calls))
  t.check(
    '…the exact sessionControl stop op on the session identity (fix 4: the row STAYS)',
    calls[0]?.req.op === 'sessionControl' &&
      (calls[0]?.req as { action?: string }).action === 'stop' &&
      (calls[0]?.req as { sessionId?: string }).sessionId === 'sess-tagged',
    JSON.stringify(calls[0]?.req),
  )
  t.check('…and the receipt applied', second.receipts?.[0]?.verb === 'session.stop' && second.receipts[0]?.outcome === 'applied')

  const untagged = { w2: { runnerId: 'concourse-w2', sessionId: 'sess-plain' } }
  const plain = recordingCtx({ workers: untagged, replies: () => ({ ok: true, outcome: 'applied' }) })
  const plainStop = await stop.run({ sessionId: 'sess-plain' }, plain.ctx)
  t.check(
    'an untagged session stops without the two-step',
    (JSON.parse(plainStop.content) as Record<string, unknown>).ok === true && plain.calls.length === 1,
    plainStop.content,
  )
  const gone = await stop.run({ sessionId: 'sess-missing' }, plain.ctx)
  t.check('an unknown session refuses typed (no daemon call)', (JSON.parse(gone.content) as Record<string, unknown>).ok === false && plain.calls.length === 1)
}

t.section('§3 — launch mints durable idempotent identities; the tag grant rides AFTER success')
{
  const { ctx, calls } = recordingCtx({
    replies: req =>
      req.op === 'sessionDispatch'
        ? { ok: true, state: 'starting', sessionId: 'sess-9', runnerId: 'concourse-w9' }
        : { ok: true, outcome: 'applied', detail: 'grant-workflows concourse-w9' },
  })
  const launch = toolByName('launch_session')
  const first = await launch.run({ task: 'fix the parser', workflows: true, model: 'claude-fable-5' }, ctx)
  const firstOut = JSON.parse(first.content) as Record<string, unknown>
  t.check('the launch rode sessionDispatch', calls[0]?.req.op === 'sessionDispatch', JSON.stringify(calls[0]?.req))
  const mintedId = String(calls[0]?.req.clientMessageId ?? '')
  t.check('…with a minted non-empty clientMessageId', mintedId.length > 10, mintedId)
  t.check('…the coordinator seat stamped as by', calls[0]?.req.by === 'coordinator-seat')
  t.check('…the model choice riding the wire', calls[0]?.req.model === 'claude-fable-5')
  t.check('the result surfaces ok + sessionId + the id', firstOut.ok === true && firstOut.sessionId === 'sess-9' && firstOut.clientMessageId === mintedId, first.content)
  t.check(
    'the workflows grant rode sessionControl AFTER the successful launch',
    calls.length === 2 && calls[1]?.req.op === 'sessionControl' && calls[1]?.req.action === 'grant-workflows' && calls[1]?.req.sessionId === 'sess-9',
    JSON.stringify(calls[1]?.req),
  )
  t.check(
    'the launch receipt carries the minted id as its durable opId',
    first.receipts?.[0]?.verb === 'session.launch' && first.receipts[0]?.opId === mintedId,
    JSON.stringify(first.receipts),
  )
  t.check('…and a second receipt rows the grant', first.receipts?.[1]?.verb === 'workflows.grant' && first.receipts[1]?.outcome === 'applied')

  const second = await launch.run({ task: 'fix the parser', workflows: false }, ctx)
  const secondId = String(calls[2]?.req.clientMessageId ?? '')
  t.check('a second call mints a DIFFERENT identity (per-call op, replay-safe at the daemon)', secondId.length > 10 && secondId !== mintedId, `${mintedId} vs ${secondId}`)
  t.check('workflows:false grants nothing', calls.length === 3, String(calls.length))
  void second

  const refused = recordingCtx({ replies: () => ({ ok: false, error: 'no seat frees', state: 'queued' }) })
  const held = await launch.run({ task: 'docs pass', workflows: true }, refused.ctx)
  const heldOut = JSON.parse(held.content) as Record<string, unknown>
  t.check('a refused launch NEVER grants (no second daemon call)', refused.calls.length === 1, String(refused.calls.length))
  t.check('…and relays the refusal typed', heldOut.ok === false && String(heldOut.error).includes('no seat frees'), held.content)
  // Without a typed hold (no heldReason) the not-ok arm stays a refusal —
  // the held-open receipt below never leaks into plain refusals.
  t.check('…and with NO heldReason the receipt outcome stays refused', held.receipts?.[0]?.outcome === 'refused', JSON.stringify(held.receipts))

  // THE HELD-OPEN LAUNCH (live World-B sighting, seat ceiling reached): the
  // daemon answers ok:false + state 'queued' + a typed heldReason — the
  // ledger row is DURABLE and the session starts when a seat frees. The
  // receipt must say QUEUED, never 'refused' (an operator told "refused"
  // watches a session start later — the receipt lied).
  const seatHeld = recordingCtx({
    replies: () => ({
      ok: false,
      error: 'every seat is taken — this machine’s reading: 2 seats (cores/memory)',
      state: 'queued',
      heldReason: 'seat',
      moves: [
        { verb: 'queue', label: 'it queues and starts when a seat frees' },
        { verb: 'pause-holder', label: 'or stop a running session to free one' },
      ],
    }),
  })
  const heldOpen = await launch.run({ task: 'docs pass' }, seatHeld.ctx)
  const heldOpenOut = JSON.parse(heldOpen.content) as Record<string, unknown>
  t.check(
    'a seat-held launch receipts outcome QUEUED (held-open, not refused)',
    heldOpen.receipts?.[0]?.outcome === 'queued',
    JSON.stringify(heldOpen.receipts),
  )
  t.check(
    '…its detail carries the daemon reason and the starts-when words',
    String(heldOpen.receipts?.[0]?.detail ?? '').startsWith('"docs pass"') &&
      String(heldOpen.receipts?.[0]?.detail ?? '').includes('every seat is taken') &&
      String(heldOpen.receipts?.[0]?.detail ?? '').includes('starts when a seat frees'),
    JSON.stringify(heldOpen.receipts),
  )
  t.check(
    '…and the conversation row reads as a queue, never a refusal',
    lane.receiptLabelOf(heldOpen.receipts![0]! as never).startsWith('launch: queued — "docs pass"'),
    lane.receiptLabelOf(heldOpen.receipts![0]! as never),
  )
  t.check('…the model-facing body says held state queued', heldOpenOut.state === 'queued' && heldOpenOut.queued === true, heldOpen.content)
}

t.section('§3b — a CONTRACTED launch rides the manager road: born blank → contract set → the first turn (never admit-and-deliver)')
{
  // The dispatch door admits AND delivers at admit, so set_contract behind a
  // plain launch always lands after the first frame. With `contract` on the
  // call the three landed doors run in the only lawful order.
  const launch = toolByName('launch_session')
  type Op = { op?: string; action?: string; sessionId?: string; targetSessionId?: string; prompt?: string; bornBlank?: boolean; contract?: { op?: string; text?: string }; by?: string; workspaceDir?: string; clientMessageId?: string; model?: string; title?: string }
  const { ctx, calls } = recordingCtx({
    replies: req =>
      req.op === 'sessionAdmit'
        ? { ok: true, sessionId: 'sess-c1', runnerId: 'concourse-w11', workspaceId: root, modelId: 'claude-sonnet-5', modelDisplayName: 'Sonnet 5', branchName: 'mercury/parser', mainHolderTitle: 'main line' }
        : req.op === 'sessionDispatch'
          ? { ok: true, state: 'working', sessionId: 'sess-c1', runnerId: 'concourse-w11', stateRevision: 2 }
          : { ok: true, outcome: 'applied' },
  })
  const agreement = 'scope: the parser only · deliverable: the parser suite green · territory: src/parser'
  const out = await launch.run({ task: 'fix the parser', title: 'parser', model: 'claude-sonnet-5', contract: agreement, workflows: true }, ctx)
  const json = JSON.parse(out.content) as Record<string, unknown>
  const ops = calls.map(c => c.req as Op)
  t.check(
    'door 1: the BIRTH door — sessionAdmit with bornBlank, the title/model riding, NO words (no prompt on the admit)',
    ops[0]?.op === 'sessionAdmit' && ops[0]?.bornBlank === true && ops[0]?.prompt === undefined && ops[0]?.workspaceDir === root && ops[0]?.title === 'parser' && ops[0]?.model === 'claude-sonnet-5',
    JSON.stringify(ops[0]),
  )
  t.check(
    'door 2: the landed contract verb on the born session, seat-stamped, op set with the agreement’s exact words',
    ops[1]?.op === 'sessionControl' && ops[1]?.action === 'contract' && ops[1]?.sessionId === 'sess-c1' && ops[1]?.contract?.op === 'set' && ops[1]?.contract?.text === agreement && ops[1]?.by === 'coordinator-seat',
    JSON.stringify(ops[1]),
  )
  t.check(
    'door 3: the first turn through the redirect leg of the one dispatch door — targetSessionId, the task as the prompt, a minted id',
    ops[2]?.op === 'sessionDispatch' && ops[2]?.targetSessionId === 'sess-c1' && ops[2]?.prompt === 'fix the parser' && String(ops[2]?.clientMessageId ?? '').startsWith('coord-launch-') && ops[2]?.by === 'coordinator-seat',
    JSON.stringify(ops[2]),
  )
  // The manager prover's own poison, applied to this road: a delivered first
  // frame with no contract on the record = any sessionDispatch carrying a
  // prompt WITHOUT targetSessionId, or a delivery its contract set does not
  // precede on that very session.
  const dispatches = ops.filter(o => o.op === 'sessionDispatch')
  t.check('POISON: no sessionDispatch in the stream rides the admit-and-deliver form (every one carries targetSessionId)', dispatches.length === 1 && dispatches.every(o => typeof o.targetSessionId === 'string' && o.targetSessionId.length > 0))
  t.check(
    'POISON: the contract set PRECEDES the delivery on that very session',
    ops.every((o, i) => o.op !== 'sessionDispatch' || ops.slice(0, i).some(p => p.action === 'contract' && p.contract?.op === 'set' && p.sessionId === o.targetSessionId)),
  )
  t.check('the workflows grant rides AFTER the delivered first turn (fourth and last call)', calls.length === 4 && ops[3]?.op === 'sessionControl' && ops[3]?.action === 'grant-workflows' && ops[3]?.sessionId === 'sess-c1', JSON.stringify(ops[3]))
  t.check(
    'the result names the session, the road, the contract as set, and the model + fork FROM THE BIRTH ANSWER (the half-row: a birth receipt names its fork and model)',
    json.ok === true && json.sessionId === 'sess-c1' && json.state === 'working' && (json.contract as { set?: boolean }).set === true && json.modelName === 'Sonnet 5' && json.model === 'claude-sonnet-5' && json.branchName === 'mercury/parser' && json.mainHolderTitle === 'main line' && json.clientMessageId === ops[2]?.clientMessageId,
    out.content,
  )
  t.check(
    'receipts: contract.set applied, then session.launch applied on the session with the minted opId naming the road and the model, then the grant',
    out.receipts?.length === 3 &&
      out.receipts[0]?.verb === 'contract.set' && out.receipts[0]?.outcome === 'applied' && out.receipts[0]?.objectRef === 'sess-c1' &&
      out.receipts[1]?.verb === 'session.launch' && out.receipts[1]?.outcome === 'applied' && out.receipts[1]?.objectRef === 'sess-c1' && out.receipts[1]?.opId === ops[2]?.clientMessageId &&
      String(out.receipts[1]?.detail).includes('on Sonnet 5') && String(out.receipts[1]?.detail).includes('contract set, first turn delivered under it') && String(out.receipts[1]?.detail).includes('forked onto mercury/parser') &&
      out.receipts[2]?.verb === 'workflows.grant',
    JSON.stringify(out.receipts),
  )

  // No seat: the birth door refuses past the machine's reading — a TYPED
  // refusal naming the two moves, never a queue (a queued reservation would
  // deliver its first frame from the pump with nothing on the record).
  const full = recordingCtx({ replies: req => (req.op === 'sessionAdmit' ? { ok: false, code: 'EUNKNOWN', error: 'runtime ceiling reached (4 of 4 seats live)', refusal: 'runtime-ceiling' } : { ok: true, outcome: 'applied' }) })
  const held = tools.finishToolResult('launch_session', await launch.run({ task: 'docs pass', contract: 'scope: docs', workflows: true }, full.ctx))
  const heldJson = JSON.parse(held.content) as Record<string, unknown>
  t.check(
    'no seat ⇒ a typed refusal that never queues, naming the two moves (wait for a seat / launch without `contract` then set_contract), with ONE daemon call and no grant',
    held.isError === true && heldJson.ok === false && heldJson.noSeat === true && String(heldJson.refused).includes('never queues') && String(heldJson.next).includes('without `contract`') && String(heldJson.next).includes('set_contract') && full.calls.length === 1,
    held.content,
  )
  t.check('…and the refused launch receipt carries the minted opId + the reason', held.receipts?.[0]?.verb === 'session.launch' && held.receipts[0]?.outcome === 'refused' && String(held.receipts[0]?.opId).startsWith('coord-launch-') && String(held.receipts[0]?.detail).includes('never queues'), JSON.stringify(held.receipts))

  // A refused set never un-births (the offer card's law): the first turn
  // still delivers and the receipts name the miss + the retry verb.
  const setRefused = recordingCtx({
    replies: req =>
      req.op === 'sessionAdmit'
        ? { ok: true, sessionId: 'sess-c2', runnerId: 'concourse-w12', workspaceId: root }
        : req.op === 'sessionControl' && req.action === 'contract'
          ? { ok: false, code: 'EUNKNOWN', error: 'contract refused: no record for sess-c2' }
          : { ok: true, state: 'working', sessionId: 'sess-c2', runnerId: 'concourse-w12', stateRevision: 2 },
  })
  const missed = await launch.run({ task: 'index the docs', contract: 'scope: docs' }, setRefused.ctx)
  const missedJson = JSON.parse(missed.content) as Record<string, unknown>
  t.check(
    'a refused contract set never un-births: the first turn still delivers (3 calls, the dispatch last) and the result says the contract did not set + the retry verb',
    setRefused.calls.length === 3 && (setRefused.calls[2]?.req as Op).op === 'sessionDispatch' && (setRefused.calls[2]?.req as Op).targetSessionId === 'sess-c2' && missedJson.ok === true && (missedJson.contract as { set?: boolean; next?: string }).set === false && String((missedJson.contract as { next?: string }).next).includes('set_contract'),
    missed.content,
  )
  t.check(
    '…the contract.set receipt is refused with the daemon’s words and the launch receipt says the contract did NOT set',
    missed.receipts?.[0]?.verb === 'contract.set' && missed.receipts[0]?.outcome === 'refused' && String(missed.receipts[0]?.detail).includes('no record for sess-c2') && String(missed.receipts[0]?.detail).includes('set_contract') &&
      missed.receipts[1]?.verb === 'session.launch' && missed.receipts[1]?.outcome === 'applied' && String(missed.receipts[1]?.detail).includes('did NOT set'),
    JSON.stringify(missed.receipts),
  )

  // Transport loss on the first turn is 'failed', never a refusal — the
  // minted id replays through the idempotent door.
  const lostTurn = recordingCtx({
    replies: req =>
      req.op === 'sessionAdmit'
        ? { ok: true, sessionId: 'sess-c3', runnerId: 'concourse-w13', workspaceId: root }
        : req.op === 'sessionDispatch'
          ? { ok: false, code: 'ETIMEOUT', error: 'timed out' }
          : { ok: true, outcome: 'applied' },
  })
  const lost = tools.finishToolResult('launch_session', await launch.run({ task: 'x', contract: 'c', workflows: true }, lostTurn.ctx))
  t.check('a lost first turn reads FAILED with a retry-shaped next (never a refusal), and no grant follows', lost.isError === true && lost.receipts?.[1]?.verb === 'session.launch' && lost.receipts[1]?.outcome === 'failed' && String(JSON.parse(lost.content).next).includes('retry') && lostTurn.calls.length === 3, lost.content)

  // Without `contract` the landed road stands, byte-unchanged.
  const plain = recordingCtx({ replies: () => ({ ok: true, state: 'starting', sessionId: 'sess-p', runnerId: 'concourse-w14' }) })
  await launch.run({ task: 'plain launch' }, plain.ctx)
  const plainOp = plain.calls[0]?.req as Op
  t.check('without `contract` the launch is ONE sessionDispatch through the admit-and-deliver door — no birth door, no contract verb', plain.calls.length === 1 && plainOp.op === 'sessionDispatch' && plainOp.targetSessionId === undefined && plainOp.prompt === 'plain launch', JSON.stringify(plainOp))
  const blank = recordingCtx({ replies: () => ({ ok: true, state: 'starting', sessionId: 'sess-p2', runnerId: 'concourse-w15' }) })
  await launch.run({ task: 'blank contract', contract: '   ' }, blank.ctx)
  t.check('a blank `contract` is no contract — the plain road', blank.calls.length === 1 && (blank.calls[0]?.req as Op).op === 'sessionDispatch' && (blank.calls[0]?.req as Op).targetSessionId === undefined)
  const desc = launch.description
  t.check('the description teaches the contracted road (born blank → contract set → first turn) and that a contracted launch refuses at the seat limit instead of queueing', desc.includes('born blank') && desc.includes('refuses instead of queueing') && desc.includes('set_contract'))
  t.check('the schema admits `contract` as an optional string', (launch.inputJSONSchema as { properties?: Record<string, { type?: string }> }).properties?.contract?.type === 'string' && !((launch.inputJSONSchema as { required?: string[] }).required ?? []).includes('contract'))

  // THE HALF-ROW (source pin): the control server's sessionAdmit answer names
  // the carved fork and the model the way the dispatch door's answer does —
  // a birth-door launch receipt could name neither before.
  const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'controlServer.ts'), 'utf8')
  const admitAt = server.indexOf("case 'sessionAdmit': {")
  const admitBody = server.slice(admitAt, server.indexOf("case 'concourseWithdraw'", admitAt))
  t.check(
    'controlServer’s sessionAdmit answer carries branchName · mainHolderTitle · modelId · modelDisplayName from the admit result (the dispatch door’s four receipt facts)',
    admitAt !== -1 &&
      ['branchName', 'mainHolderTitle', 'modelId', 'modelDisplayName'].every(f => admitBody.includes(`...(r.${f} !== undefined ? { ${f}: r.${f} } : {})`)),
  )
  t.check('…and the manager’s own road reads the same three doors (one law, two callers)', readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'concourse', 'managerMode.ts'), 'utf8').includes('bornBlank: true') && readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'concourse', 'coordinatorTools.ts'), 'utf8').includes("op: 'sessionAdmit',\n        workspaceDir: args.workspaceDir,\n        bornBlank: true,"))
}

t.section('§4 — the verb tools ride the exact daemon doors, seat-stamped')
{
  const { ctx, calls } = recordingCtx({ replies: () => ({ ok: true, state: 'working', outcome: 'applied' }) })
  const msg = await toolByName('message_session').run({ sessionId: 'sess-3', text: 'ship the docs half too' }, ctx)
  t.check(
    'message_session = sessionDispatch with targetSessionId (the ONE delivery door)',
    calls[0]?.req.op === 'sessionDispatch' && calls[0]?.req.targetSessionId === 'sess-3' && calls[0]?.req.by === 'coordinator-seat',
    JSON.stringify(calls[0]?.req),
  )
  t.check('…receipt verb session.redirect, feed-eligible, opId minted', msg.receipts?.[0]?.verb === 'session.redirect' && msg.receipts[0]?.feedEligible === true && typeof msg.receipts[0]?.opId === 'string')
  await toolByName('pause_session').run({ sessionId: 'sess-3', reason: 'clobber risk' }, ctx)
  t.check(
    'pause_session = sessionControl pause with a minted clientOpId',
    calls[1]?.req.op === 'sessionControl' && calls[1]?.req.action === 'pause' && String(calls[1]?.req.clientOpId ?? '').length > 10,
    JSON.stringify(calls[1]?.req),
  )
  await toolByName('resume_session').run({ sessionId: 'sess-3' }, ctx)
  t.check('resume_session = sessionControl resume', calls[2]?.req.action === 'resume')
  await toolByName('answer_permission').run({ sessionId: 'sess-3', requestId: 'ask-7', allow: true }, ctx)
  t.check(
    'answer_permission = sessionControl answer-permission carrying requestId + allow',
    calls[3]?.req.action === 'answer-permission' && calls[3]?.req.requestId === 'ask-7' && calls[3]?.req.allow === true,
    JSON.stringify(calls[3]?.req),
  )
  await toolByName('revoke_workflows').run({ sessionId: 'sess-3' }, ctx)
  t.check('revoke_workflows = sessionControl revoke-workflows', calls[4]?.req.action === 'revoke-workflows')
}

t.section('§5 — the persona: two names, plain words, one home')
{
  const text = persona.COORDINATOR_PERSONA
  t.check('no "agent" anywhere (the two-name law)', !/\bagents?\b/i.test(text) && !/agent/i.test(text))
  t.check('no "admission"', !/admission/i.test(text))
  t.check('no "dispatch"', !/dispatch/i.test(text))
  t.check('no "unattached"', !/unattached/i.test(text))
  for (const required of ['coordinator', 'Mercury', 'seat', 'queue', 'workflows', 'operatorConfirmed', 'receipt']) {
    t.check(`speaks "${required}"`, text.includes(required))
  }
  t.check('stays brief (judgment over rules — ≤48 lines)', text.split('\n').length <= 48, String(text.split('\n').length))
  t.check('the lane contract IS the persona (one home)', lane.COORDINATOR_CONTRACT === text)
  t.check('the contract lineage advanced (v6+: the awareness pass)', lane.COORDINATOR_CONTRACT_VERSION === persona.COORDINATOR_PERSONA_VERSION && lane.COORDINATOR_CONTRACT_VERSION >= 6)
  t.check('the receipt digest binds the persona revision', lane.coordinatorContractDigest() === `cc${persona.COORDINATOR_PERSONA_VERSION}-${text.length}`)
  // The seat's prompt as coordinatorCall composes it: the coordinator floor
  // ahead of the persona — ONE identity statement, the attribution behind it,
  // the session statement absent.
  const contract = await import('../../src/prompt/mercuryContract.ts')
  const composed = [contract.MERCURY_COORDINATOR_FLOOR, lane.COORDINATOR_CONTRACT].join('\n')
  t.check('the composed seat prompt carries exactly ONE identity statement (the coordinator floor line)', (composed.match(/^You are /gm) ?? []).length === 1 && composed.startsWith(contract.MERCURY_COORDINATOR_IDENTITY))
  t.check('…with the attribution line behind it and the session statement absent', composed.includes(contract.MERCURY_ATTRIBUTION) && !composed.includes('You are **Mercury**'))
  t.check('the persona opens on the seat, not on a second identity', text.startsWith('Your seat is the Mercury switchboard'))
  // v6 (the awareness pass): the board block is the model's knowledge, a
  // with-you session is alive, executed receipts are never re-asked, and a
  // consolidation brief carries its sources.
  const flat = text.replace(/\s+/g, ' ')
  t.check('names the <switchboard> block as its knowledge', flat.includes('<switchboard> block') && flat.includes('your knowledge'))
  t.check('binds with-you = alive and live', flat.includes('a session with you is alive and counts as live'))
  t.check('forbids re-asking about executed receipts', flat.includes('never re-ask about what the receipts show you did'))
  t.check('names sources for consolidation briefs', flat.includes('pass them as sources'))
}

t.section('§6 — the caps + the operator-ruled tool roster')
{
  t.check('≤8 tool calls per turn', call.COORDINATOR_TURN_MAX_TOOL_CALLS === 8)
  t.check('≤8192 output tokens per turn', call.COORDINATOR_TURN_MAX_OUTPUT_TOKENS === 8192)
  t.check('120s wall clock', call.COORDINATOR_TURN_WALL_MS === 120_000)
  const ruled = [
    'list_sessions',
    'launch_session',
    'message_session',
    'pause_session',
    'resume_session',
    'stop_session',
    'grant_workflows',
    'revoke_workflows',
    // The landed contract verb (coordinator-tooling T2 — the manager road
    // and the contracted launch both ride it): the ruled set grew to
    // THIRTEEN when it landed; this roster is the closed list.
    'set_contract',
    'answer_permission',
    'read_file',
    'grep',
    'list_dir',
  ]
  const names = defs.map(d => d.name)
  t.check('the tool set is EXACTLY the ruled roster (the twelve plus the landed contract verb — thirteen, closed)', names.length === ruled.length && ruled.every(n => names.includes(n)), names.join(', '))
  t.check(
    'every declaration is a typed object schema',
    defs.every(d => (d.inputJSONSchema as { type?: string }).type === 'object'),
  )
  const decls = tools.toolApiDeclarations(defs)
  const prompts = await Promise.all(decls.map(d => d.prompt()))
  t.check(
    'the API projection carries name · prompt() · inputJSONSchema',
    decls.every((d, i) => d.name === defs[i]!.name && d.inputJSONSchema === defs[i]!.inputJSONSchema) && prompts.every((p, i) => p === defs[i]!.description),
  )
  t.check(
    'stop_session declares the operatorConfirmed two-step input',
    Object.keys((toolByName('stop_session').inputJSONSchema as { properties?: Record<string, unknown> }).properties ?? {}).includes('operatorConfirmed'),
  )
}

t.section('§7 — IP-5 lane wiring: deltas stream a PARTIAL entry; the final reply replaces it; tool receipts merge attributed')
{
  const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
  enableConfigs()
  const modelId = 'claude-sonnet-5'
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: modelId } }))
  lane._resetCoordinatorLaneForTesting()
  const crewDir = join(scratch, 'crew-hooks')
  mkdirSync(crewDir, { recursive: true })
  const conv = await import('../../src/services/concourse/coordinatorConversation.ts')

  let seatSeen = ''
  let partialDuringTurn: { text: string; receipts: number } | null = null
  const finalReply = 'Launched one session on orchard; its receipt row is below.'
  const result = await lane.runOperatorMessageTurn(
    'launch one on orchard',
    {
      crewDir,
      callModel: async (_input, _model, runtime) => {
        seatSeen = runtime?.by ?? ''
        runtime?.onDelta?.('Launching')
        runtime?.onReceipt?.({
          verb: 'session.launch',
          objectRef: 'sess-77',
          outcome: 'applied',
          detail: 'orchard parser (starting)',
          opId: 'coord-launch-fixed',
        })
        runtime?.onDelta?.('Launching one session on orchard — almost done.')
        // Let the 120ms throttle flush, then OBSERVE the partial entry the
        // way a subscriber would — mid-turn, before the final append.
        await new Promise(r => setTimeout(r, 200))
        const midTurn = (await conv.readCoordinatorConversation()).find(e => e.id === 'co:w3-hook-msg')
        if (midTurn !== undefined) partialDuringTurn = { text: midTurn.text, receipts: midTurn.receipts?.length ?? 0 }
        return { decisions: [], reply: finalReply }
      },
    },
    { clientMessageId: 'w3-hook-msg' },
  )
  const receipt = 'outcome' in result ? result : null
  t.check('the assisted turn executed', receipt?.outcome === 'executed', JSON.stringify(receipt))
  t.check(
    'the runtime carried the RESOLVED coordinator seat into the tools',
    seatSeen.length > 0 && seatSeen !== 'coordinator-unresolved' && seatSeen !== 'coordinator',
    seatSeen,
  )
  t.check(
    'the PARTIAL entry was live mid-turn (streamed text + the settled receipt row)',
    partialDuringTurn !== null &&
      (partialDuringTurn as { text: string; receipts: number }).text.startsWith('Launching') &&
      (partialDuringTurn as { text: string; receipts: number }).receipts === 1,
    JSON.stringify(partialDuringTurn),
  )
  const entries = await conv.readCoordinatorConversation()
  const finals = entries.filter(e => e.id === 'co:w3-hook-msg')
  t.check('exactly ONE final entry (the partial was REPLACED in place, never duplicated)', finals.length === 1)
  t.check('…holding the final reply text', finals[0]?.text === finalReply, finals[0]?.text)
  t.check(
    '…with the tool receipt rowed on the entry',
    finals[0]?.receipts?.some(r => r.verb === 'session.launch' && r.outcome === 'applied') === true,
    JSON.stringify(finals[0]?.receipts),
  )
  const opIdx = entries.findIndex(e => e.id === 'op:w3-hook-msg')
  const coIdx = entries.findIndex(e => e.id === 'co:w3-hook-msg')
  t.check('the operator entry precedes the reply (no filter-replace reorder)', opIdx >= 0 && coIdx > opIdx, `${opIdx} < ${coIdx}`)
  t.check(
    'the turn receipt carries the tool receipt STAMPED with the acting seat',
    receipt?.receipts.some(r => r.verb === ('session.launch' as never) && r.actorAgentId === seatSeen && r.opId === 'coord-launch-fixed') === true,
    JSON.stringify(receipt?.receipts),
  )
}

t.section('§7b — the reply clip is VISIBLE (the silent-downgrade class): over the cap, the marker replaces the tail')
{
  const lane2 = await import('../../src/services/concourse/coordinatorLane.ts')
  const conv = await import('../../src/services/concourse/coordinatorConversation.ts')
  lane2._resetCoordinatorLaneForTesting()
  const longReply = `the whole story: ${'x'.repeat(9_000)}`
  const result = await lane2.runOperatorMessageTurn(
    'tell me everything',
    {
      callModel: async () => ({ decisions: [], reply: longReply }),
    },
    { clientMessageId: 'w3-clip-msg' },
  )
  const receipt = 'outcome' in result ? result : null
  t.check('the long-reply turn executed', receipt?.outcome === 'executed', JSON.stringify(receipt).slice(0, 160))
  const entry = (await conv.readCoordinatorConversation()).find(e => e.id === 'co:w3-clip-msg')
  t.check('the stored reply sits at the ONE cap (the store’s own ceiling)', entry !== undefined && entry.text.length <= lane2.COORDINATOR_REPLY_CAP, String(entry?.text.length))
  t.check('…and the cut is VISIBLE — the clip marker closes the entry', entry?.text.endsWith('the receipt rows are complete]') === true, entry?.text.slice(-90))
  const short = lane2.clipCoordinatorReply('a short reply')
  t.check('an under-cap reply rides whole, marker-free', short === 'a short reply', short)
}

// ── the awareness pass: the board block, the normalizer, sources ─

t.section('§8 — the board view is the model’s whole world: every row, its state in plain words, with-you counted live')
{
  const { updateConcourseWorkers, recordCollisionEvidence } = await import('../../src/daemon/concourseSupervisor.ts')
  const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
  const board = await import('../../src/services/concourse/coordinatorBoard.ts')
  const recDir = join(scratch, 'records-board')
  mkdirSync(recDir, { recursive: true })
  const workspace = join(scratch, 'ws-board')
  mkdirSync(workspace, { recursive: true })
  const sidWithYou = '550e8400-e29b-41d4-a716-446655440101'
  const sidWorking = '550e8400-e29b-41d4-a716-446655440102'
  const sidPaused = '550e8400-e29b-41d4-a716-446655440103'
  const sidEnded = '550e8400-e29b-41d4-a716-446655440104'
  updateConcourseWorkers(ws => {
    ws['concourse-w1'] = {
      schema: 1, runnerId: 'concourse-w1', sessionId: sidWithYou, workspaceId: workspace, title: 'fix the parser',
      isolation: 'exclusive', modelKey: 'claude-fable-5', effort: 'high', spawnedAt: Date.now() - 600_000, lastLiveAt: Date.now(),
      attachedAt: Date.now() - 60_000, attachedBy: 'operator',
    }
    ws['concourse-w2'] = {
      schema: 1, runnerId: 'concourse-w2', sessionId: sidWorking, workspaceId: workspace, title: 'docs pass',
      isolation: 'worktree-isolated', modelKey: 'claude-opus-4-8', effort: 'medium', spawnedAt: Date.now() - 300_000, lastLiveAt: Date.now(),
      pid: process.pid, lastDeliveryAt: Date.now() - 20_000, lastTurnSettledAt: Date.now() - 40_000,
      branchName: 'mercury/docs-pass', worktreePath: join(scratch, 'wt-docs-pass'),
    }
    ws['concourse-w3'] = {
      schema: 1, runnerId: 'concourse-w3', sessionId: sidPaused, workspaceId: workspace, title: 'quiet one',
      isolation: 'exclusive', modelKey: 'claude-fable-5', spawnedAt: Date.now() - 100_000, lastLiveAt: Date.now(),
      pid: process.pid, pausedAt: Date.now() - 5_000, pausedBy: 'operator',
    }
    ws['concourse-w4'] = {
      schema: 1, runnerId: 'concourse-w4', sessionId: sidEnded, workspaceId: workspace, title: 'old fork',
      isolation: 'worktree-isolated', modelKey: 'claude-fable-5', spawnedAt: Date.now() - 900_000, lastLiveAt: Date.now() - 800_000,
      endedAt: Date.now() - 700_000, branchName: 'mercury/old-fork', worktreePath: join(scratch, 'wt-old-fork'),
    }
  }, recDir)
  recordCollisionEvidence(
    { schema: 1, kind: 'authored-work-retained', workspaceId: workspace, holders: [{ runnerId: 'concourse-w4', sessionId: sidEnded }], observedAt: Date.now() - 600_000, branchName: 'mercury/old-fork' },
    recDir,
  )
  // A vNext transcript for the working session — the default written format:
  // record envelopes (actor.role / payload.kind), never a top-level `type`.
  const transcript = workerTranscriptPath({ sessionId: sidWorking, workspaceId: workspace })
  mkdirSync(join(transcript, '..'), { recursive: true })
  const stamp = new Date(Date.now() - 90_000).toISOString()
  writeFileSync(
    transcript,
    [
      JSON.stringify({ schemaVersion: 1, recordId: 'r1', sessionId: sidWorking, threadId: 'main', creationOrdinal: '1', updateOrdinal: '1', occurredAt: stamp, actor: { role: 'user' }, source: { channel: 'sdk' }, payload: { kind: 'input', content: 'Rewrite the docs index so every page speaks the current tree.' } }),
      JSON.stringify({ schemaVersion: 1, recordId: 'r2', sessionId: sidWorking, threadId: 'main', creationOrdinal: '2', updateOrdinal: '2', occurredAt: stamp, actor: { role: 'assistant', model: 'claude-opus-4-8' }, source: { channel: 'sdk' }, payload: { kind: 'output', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'bun run typecheck', description: 'typecheck the tree' } }], usage: { input_tokens: 1, output_tokens: 1 }, outcome: { kind: 'tool-use' } }, annotations: { timestamp: stamp } }),
      '',
    ].join('\n'),
  )
  const view = await board.coordinatorBoardView({ recordsDir: recDir, ground: workspace })
  const byId = new Map(view.sessions.map(s => [s.sessionId, s]))
  t.check('every live row is present (with-you · working · paused) plus the finished fork', ['w', sidWithYou, sidWorking, sidPaused, sidEnded].slice(1).every(id => byId.has(id)), view.sessions.map(s => `${s.title}:${s.state}`).join(', '))
  const withYou = byId.get(sidWithYou)
  t.check('the with-you row says so in plain words (alive, in the terminal)', withYou?.state === 'attached' && /with you in the terminal, alive/.test(withYou.means), withYou?.means)
  t.check('with-you COUNTS as live (the "1 live" over three was two with-you rows uncounted)', view.counts.withYou === 1 && Number(view.counts.live) >= 3, JSON.stringify(view.counts))
  const working = byId.get(sidWorking)
  t.check('the working row carries model + effort + folder', working?.model === 'claude-opus-4-8' && working.effort === 'medium' && working.project === workspace, JSON.stringify(working))
  t.check('…its brief (why it runs) from the vNext transcript head', working?.brief?.includes('Rewrite the docs index') === true, working?.brief)
  t.check('…its latest activity (what it does now) from the vNext transcript tail, with how long ago', working?.now?.startsWith('Bash') === true && typeof working.lastSpokeAgo === 'string', `${working?.now} / ${working?.lastSpokeAgo}`)
  t.check('…its stamp branch + worktree path + commit state', working?.branch === 'mercury/docs-pass' && working.worktree === join(scratch, 'wt-docs-pass') && typeof working.commits === 'string', JSON.stringify({ b: working?.branch, w: working?.worktree, c: working?.commits }))
  const paused = byId.get(sidPaused)
  t.check('the paused row names who paused it, in the operator’s words (operator → "you")', paused?.state === 'paused' && paused.pausedBy === 'you' && /paused by you/.test(paused.means), paused?.means)
  const fork = view.finishedForks?.find(f => f.branch === 'mercury/old-fork')
  t.check('a finished fork rides finishedForks with its worktree (from the settled record) and commit state', fork !== undefined && fork.worktree === join(scratch, 'wt-old-fork') && typeof fork.commits === 'string', JSON.stringify(view.finishedForks))
  t.check('the ground names the repo the coordinator sits on', view.ground === workspace)
  // The lane hands this SAME view to the model (deps.board is only the proof seam).
  const snap = await import('../../src/services/concourse/concourseSnapshot.ts')
  t.check('tailActivityLabel projects vNext records (the NOW cell was blank for every new session before)', snap.tailActivityLabel({ sessionId: sidWorking, workspaceId: workspace })?.startsWith('Bash') === true)
}

t.section('§9 — the post-tool normalizer: refusals reach the model as full sentences with the next move, flagged is_error')
{
  const withYouWhy = 'this session is with you in the terminal — say it there, or leave it and this message delivers on its own'
  const { ctx } = recordingCtx({
    workers: { w1: { runnerId: 'concourse-w1', sessionId: 'sess-wy' } },
    replies: req =>
      req.op === 'sessionDispatch'
        ? { ok: false, state: 'queued', heldReason: 'session-with-you', error: withYouWhy, moves: [{ verb: 'queue', label: 'it delivers on its own after you leave the session' }] }
        : { ok: true, outcome: 'applied' },
  })
  const raw = await toolByName('message_session').run({ sessionId: 'sess-wy', text: 'ship the docs half too' }, ctx)
  const finished = tools.finishToolResult('message_session', raw)
  const out = JSON.parse(finished.content) as Record<string, unknown>
  t.check('the refused result is flagged is_error (no runtime reads it as success)', finished.isError === true)
  t.check('…carries the daemon’s FULL sentence, uncut', out.error === withYouWhy, String(out.error))
  t.check('…and the next move from the daemon’s typed moves', String(out.next).includes('delivers on its own after you leave'), String(out.next))
  t.check('…and the typed hold (held, not delivered)', out.held === true && out.heldReason === 'session-with-you')
  const receipt = finished.receipts?.[0]
  t.check('the receipt row detail is the same sentence + next (never a clipped stub)', receipt?.outcome === 'refused' && String(receipt.detail).includes(withYouWhy) && String(receipt.detail).includes('next:'), receipt?.detail)
  t.check('…longer than any 48-char stub', String(receipt?.detail).length > 48)
  // The label the operator reads leads with a verb + title, never the uuid.
  const label = lane.receiptLabelOf({ verb: 'session.redirect', objectRef: '3f2a9c1e-1111-2222-3333-444444444444', outcome: 'refused', detail: String(receipt?.detail) }, () => 'fix the parser')
  t.check('the conversation label leads with the verb + TITLE and keeps the whole reason (the refusal arm drops the colon — the ruled-screenshot polish)', label.startsWith('message to "fix the parser" refused — this session is with you') && !label.includes('3f2a9c1e'), label)
  const untitled = lane.receiptLabelOf({ verb: 'session.redirect', objectRef: '3f2a9c1e-1111-2222-3333-444444444444', outcome: 'applied', detail: 'delivered (working)' })
  t.check('an untitled row shortens the uuid instead of leading with 36 chars of it', untitled.startsWith('message to session 3f2a9c1e: applied'), untitled)
  // A daemon error can arrive MULTI-LINE (the live fork-collision sighting:
  // raw git stderr, "Preparing worktree…\nfatal: a branch named … exists").
  // A receipt row is ONE pane line — the compactor folds line breaks.
  const multiline = lane.compactRefusalWhy('git worktree add failed: Preparing worktree (new branch)\nfatal: a branch named mercury/x-2 already exists')
  t.check('a multi-line daemon error folds to one row line', !multiline.includes('\n') && multiline.includes('fatal: a branch named'), JSON.stringify(multiline))
  // Applied results and Q3's needs-confirmation are NOT errors.
  const okCtx = recordingCtx({ replies: () => ({ ok: true, state: 'working', outcome: 'applied' }) })
  const applied = tools.finishToolResult('message_session', await toolByName('message_session').run({ sessionId: 'sess-3', text: 'go' }, okCtx.ctx))
  t.check('an applied result is untouched and not an error', applied.isError === false && (JSON.parse(applied.content) as { ok: boolean }).ok === true)
  const tagged = recordingCtx({ workers: { w1: { runnerId: 'concourse-w1', sessionId: 'sess-tagged', workflowsAllowed: true as const } } })
  const ask = tools.finishToolResult('stop_session', await toolByName('stop_session').run({ sessionId: 'sess-tagged' }, tagged.ctx))
  t.check('needs-your-confirmation is a protocol result, never is_error', ask.isError === false && (JSON.parse(ask.content) as { needsConfirmation?: boolean }).needsConfirmation === true)
  // A bare refusal (no next) gains one when the receipt says transport loss.
  const lost = recordingCtx({ replies: () => ({ ok: false, code: 'ETIMEOUT' }) })
  const lostOut = tools.finishToolResult('pause_session', await toolByName('pause_session').run({ sessionId: 'sess-3' }, lost.ctx))
  const lostJson = JSON.parse(lostOut.content) as Record<string, unknown>
  t.check('transport loss reads as failed with a retry-shaped next', lostOut.isError === true && String(lostJson.next).includes('retry') && lostOut.receipts?.[0]?.outcome === 'failed', lostOut.content)
}

t.section('§10 — launch_session sources: a consolidation brief NAMES each branch, worktree and commit state from the board')
{
  const board = await import('../../src/services/concourse/coordinatorBoard.ts')
  const view: import('../../src/services/concourse/coordinatorBoard.ts').CoordinatorBoardV1 = {
    ground: root,
    counts: {},
    sessions: [
      { sessionId: 'sess-a', title: 'urban p1', state: 'ready-to-review', means: 'idle', project: '/repo/x', branch: 'mercury/urban-p1', worktree: '/wt/w3', commits: '2 commits ahead of main · uncommitted changes in 1 file' },
      { sessionId: 'sess-b', title: 'urban p2', state: 'working', means: 'working', project: '/repo/x', branch: 'mercury/urban-p2', worktree: '/wt/w4', commits: '1 commit ahead of main · working tree clean' },
      { sessionId: 'sess-c', title: 'main line', state: 'attached', means: 'with you', project: '/repo/x' },
    ],
    finishedForks: [{ title: 'old fork', branch: 'mercury/old-fork', project: '/repo/x', worktree: '/wt/w9', commits: '3 commits ahead of main · worktree not on disk' }],
    openObligations: [],
  }
  const resolved = board.resolveBoardSources(view, ['urban p1', 'mercury/urban-p2', 'old-fork', 'nothing like this'])
  t.check('titles, branch names and branch tails all resolve; the unknown one is named', resolved.named.length === 3 && resolved.unknown.length === 1 && resolved.unknown[0] === 'nothing like this', JSON.stringify(resolved))
  const block = board.sourcesBriefBlock(resolved.named)
  t.check('the brief block names every branch', ['mercury/urban-p1', 'mercury/urban-p2', 'mercury/old-fork'].every(b => block.includes(b)), block)
  t.check('…every worktree path', ['/wt/w3', '/wt/w4', '/wt/w9'].every(w => block.includes(w)))
  t.check('…and every commit state', block.includes('uncommitted changes in 1 file') && block.includes('working tree clean') && block.includes('worktree not on disk'))
  t.check('…and says the sessions are not in the new session’s chat', block.includes('not in your chat'))
  // Through the REAL tool: an unknown source refuses BEFORE any daemon call.
  const { ctx, calls } = recordingCtx({ replies: () => ({ ok: true, state: 'starting', sessionId: 'sess-new' }) })
  const refused = await toolByName('launch_session').run({ task: 'consolidate their work', sources: ['nothing like this'] }, ctx)
  const refusedOut = JSON.parse(refused.content) as Record<string, unknown>
  t.check('an unknown source refuses typed, naming what the board holds, with zero daemon calls', refusedOut.ok === false && String(refusedOut.refused).includes('nothing like this') && calls.length === 0, refused.content)
  const desc = toolByName('launch_session').description
  t.check('the launch description teaches sources for consolidate/merge asks and that a brief is all a session knows', desc.includes('sources') && /consolidate|merge/.test(desc) && desc.includes('knows nothing else'))
  t.check('list_sessions says when to re-read and that with-you counts as live', toolByName('list_sessions').description.includes('with-you sessions count as live'))
  t.check('message_session teaches held-not-delivered for a with-you target', toolByName('message_session').description.includes('never "delivered"'))
  t.check('answer_permission binds the git-offer yes to itself, never a relaunch', toolByName('answer_permission').description.includes('never a relaunch'))
  t.check('every description carries when-and-when-not (≥3 sentences)', defs.every(d => d.description.split(/[.;]\s/).length >= 3), defs.filter(d => d.description.split(/[.;]\s/).length < 3).map(d => d.name).join(','))
}

t.section('§11 — the fork commit-state words are one home (reap + board)')
{
  const wt = await import('../../src/daemon/concourseWorktrees.ts')
  t.check('ahead + dirty', wt.describeForkCommitState({ committedAhead: 2, dirt: { kind: 'authored', files: ['a', 'b', 'c'] } }) === '2 commits ahead of main · uncommitted changes in 3 files')
  t.check('nothing ahead + clean', wt.describeForkCommitState({ committedAhead: 0, dirt: { kind: 'clean' } }) === 'nothing committed ahead of main · working tree clean')
  t.check('unknown + gone', wt.describeForkCommitState({ committedAhead: null, dirt: null }) === 'commit count unknown · worktree not on disk')
  t.check('a non-repo answers unknown honestly (no throw)', wt.forkCommitState(join(scratch, 'not-a-repo'), 'mercury/x').committedAhead === null)
}

t.section('§12 — the next turn KNOWS its own receipts; a reply-less turn is named, never a board claim')
{
  const conv = await import('../../src/services/concourse/coordinatorConversation.ts')
  const crewDir = join(scratch, 'crew-hooks') // §7's store — its co:w3-hook-msg entry carries a receipt row
  let seenTail: NonNullable<import('../../src/services/concourse/coordinatorLane.ts').CoordinatorTurnInput['conversation']> = []
  let seenBoard: import('../../src/services/concourse/coordinatorLane.ts').CoordinatorTurnInput['board'] | null = null
  const second = await lane.runOperatorMessageTurn(
    'and the docs half?',
    {
      crewDir,
      callModel: async input => {
        seenTail = [...(input.conversation ?? [])]
        seenBoard = input.board
        return { decisions: [] } // no reply, no receipts — the reply-less turn
      },
    },
    { clientMessageId: 'w3-hook-msg-2' },
  )
  const priorEntry = seenTail.find(e => e.role === 'coordinator' && e.text.startsWith('Launched one session'))
  t.check('the prior coordinator entry rides the tail WITH its receipt rows', priorEntry?.receipts?.some(r => r.verb === 'session.launch' && r.label.includes('launch')) === true, JSON.stringify(priorEntry))
  t.check('the board rode the call as the coordinatorBoard projection (counts + sessions + openObligations, never transcripts)', seenBoard !== null && typeof (seenBoard as { counts: unknown }).counts === 'object' && Array.isArray((seenBoard as { sessions: unknown }).sessions), JSON.stringify(seenBoard).slice(0, 200))
  const entries = await conv.readCoordinatorConversation()
  const reply = entries.find(e => e.id === 'co:w3-hook-msg-2')
  t.check('a reply-less executed turn writes the honest harness line — never "nothing needed doing"', 'outcome' in second && second.outcome === 'executed' && reply?.text.includes('ended without a reply') === true && !reply.text.includes('board already reflects'), reply?.text)
}

t.finish('prove-coordinator-turn')
