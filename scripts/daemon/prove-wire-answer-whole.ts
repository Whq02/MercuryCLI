#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'wire-whole-'))
const DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
for (const d of [process.env.MERCURY_CONFIG_DIR, DAEMON_DIR]) mkdirSync(d!, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const sock = await import('../../src/daemon/controlSocket.ts')
const server = await import('../../src/daemon/controlServer.ts')

function rawRequest(path: string, frame: Record<string, unknown>, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const c = net.createConnection(path)
    const chunks: Buffer[] = []
    const t = setTimeout(() => {
      c.destroy()
      resolve({ __timeout: true })
    }, timeoutMs)
    c.on('connect', () => c.write(`${JSON.stringify(frame)}\n`))
    c.on('data', b => {
      chunks.push(b)
      const joined = Buffer.concat(chunks)
      const nl = joined.indexOf(10)
      if (nl < 0) return
      clearTimeout(t)
      c.destroy()
      try {
        resolve(JSON.parse(joined.subarray(0, nl).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve({ __bad: true })
      }
    })
    c.on('error', () => {
      clearTimeout(t)
      resolve({ __err: true })
    })
  })
}

function crosses(label: string, reply: Record<string, unknown>, expected: Record<string, unknown>): void {
  const missing = Object.keys(expected).filter(k => JSON.stringify(reply[k]) !== JSON.stringify(expected[k]))
  check(`${label}: every result field crosses the wire whole (${Object.keys(expected).length} fields)`, missing.length === 0, missing.length > 0 ? `dropped or changed: ${missing.join(', ')} · reply=${JSON.stringify(reply)}` : '')
}

console.log('A every relayed result crosses the control socket whole')
{
  const admitOk = {
    ok: true as const,
    runnerId: 'runner-1',
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    pid: 4242,
    branchName: 'fork/one',
    mainHolderTitle: 'the holder',
    modelId: 'model-x',
    modelDisplayName: 'Model X',
    effort: 'high',
    note: 'the retained model has no credential here — /model chooses',
    kitSource: 'preset' as const,
    presetName: 'review-kit',
    presetNote: 'derived from the menu',
  }
  const dispatchOk = {
    ok: true,
    clientMessageId: 'cm-1',
    state: 'delivered',
    stateRevision: 3,
    runnerId: 'runner-2',
    sessionId: 'session-2',
    replay: 'fresh',
    branchName: 'fork/two',
    mainHolderTitle: 'holder two',
    modelId: 'model-y',
    modelDisplayName: 'Model Y',
    effort: 'low',
    kitSource: 'carried' as const,
    presetName: 'p2',
    presetNote: 'n2',
  }
  const dispatchRefused = {
    ok: false,
    clientMessageId: 'cm-held',
    state: 'queued',
    stateRevision: 7,
    error: 'held behind the main holder',
    replay: 'workspace-collision',
    heldReason: 'workspace-collision',
    heldByTitle: 'the other session',
    moves: [
      { verb: 'withdraw', label: 'take it off the board' },
      { verb: 'isolate', label: 'carve a worktree' },
    ],
  }
  const controlRequests: Array<Record<string, unknown>> = []
  const deps = {
    roster: {
      has: () => ({ present: true, alive: true, ready: true }),
      dispatch: async () => ({ ok: true, short: 'w-1', pid: 99, via: 'stub' }),
      reconfigureLongLived: () => ({ ok: true, respawned: true, pending: false, note: 'effort adjusted to the seat floor' }),
    } as never,
    breaker: { shouldSuppressFire: () => false } as never,
    dir: DAEMON_DIR,
    startedAt: Date.now(),
    maxInflight: 1,
    controlKey: 'k',
    isReady: () => true,
    onShutdown: () => ({ reaped: 0, workers: [] }),
    concourseAdmit: async () => admitOk,
    concourseDispatch: async (req: { clientMessageId: string }) => (req.clientMessageId === 'cm-held' ? dispatchRefused : dispatchOk),
    concourseControl: (req: Record<string, unknown>) => { controlRequests.push(req); return { outcome: 'applied' as const, detail: 'focused' } },
    concourseWarm: async () => ({ state: 'refused' as const, detail: 'no free slot' }),
    concourseRelease: () => ({ settled: true, killed: false }),
    crewSpawn: async () => ({ ok: true, pid: 77 }),
  }
  const handle = await server.startControlServer(deps as unknown as Parameters<typeof server.startControlServer>[0])
  const path = sock.controlSockPath()
  const base = { proto: 3, auth: 'k' }
  try {
    const admit = await rawRequest(path, { ...base, op: 'sessionAdmit', workspaceDir: '/ws' })
    check('admit answers ok', admit.ok === true && admit.op === 'sessionAdmit', JSON.stringify(admit))
    const { ok: _a, ...admitFields } = admitOk
    crosses('admit', admit, { ...admitFields, workerId: admitOk.runnerId })

    const disp = await rawRequest(path, { ...base, op: 'sessionDispatch', clientMessageId: 'cm-1', prompt: 'hi', workspaceDir: '/ws' })
    check('dispatch answers ok', disp.ok === true && disp.op === 'sessionDispatch', JSON.stringify(disp))
    const { ok: _d, ...dispFields } = dispatchOk
    crosses('dispatch (admitted)', disp, { ...dispFields, workerId: dispatchOk.runnerId })

    const held = await rawRequest(path, { ...base, op: 'sessionDispatch', clientMessageId: 'cm-held', prompt: 'hi', workspaceDir: '/ws' })
    check('a refused dispatch answers ok:false with the ledger word as refusal', held.ok === false && held.refusal === 'workspace-collision' && held.error === dispatchRefused.error, JSON.stringify(held))
    crosses('dispatch (refused)', held, {
      state: dispatchRefused.state,
      stateRevision: dispatchRefused.stateRevision,
      heldReason: dispatchRefused.heldReason,
      heldByTitle: dispatchRefused.heldByTitle,
      moves: dispatchRefused.moves,
    })

    const control = await rawRequest(path, { ...base, op: 'sessionControl', action: 'focus', sessionId: 's-1', by: 't' })
    crosses('control', control, { ok: true, op: 'sessionControl', outcome: 'applied', detail: 'focused' })
    const terminalApplication = { identity: 'com.example.CockpitTerminal', name: 'Cockpit terminal' }
    const focused = await rawRequest(path, { ...base, op: 'sessionControl', action: 'focus', sessionId: 's-1', by: 'operator:1234', terminalApplication })
    check('the authenticated focus carries the exact cockpit terminal identity', focused.ok === true && JSON.stringify(controlRequests.at(-1)?.terminalApplication) === JSON.stringify(terminalApplication))
    const count = controlRequests.length
    const malformed = await rawRequest(path, { ...base, op: 'sessionControl', action: 'focus', sessionId: 's-1', by: 'operator:1234', terminalApplication: { identity: '', name: 'wrong' } })
    check('an empty terminal identity is refused before the handler', malformed.ok === false && controlRequests.length === count)
    const wrongVerb = await rawRequest(path, { ...base, op: 'sessionControl', action: 'blur', sessionId: 's-1', by: 'operator:1234', terminalApplication })
    check('a terminal identity cannot ride another control verb', wrongVerb.ok === false && controlRequests.length === count)
    const unauthenticated = await rawRequest(path, { ...base, auth: 'wrong', op: 'sessionControl', action: 'focus', sessionId: 's-1', by: 'operator:1234', terminalApplication })
    check('the terminal identity does not bypass control authentication', unauthenticated.ok === false && controlRequests.length === count)

    const warm = await rawRequest(path, { ...base, op: 'concourseWarm', workspaceDir: '/ws' })
    crosses('warm', warm, { ok: true, op: 'concourseWarm', state: 'refused', detail: 'no free slot' })

    const release = await rawRequest(path, { ...base, op: 'sessionRelease', runnerId: 'runner-1' })
    crosses('release', release, { ok: true, op: 'sessionRelease', settled: true, killed: false })

    const reconfigure = await rawRequest(path, { ...base, op: 'reconfigure', short: 'w-1', effort: 'xhigh' })
    crosses('reconfigure', reconfigure, { ok: true, op: 'reconfigure', respawned: true, pending: false, note: 'effort adjusted to the seat floor' })

    const crew = await rawRequest(path, { ...base, op: 'crewSpawn', name: 'scout', model: 'model-x' })
    crosses('crew spawn', crew, { ok: true, op: 'crewSpawn', pid: 77 })

    const worker = await rawRequest(path, { ...base, op: 'dispatch', d: { prompt: 'go' } })
    crosses('worker dispatch', worker, { ok: true, op: 'dispatch', short: 'w-1', pid: 99, via: 'stub' })
  } finally {
    await handle.close()
  }
}

console.log('B the owners spell the law')
{
  const serverSrc = read('src/daemon/controlServer.ts')
  const protocolSrc = read('src/daemon/protocol.ts')
  check('the key lists exist, one per relayed result', ['ADMIT_WIRE_KEYS', 'DISPATCH_WIRE_KEYS', 'DISPATCH_REFUSAL_WIRE_KEYS', 'CONTROL_WIRE_KEYS', 'WARM_WIRE_KEYS', 'RELEASE_WIRE_KEYS', 'RECONFIGURE_WIRE_KEYS', 'CREW_SPAWN_WIRE_KEYS', 'WORKER_DISPATCH_WIRE_KEYS'].every(k => serverSrc.includes(`const ${k} = [`)))
  check('every key list satisfies the result it picks from (a typo is a red line)', (serverSrc.match(/\] as const satisfies readonly \(keyof \w+\)\[\]/g) ?? []).length >= 9)
  check('a Whole law stands for every relayed result (a forgotten key names itself at typecheck)', (serverSrc.match(/const \w+Whole: Whole</g) ?? []).length === 8)
  const relayed = [
    "...pickDefined(r, ADMIT_WIRE_KEYS)",
    "...pickDefined(r, DISPATCH_WIRE_KEYS)",
    "...pickDefined(r, DISPATCH_REFUSAL_WIRE_KEYS)",
    "...pickDefined(r, CONTROL_WIRE_KEYS)",
    "...pickDefined(warm, WARM_WIRE_KEYS)",
    "...pickDefined(r, RELEASE_WIRE_KEYS)",
    "...pickDefined(r, RECONFIGURE_WIRE_KEYS)",
    "...pickDefined(r, CREW_SPAWN_WIRE_KEYS)",
    "...pickDefined(out, WORKER_DISPATCH_WIRE_KEYS)",
  ]
  for (const needle of relayed) check(`the answer rides the list: ${needle}`, serverSrc.includes(needle))
  check('no relayed answer picks a receipt field by hand any more', !/\.\.\.\(r\.(note|branchName|modelId|heldReason|moves) !== undefined \? \{/.test(serverSrc))
  check('pickDefined copies only defined values (absent stays absent on the wire)', serverSrc.includes('for (const k of keys) if (r[k] !== undefined) out[k] = r[k]'))
  const admitMember = protocolSrc.slice(protocolSrc.indexOf("op: 'sessionAdmit' | 'concourseAdmit'"), protocolSrc.indexOf("op: 'sessionList' | 'concourseList'"))
  for (const field of ['branchName?: string', 'mainHolderTitle?: string', 'modelId?: string', 'modelDisplayName?: string', 'effort?: string', 'note?: string', 'kitSource?:', 'liveHop?: true', 'presetName?: string', 'presetNote?: string']) {
    check(`the reply union's admit member declares ${field.split('?')[0]}`, admitMember.includes(field))
  }
  const failMember = protocolSrc.slice(protocolSrc.indexOf('ok: false\n      code: DaemonErrorCode'), protocolSrc.indexOf('/** Flat snapshot the `status` op returns'))
  for (const field of ['heldReason?: string', 'heldByTitle?: string', 'moves?: Array<{ verb: string; label: string }>', 'refusal?: string', 'state?: string', 'stateRevision?: number']) {
    check(`the reply union's failure member declares ${field.split('?')[0]}`, failMember.includes(field))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n ❌ wire-answer-whole — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ wire-answer-whole — every relayed result crosses the control socket whole; the key lists and Whole laws stand at the owner')
