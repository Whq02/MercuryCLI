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
const FLOOR_REASON = { type: 'safetyCheck', reason: FLOOR, operatorOnly: true, floor: true }

const { handleInteractivePermission } = await import('../../src/hooks/toolPermission/handlers/interactiveHandler.ts')
const { createRunnerAsks } = await import('../../src/cli/headless/runnerAsks.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { isDenialResultText } = await import('../../src/utils/messages/rejectionText.ts')
const asks = await import('../../src/daemon/permissionAsks.ts')
const { concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
const { RunnerConnection } = await import('../../src/daemon/runnerConnection.ts')

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
  section('§1 the foreground card: an operator-only floor in Sovereign is refused at the clock (the knob scales 3 minutes to 3 seconds)')
  {
    const ac = new AbortController()
    const queue: any[] = []
    const results: any[] = []
    let grants = 0
    const ctx = {
      tool: { name: 'Bash' }, input: { command: 'ls //localhost/c$/' }, assistantMessage: { message: { id: 'floor' } }, toolUseID: 'floor',
      toolUseContext: { abortController: ac, getAppState: () => ({ toolPermissionContext: { mode: 'sovereign' } }) },
      pushToQueue: (item: any) => queue.push(item), removeFromQueue: () => { queue.length = 0 }, logDecision() {},
      cancelAndAbort() { ac.abort(); return { behavior: 'ask', message: 'aborted' } },
      buildDeny: (message: string) => ({ behavior: 'deny', message }),
      handleUserAllow: async () => { grants++; return { behavior: 'allow' } },
    }
    const askedAt = Date.now()
    handleInteractivePermission({ ctx: ctx as never, description: FLOOR, result: { behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON } as never, awaitAutomatedChecksBeforeDialog: true }, value => results.push(value))
    const card = queue[0]
    check('the floor reaches a card in Sovereign', queue.length === 1 && card !== undefined)
    await sleep(LIMIT_MS / 2)
    check('half-way to the clock the card still stands', queue.length === 1 && results.length === 0)
    const waited = await settled(() => results.length === 1, LIMIT_MS * 3)
    check(`the card leaves and the call is refused at the clock (${LIMIT_MS} ms; took ${Date.now() - askedAt} ms)`, queue.length === 0 && results.length === 1 && results[0].behavior === 'deny', `queue=${queue.length} results=${JSON.stringify(results)} waited=${waited}`)
    check('the refusal is the one sentence, naming the limit and the next move', results[0]?.message === WORDS('Bash', '3s'), String(results[0]?.message))
    check('the classifier reads it as a denial (the crimson lead, never the amber failure)', typeof results[0]?.message === 'string' && isDenialResultText(results[0].message))
    check('the turn is not cut', !ac.signal.aborted)
    await card?.onAllow({}, [])
    check('a late yes runs nothing', results.length === 1 && grants === 0)
    ac.abort()
  }

  section('§2 the hosted runner: the same floor in Sovereign is refused at the clock and the host is told why')
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
    check('the ask parks on the host and carries the mode', runnerAsks.parkedAsks() === 1 && seen?.mode === 'sovereign', JSON.stringify(seen))
    const result = await Promise.race([decision, sleep(LIMIT_MS * 3).then(() => null)])
    check(`the runner refuses the call at the clock (took ${Date.now() - askedAt} ms)`, result !== null && (result as any).behavior === 'deny', JSON.stringify(result))
    check('the refusal is the one sentence', (result as any)?.message === WORDS('Bash', '3s'), String((result as any)?.message))
    check('the host saw the ask withdrawn with the cause', withdrawn === 'expired unanswered after 3s' && runnerAsks.parkedAsks() === 0, JSON.stringify(withdrawn))
    host.end(); runner.end(); ac.abort()
  }

  section("§3 the daemon board: a crewmate's parked ask reads the seat's mode — Sovereign 3 minutes, Flow 10, Default 10 — and the knob scales every one")
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
    check("a crewmate's ask in Sovereign carries a 3-minute clock", sov.row?.limitMs === 180_000, JSON.stringify(sov.row))
    check("a crewmate's ask in Flow carries a 10-minute clock", flow.row?.limitMs === 600_000, JSON.stringify(flow.row))
    check("a crewmate's ask in Default carries a 10-minute clock", dflt.row?.limitMs === 600_000, JSON.stringify(dflt.row))
    check("an ask without a mode on the wire reads the seat's spawn posture (sovereign → 3 minutes)", noMode.row?.limitMs === 180_000, JSON.stringify(noMode.row))
    for (const held of [sov, flow, dflt, noMode]) if (held.row) asks.onWorkerAskWithdrawn(held.row.requestId, daemonDir)
    process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.05'
    const askedAt = Date.now()
    const scaled = hold('concourse-w1', 'scaled', 'sovereign', 'agent-5')
    check('under the knob the Sovereign crewmate clock is 3 seconds', scaled.row?.limitMs === LIMIT_MS, JSON.stringify(scaled.row))
    let answer: any = null
    void scaled.h.answer.then(a => { answer = a })
    await settled(() => answer !== null, LIMIT_MS * 3)
    check(`the daemon refuses the parked ask at the clock (took ${Date.now() - askedAt} ms)`, answer?.outcome === 'deny', JSON.stringify(answer))
    check('with the same sentence the card and the runner use', answer?.message === WORDS('Bash', '3s'), String(answer?.message))
    check('the ask leaves the parked table', !asks.listPendingPermissionAsks().some(a => a.requestId === scaled.row?.requestId))
    const oblPath = join(process.env.MERCURY_CONFIG_DIR!, 'crew', 'obligations-switchboard.json')
    type ObligationRow = { ref: string; status: string; settlement?: { by?: string } }
    const readRow = (ref: string): ObligationRow | undefined => {
      if (!existsSync(oblPath)) return undefined
      const rows = (JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations: Record<string, ObligationRow> }).obligations
      return Object.values(rows).find(r => r.ref === ref)
    }
    await settled(() => readRow(`permission:${scaled.row?.requestId}`)?.status === 'withdrawn', 10_000)
    const expiredRow = readRow(`permission:${scaled.row?.requestId}`)
    check('the needs-you row settles withdrawn, the expiry named', expiredRow?.status === 'withdrawn' && expiredRow.settlement?.by === 'daemon: expired unanswered after 3s', JSON.stringify(expiredRow))
  }

  section("§4 the daemon board: when the RUNNER's clock refuses the ask, the cancel carries the cause and the row says expired, not cancelled")
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
    check('the daemon door is open', (await connection.initialized) !== null)
    const runnerAsks = createRunnerAsks(runner, () => ({ holds_asks: true, elicitation: false, partial_rows: false }))
    const ac = new AbortController()
    const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'sovereign' }, tasks: {}, sessionHooks: new Map() }
    const context = { abortController: ac, getAppState: () => state, setAppState() {}, messages: [], options: { tools: [] } }
    const tool = { name: 'Bash', inputSchema: z.object({}), checkPermissions: async () => ({ behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON }) }
    const askedAt = Date.now()
    const decision = runnerAsks.createCanUseTool()(tool as never, { command: 'ls //localhost/c$/' }, context as never, { message: { id: 'floor' } } as never, 'floor', { behavior: 'ask', message: FLOOR, decisionReason: FLOOR_REASON } as never)
    await settled(() => heldId !== undefined, 2_000)
    check("the session's own ask parks on the daemon with no daemon clock (its runner holds the clock)", heldId !== undefined && asks.listPendingPermissionAsks().some(a => a.requestId === heldId && a.agentId === undefined), JSON.stringify(asks.listPendingPermissionAsks()))
    const result = await Promise.race([decision, sleep(LIMIT_MS * 3).then(() => null)])
    check(`the runner refuses at the clock (took ${Date.now() - askedAt} ms)`, (result as any)?.behavior === 'deny' && (result as any)?.message === WORDS('Bash', '3s'), JSON.stringify(result))
    await settled(() => !asks.listPendingPermissionAsks().some(a => a.requestId === heldId), 2_000)
    check('the daemon board drops the ask (the card leaves the focused chat)', !asks.listPendingPermissionAsks().some(a => a.requestId === heldId))
    const oblPath = join(process.env.MERCURY_CONFIG_DIR!, 'crew', 'obligations-switchboard.json')
    type ObligationRow = { ref: string; status: string; settlement?: { by?: string } }
    const readRow = (): ObligationRow | undefined => {
      if (!existsSync(oblPath)) return undefined
      const rows = (JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations: Record<string, ObligationRow> }).obligations
      return Object.values(rows).find(r => r.ref === `permission:${heldId}`)
    }
    await settled(() => readRow()?.status === 'withdrawn', 10_000)
    const row = readRow()
    check('the needs-you row says the ask expired unanswered, never that the session moved on', row?.status === 'withdrawn' && row.settlement?.by === 'the session: expired unanswered after 3s', JSON.stringify(row))
    connection.close('done'); runner.end(); ac.abort()
  }
} finally {
  delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
  rmSync(home, { recursive: true, force: true })
}
console.log(failures ? `\nsovereign ask refusal: ${failures} FAILED` : '\nsovereign ask refusal: ALL PASS')
process.exit(failures ? 1 : 0)
