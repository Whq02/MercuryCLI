import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'sovereign-ask-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(home, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.05'
const LIMIT_MS = 3_000
const WORDS = (tool: string, limit: string) =>
  `Permission to use ${tool} has been denied: nobody answered the permission ask within ${limit}, so it expired and was refused; the action was not run. ` +
  'Work that does not depend on this action can continue. Do not try to reach the same effect by another route. ' +
  'If the task cannot continue without this action, stop and say plainly what was not run and why the task needs it, then wait for the operator.'
const FLOOR = "ls //localhost/c$/ may reach the remote host localhost over SMB/WebDAV; a UNC path can leak this machine's login — Mercury does not open it without explicit permission."
const FLOOR_REASON = { type: 'safetyCheck', reason: FLOOR, operatorOnly: true }

const { createRunnerAsks } = await import('../../src/daemon/runner/runnerAsks.ts')
const { createPeer } = await import('../../src/daemon/runner-wire/peer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { isDenialResultText } = await import('../../src/engine/message-shapes/rejectionText.ts')
const asks = await import('../../src/daemon/session-seat/permissionAsks.ts')
const { concourseWorkersPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { RunnerConnection } = await import('../../src/daemon/runner-link/runnerConnection.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${t}`)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const settled = async (read: () => boolean, budgetMs: number): Promise<number> => {
  const started = Date.now()
  while (!read() && Date.now() - started < budgetMs) await sleep(25)
  return Date.now() - started
}

try {
  section('§1 the hosted runner: an operator-only floor in Sovereign is refused at the clock and the host is told why (the knob scales 3 minutes to 3 seconds)')
  {
    const toHost = new PassThrough()
    const toRunner = new PassThrough()
    const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
    const host = createPeer({ input: toHost, output: toRunner, side: 'host', log() {} })
    const capabilities = { holds_asks: true, elicitation: false, partial_rows: false }
    runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'floor' }))
    await host.request('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities })
    const runnerAsks = createRunnerAsks(runner, () => capabilities)
    let seen: any = null
    let withdrawn: unknown = null
    host.onRequest('permission/request', (params, hctx) => {
      seen = params
      hctx.signal.addEventListener('abort', () => { withdrawn = hctx.signal.reason })
      return new Promise(() => {}) as never
    })
    const ac = new AbortController()
    const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'sovereign' }, tasks: {}, sessionHooks: new Map() }
    const context = { abortController: ac, getAppState: () => state, setAppState() {}, messages: [], options: { tools: [] } }
    const tool = { name: 'Bash', inputSchema: z.object({}), checkPermissions: async () => ({ behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON }) }
    const askedAt = Date.now()
    const decision = runnerAsks.createCanUseTool()(tool as never, { command: 'ls //localhost/c$/' }, context as never, { message: { id: 'floor' } } as never, 'floor', { behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON } as never)
    await sleep(50)
    check('the ask parks on the host and carries the mode', runnerAsks.parkedAsks() === 1 && seen?.mode === 'sovereign', `${JSON.stringify(seen)} — createCanUseTool in src/daemon/runner/runnerAsks.ts must park the ask on the host through permission/request with the session mode`)
    await sleep(LIMIT_MS / 2)
    check('half-way to the clock the ask still stands', runnerAsks.parkedAsks() === 1, `parked asks: ${runnerAsks.parkedAsks()} — the ask left the parked table before its limit; check the clock in src/daemon/runner/runnerAsks.ts and askLimitMs in src/permissions/rules/askClock.ts`)
    const result = await Promise.race([decision, sleep(LIMIT_MS * 3).then(() => null)])
    check(`the runner refuses the call at the clock (took ${Date.now() - askedAt} ms)`, result !== null && (result as any).behavior === 'deny', `${JSON.stringify(result)} — the runner clock in src/daemon/runner/runnerAsks.ts (askLimitMs in src/permissions/rules/askClock.ts) must refuse the ask at its limit`)
    check('the refusal is the one sentence, naming the limit and the next move', (result as any)?.message === WORDS('Bash', '3s'), `${String((result as any)?.message)} — unansweredAskRefusal in src/permissions/rules/askClock.ts must return the WORDS sentence at the top of this file`)
    check('the classifier reads it as a denial (the crimson lead, never the amber failure)', typeof (result as any)?.message === 'string' && isDenialResultText((result as any).message), `${String((result as any)?.message)} — isDenialResultText in src/engine/message-shapes/rejectionText.ts must recognise the refusal sentence from unansweredAskRefusal`)
    check('the turn is not cut', !ac.signal.aborted, 'the turn abort signal fired when the ask expired; the expiry in src/daemon/runner/runnerAsks.ts must deny the one call and leave the turn running')
    check('the host saw the ask withdrawn with the cause', withdrawn === 'expired unanswered after 3s' && runnerAsks.parkedAsks() === 0, `${JSON.stringify(withdrawn)} (parked ${runnerAsks.parkedAsks()}) — the runner must withdraw the host ask with the cause from askExpiredCause in src/permissions/rules/askClock.ts`)
    host.end(); runner.end(); ac.abort()
  }

  section("§2 the daemon board: a crewmate's parked ask reads the seat's mode — Sovereign 3 minutes, Flow 10, Default 10 — and the knob scales every one")
  {
    const record = (short: string, permissionMode?: string) => ({
      runnerId: short,
      sessionId: `sess-${short}`,
      workspaceId: join(home, 'ws'),
      title: `t-${short}`,
      createdAt: Date.now(),
      startedAt: Date.now(),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    })
    writeFileSync(
      concourseWorkersPath(daemonDir),
      JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1'), 'concourse-w2': record('concourse-w2', 'sovereign') } }),
    )
    delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
    const hold = (short: string, tag: string, mode: string | undefined, agentId: string | undefined) => {
      const h = asks.holdWorkerAsk(short, { kind: 'tool', tool_use_id: `tu-${tag}`, tool_name: 'Bash', input: { command: 'ls //localhost/c$/' }, reason: FLOOR, ...(agentId !== undefined ? { agent_id: agentId } : {}), ...(mode !== undefined ? { mode } : {}) } as never, daemonDir, undefined, () => 'attached')
      const row = asks.listPendingPermissionAsks().filter(a => a.workerId === short).at(-1)
      return { h, row }
    }
    const sov = hold('concourse-w1', 'sov', 'sovereign', 'agent-1')
    const flow = hold('concourse-w1', 'flow', 'flow', 'agent-2')
    const dflt = hold('concourse-w1', 'default', 'default', 'agent-3')
    const noMode = hold('concourse-w2', 'nomode', undefined, 'agent-4')
    check("a crewmate's ask in Sovereign carries a 3-minute clock", sov.row?.limitMs === 180_000, `${JSON.stringify(sov.row)} — holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts must take the clock from askLimitMs for the ask mode`)
    check("a crewmate's ask in Flow carries a 10-minute clock", flow.row?.limitMs === 600_000, `${JSON.stringify(flow.row)} — holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts must take the clock from askLimitMs for the ask mode`)
    check("a crewmate's ask in Default carries a 10-minute clock", dflt.row?.limitMs === 600_000, `${JSON.stringify(dflt.row)} — holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts must take the clock from askLimitMs for the ask mode`)
    check("an ask without a mode on the wire reads the seat's spawn posture (sovereign → 3 minutes)", noMode.row?.limitMs === 180_000, `${JSON.stringify(noMode.row)} — holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts must fall back to the seat spawn mode recorded in the concourse workers file when the ask has none`)
    for (const held of [sov, flow, dflt, noMode]) if (held.row) asks.onWorkerAskWithdrawn(held.row.requestId, daemonDir)
    process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.05'
    const askedAt = Date.now()
    const scaled = hold('concourse-w1', 'scaled', 'sovereign', 'agent-5')
    check('under the knob the Sovereign crewmate clock is 3 seconds', scaled.row?.limitMs === LIMIT_MS, `${JSON.stringify(scaled.row)} — askLimitMs in src/permissions/rules/askClock.ts must scale by MERCURY_PERMISSION_ASK_EXPIRY_MINUTES`)
    let answer: any = null
    void scaled.h.answer.then(a => { answer = a })
    await settled(() => answer !== null, LIMIT_MS * 3)
    check(`the daemon refuses the parked ask at the clock (took ${Date.now() - askedAt} ms)`, answer?.outcome === 'deny', `${JSON.stringify(answer)} — settleUnanswered in src/daemon/session-seat/permissionAsks.ts must settle the parked ask with a deny when its timer fires`)
    check('with the same sentence the card and the runner use', answer?.message === WORDS('Bash', '3s'), `${String(answer?.message)} — expiredAskDenialMessage in src/daemon/session-seat/permissionAsks.ts must return the unansweredAskRefusal sentence`)
    check('the ask leaves the parked table', !asks.listPendingPermissionAsks().some(a => a.requestId === scaled.row?.requestId), 'settleUnanswered in src/daemon/session-seat/permissionAsks.ts must delete the ask from the parked table when it expires')
    const oblPath = join(process.env.MERCURY_CONFIG_DIR!, 'crew', 'obligations-switchboard.json')
    type ObligationRow = { ref: string; status: string; settlement?: { by?: string } }
    const readRow = (ref: string): ObligationRow | undefined => {
      if (!existsSync(oblPath)) return undefined
      const rows = (JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations: Record<string, ObligationRow> }).obligations
      return Object.values(rows).find(r => r.ref === ref)
    }
    await settled(() => readRow(`permission:${scaled.row?.requestId}`)?.status === 'withdrawn', 10_000)
    const expiredRow = readRow(`permission:${scaled.row?.requestId}`)
    check('the needs-you row settles withdrawn, the expiry named', expiredRow?.status === 'withdrawn' && expiredRow.settlement?.by === 'daemon: expired unanswered after 3s', `${JSON.stringify(expiredRow)} — settleUnanswered in src/daemon/session-seat/permissionAsks.ts must withdraw the needs-you row with the askExpiredCause text`)
  }

  section("§3 the daemon board: when the RUNNER's clock refuses the ask, the cancel carries the cause and the row says expired, not cancelled")
  {
    process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.05'
    const toHost = new PassThrough()
    const toRunner = new PassThrough()
    const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
    runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'floor' }))
    let heldId: string | undefined
    const connection = new RunnerConnection({ input: toHost, output: toRunner }, { holds_asks: true, elicitation: false, partial_rows: false }, {
      onRow() {},
      onAsk: params => {
        const h = asks.holdWorkerAsk('concourse-w1', params, daemonDir, undefined, () => 'attached')
        heldId = asks.listPendingPermissionAsks().filter(a => a.workerId === 'concourse-w1').at(-1)?.requestId
        return h
      },
      onApplied() {},
      onProtocolError() {},
      log() {},
    })
    check('the daemon door is open', (await connection.initialized) !== null, 'RunnerConnection in src/daemon/runner-link/runnerConnection.ts did not finish the initialize handshake with the proof runner peer')
    const runnerAsks = createRunnerAsks(runner, () => ({ holds_asks: true, elicitation: false, partial_rows: false }))
    const ac = new AbortController()
    const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'sovereign' }, tasks: {}, sessionHooks: new Map() }
    const context = { abortController: ac, getAppState: () => state, setAppState() {}, messages: [], options: { tools: [] } }
    const tool = { name: 'Bash', inputSchema: z.object({}), checkPermissions: async () => ({ behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON }) }
    const askedAt = Date.now()
    const decision = runnerAsks.createCanUseTool()(tool as never, { command: 'ls //localhost/c$/' }, context as never, { message: { id: 'floor' } } as never, 'floor', { behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON } as never)
    await settled(() => heldId !== undefined, 2_000)
    check("the session's own ask parks on the daemon with no daemon clock (its runner holds the clock)", heldId !== undefined && asks.listPendingPermissionAsks().some(a => a.requestId === heldId && a.agentId === undefined), `${JSON.stringify(asks.listPendingPermissionAsks())} — the runner ask must reach holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts through onAsk, without an agent clock`)
    const result = await Promise.race([decision, sleep(LIMIT_MS * 3).then(() => null)])
    check(`the runner refuses at the clock (took ${Date.now() - askedAt} ms)`, (result as any)?.behavior === 'deny' && (result as any)?.message === WORDS('Bash', '3s'), `${JSON.stringify(result)} — the runner clock in src/daemon/runner/runnerAsks.ts must refuse the ask with unansweredAskRefusal from src/permissions/rules/askClock.ts`)
    await settled(() => !asks.listPendingPermissionAsks().some(a => a.requestId === heldId), 2_000)
    check('the daemon board drops the ask (the card leaves the focused chat)', !asks.listPendingPermissionAsks().some(a => a.requestId === heldId), 'the runner cancel must reach onWorkerAskWithdrawn in src/daemon/session-seat/permissionAsks.ts and drop the ask from the parked table')
    const oblPath = join(process.env.MERCURY_CONFIG_DIR!, 'crew', 'obligations-switchboard.json')
    type ObligationRow = { ref: string; status: string; settlement?: { by?: string } }
    const readRow = (): ObligationRow | undefined => {
      if (!existsSync(oblPath)) return undefined
      const rows = (JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations: Record<string, ObligationRow> }).obligations
      return Object.values(rows).find(r => r.ref === `permission:${heldId}`)
    }
    await settled(() => readRow()?.status === 'withdrawn', 10_000)
    const row = readRow()
    check('the needs-you row says the ask expired unanswered, never that the session moved on', row?.status === 'withdrawn' && row.settlement?.by === 'the session: expired unanswered after 3s', `${JSON.stringify(row)} — onWorkerAskWithdrawn in src/daemon/session-seat/permissionAsks.ts must settle the row withdrawn with the cause carried by the runner cancel`)
    connection.close('done'); runner.end(); ac.abort()
  }
} finally {
  delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
  rmSync(home, { recursive: true, force: true })
}
console.log(failures ? `\nsovereign ask refusal: ${failures} FAILED` : '\nsovereign ask refusal: ALL PASS')
process.exit(failures ? 1 : 0)
