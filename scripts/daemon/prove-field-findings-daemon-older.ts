#!/usr/bin/env bun
import net from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const home = mkdtempSync(join(tmpdir(), 'field-daemon-older-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

const protocol = await import('../../src/daemon/protocol.ts')
const socketMod = await import('../../src/daemon/controlSocket.ts')
const hsMod = await import('../../src/daemon/handshake.ts')
const { binaryName } = await import('../../src/utils/config/derived.ts')
const { spawnSwitchToggleReceipt } = await import('../../src/services/switchboard/spawnSwitches.ts')
const { MERCURY_DAEMON_PROTO, MIN_PROTO, DAEMON_VERB_BORN_AT, verbBornAt, encodeFrame, readControlFrame } = protocol
const { controlSockPath, daemonControlRpc, forgetDaemonProtoForTesting, restartDaemonWords, olderDaemonRefusalLine } = socketMod

const CONTROL_KEY = 'k'.repeat(64)
const RAW_LIST_V5 = 'sessionControl requires { action: pause|resume|interrupt|attach|detach|grant-workflows|revoke-workflows|answer-permission|stop|set-model|set-permission-mode|session-facts|set-title|focus|blur|park|park-all|set-effort|contract|set-kit|set-schedule, sessionId, by }'

let scenarioN = 0
function freshPlane(): string {
  scenarioN++
  const dir = join(home, `d${scenarioN}`)
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = dir
  writeFileSync(join(dir, 'control.key'), CONTROL_KEY)
  hsMod.resetDaemonHandshakeForTesting()
  forgetDaemonProtoForTesting()
  return dir
}

interface Fixture {
  received: Array<{ op: string; action?: string }>
  close: () => Promise<void>
}

function startDaemon(opts: {
  proto: number
  version: string
  knownActions: string[]
  serve?: (req: Record<string, unknown>) => unknown | undefined
  hello?: boolean
}): Promise<Fixture> {
  const received: Array<{ op: string; action?: string }> = []
  const server = net.createServer(sock => {
    readControlFrame(
      sock,
      line => {
        const req = JSON.parse(line) as Record<string, unknown>
        const op = String(req.op)
        const action = typeof req.action === 'string' ? req.action : undefined
        received.push({ op, ...(action !== undefined ? { action } : {}) })
        const answer = (payload: unknown): void => void sock.end(encodeFrame(payload))
        if (op === 'ping') return answer({ ok: true, op: 'ping', version: opts.version, proto: opts.proto })
        if (op === 'hello' && opts.hello !== false) {
          return answer({ ok: true, op: 'hello', proto: opts.proto, minProto: 1, ready: true, version: opts.version, buildTree: null, pid: 4242, startedAt: Date.now() - 5000, ownerPid: null, foreground: false, live: 0, liveSessions: 0, warm: 0, restartArmed: false })
        }
        const proto = req.proto
        if (typeof proto !== 'number' || proto < 1 || proto > opts.proto) {
          return answer({ ok: false, code: 'EPROTO', error: 'proto mismatch', serverProto: opts.proto, serverVersion: opts.version })
        }
        const keyed = op === 'sessionControl' || op === 'sessionRewind' || op === 'signIns' || op === 'list' || op === 'restart-when-idle'
        if (!keyed) return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
        if (req.auth !== CONTROL_KEY) return answer({ ok: false, code: 'EAUTH', error: `${op} rejected: no key` })
        const served = opts.serve?.(req)
        if (served !== undefined) return answer(served)
        if (op === 'sessionControl') {
          if (action !== undefined && opts.knownActions.includes(action)) return answer({ ok: true, op: 'sessionControl', outcome: 'applied' })
          return answer({ ok: false, code: 'EUNKNOWN', error: `sessionControl requires { action: ${opts.knownActions.join('|')}, sessionId, by }` })
        }
        return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
      },
      () => sock.destroy(),
    )
  })
  return new Promise(resolve => {
    try {
      unlinkSync(controlSockPath())
    } catch {
    }
    server.listen(controlSockPath(), () => resolve({ received, close: () => new Promise(done => server.close(() => done())) }))
  })
}

const V5_ACTIONS = ['pause', 'resume', 'interrupt', 'attach', 'detach', 'grant-workflows', 'revoke-workflows', 'answer-permission', 'stop', 'set-model', 'set-permission-mode', 'session-facts', 'set-title', 'focus', 'blur', 'park', 'park-all', 'set-effort', 'contract', 'set-kit', 'set-schedule']
const errorOf = (reply: unknown): string => ((reply as { error?: unknown }).error as string | undefined) ?? ''
const refusalOf = (reply: unknown): string | undefined => (reply as { refusal?: string }).refusal
const RESTART = restartDaemonWords()

section('§1 a proto-5 daemon refuses the verbs born after it: the client speaks the doctor\'s sentence')
{
  freshPlane()
  const daemon = await startDaemon({ proto: 5, version: '1.0.0-beta.0', knownActions: V5_ACTIONS })
  const hs = await hsMod.handshakeDaemon({ timeoutMs: 1000 })
  check('the handshake reads the daemon as older (proto 5)', hs.state === 'older' && hs.daemon?.proto === 5, `${hs.state} · ${hs.daemon?.proto}`)
  const toggle = await daemonControlRpc({ op: 'sessionControl', action: 'set-spawn-switch', sessionId: 's-1', by: 'operator', spawnSwitch: { kind: 'subagents', on: false } } as never, { timeoutMs: 1000 })
  check('set-spawn-switch is refused', toggle.ok === false)
  check('the refusal is marked as the older-daemon gap', refusalOf(toggle) === 'daemon-older', JSON.stringify(toggle))
  check('the words are the doctor\'s sentence', errorOf(toggle).endsWith(RESTART), errorOf(toggle))
  check('the gap is named by protocol: the daemon\'s own, this build\'s, and the verb\'s age', errorOf(toggle).includes('protocol 5') && errorOf(toggle).includes(`speaks ${MERCURY_DAEMON_PROTO}`) && errorOf(toggle).includes('needs protocol 6') && errorOf(toggle).includes('sessionControl set-spawn-switch'), errorOf(toggle))
  check('POISON: the raw verb list is never relayed', !errorOf(toggle).includes('requires {') && !errorOf(toggle).includes('pause|resume'), errorOf(toggle))
  const signIns = await daemonControlRpc({ op: 'signIns' } as never, { timeoutMs: 1000 })
  check('signIns (born at 7) answers the same sentence, marked', signIns.ok === false && refusalOf(signIns) === 'daemon-older' && errorOf(signIns).endsWith(RESTART) && errorOf(signIns).includes('needs protocol 7'), errorOf(signIns))
  const rewind = await daemonControlRpc({ op: 'sessionRewind', sessionId: 's-1', by: 'operator', mode: 'conversation', userMessageId: 'u-1' } as never, { timeoutMs: 1000 })
  check('a verb the daemon knows (sessionRewind, born at 5) is served untouched — the fixture answers unknown op for it, so the door must NOT call that a gap', rewind.ok === false && refusalOf(rewind) !== 'daemon-older' && /^unknown op/.test(errorOf(rewind)), JSON.stringify(rewind))
  check('the verbs reached the daemon in its own dialect (proto 5 stamped)', daemon.received.some(r => r.op === 'sessionControl' && r.action === 'set-spawn-switch'))
  await daemon.close()
}

section('§2 a same-proto daemon\'s genuine unknown-verb refusal keeps the daemon\'s own words')
{
  freshPlane()
  const daemon = await startDaemon({ proto: MERCURY_DAEMON_PROTO, version: '9.9.9', knownActions: [...V5_ACTIONS, 'set-spawn-switch', 'stop-agent', 'resume-agent'] })
  await hsMod.handshakeDaemon({ timeoutMs: 1000 })
  const reply = await daemonControlRpc({ op: 'no-such-verb' } as never, { timeoutMs: 1000 })
  check('an op this build does not register is refused with the daemon\'s own words', reply.ok === false && refusalOf(reply) === undefined && errorOf(reply) === 'unknown op: no-such-verb', JSON.stringify(reply))
  const known = await daemonControlRpc({ op: 'sessionControl', action: 'set-spawn-switch', sessionId: 's-1', by: 'operator', spawnSwitch: { kind: 'subagents', on: false } } as never, { timeoutMs: 1000 })
  check('a verb the same-proto daemon serves is applied', known.ok === true)
  await daemon.close()
}

section('§3 the daemon\'s proto unknown: the refusal\'s shape names an older build, without a number')
{
  freshPlane()
  const daemon = await startDaemon({ proto: 5, version: '1.0.0-beta.0', knownActions: V5_ACTIONS })
  forgetDaemonProtoForTesting()
  const toggle = await daemonControlRpc({ op: 'sessionControl', action: 'set-spawn-switch', sessionId: 's-1', by: 'operator', spawnSwitch: { kind: 'subagents', on: false } } as never, { timeoutMs: 1000 })
  check('after the dialect retry the gap is numbered', toggle.ok === false && refusalOf(toggle) === 'daemon-older' && errorOf(toggle).includes('protocol 5'), errorOf(toggle))
  await daemon.close()
  const bare = olderDaemonRefusalLine('sessionControl set-spawn-switch', 6, null)
  check('with no proto on record the line still names an older build and the sentence', bare.startsWith('the daemon is an older build —') && bare.includes('needs protocol 6') && bare.endsWith(RESTART), bare)
}

section('§4 a pre-handshake (v1) daemon: hello refused as unknown op still classifies as pre-handshake')
{
  freshPlane()
  const daemon = await startDaemon({ proto: 1, version: '0.9.0', knownActions: [], hello: false })
  const first = await hsMod.handshakeDaemon({ timeoutMs: 1000 })
  check('the first hello (EPROTO) reads pre-handshake, older', first.state === 'older' && first.daemon?.preHandshake === true, `${first.state} · pre ${first.daemon?.preHandshake}`)
  const second = await hsMod.handshakeDaemon({ timeoutMs: 1000 })
  check('the second hello (unknown op in the remembered dialect, marked by the door) still reads pre-handshake, older', second.state === 'older' && second.daemon?.preHandshake === true, `${second.state} · pre ${second.daemon?.preHandshake}`)
  check('the honest line names /daemon restart', (second.line ?? '').includes('/daemon restart'), second.line ?? 'no line')
  await daemon.close()
}

section('§5 one owner: the verb ages, the doctor\'s sentence, the connector\'s receipts')
{
  const source = readFileSync(join(ROOT, 'src', 'daemon', 'protocol.ts'), 'utf8')
  const history = /\* {3}v(\d+) {2}([^\n]+)/g
  const born: Record<string, number> = {}
  for (const m of source.matchAll(history)) {
    const v = Number(m[1])
    const line = m[2]!
    if (line.includes('`hello`')) {
      born.hello = v
      born['restart-when-idle'] = v
    }
    if (line.includes('sessionRewind')) born.sessionRewind = v
    if (line.includes('set-spawn-switch')) born['sessionControl/set-spawn-switch'] = v
    if (line.includes('signIns')) born.signIns = v
    if (line.includes('stop-agent')) {
      born['sessionControl/stop-agent'] = v
      born['sessionControl/resume-agent'] = v
    }
  }
  for (const [verb, v] of Object.entries(born)) check(`the age table agrees with the wire's history: ${verb} → v${v}`, DAEMON_VERB_BORN_AT[verb] === v, `table says ${DAEMON_VERB_BORN_AT[verb]}`)
  check('an action born after its op reads its own age; a verb the wire has always had reads the floor', verbBornAt('sessionControl', 'set-spawn-switch') === 6 && verbBornAt('sessionControl', 'pause') === 3 && verbBornAt('ping') === MIN_PROTO)
  check("the door's default binary is the product's one launcher (binaryName)", restartDaemonWords() === restartDaemonWords(binaryName()))
  const doctor = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check("the doctor's older-daemon row reads the one sentence owner", doctor.includes('restartDaemonWords(binaryName())') && !doctor.includes('`restart the daemon: \\`${binaryName()} daemon restart\\``'))
  const connector = readFileSync(join(ROOT, 'src', 'services', 'engine-connector', 'daemonConnector.ts'), 'utf8')
  check("the connector's rewind receipt carries the door's sentence whole (no second spelling)", connector.includes("reply.refusal === 'daemon-older'") && !connector.includes('the daemon predates the rewind verb'))
  check("the connector's crew verbs carry the door's sentence whole (no second spelling)", !connector.includes('the daemon predates the crew stop and resume verbs'))
  check('the /subagents receipt spells the detail it was handed', spawnSwitchToggleReceipt('subagents', false, 'refused', 'the daemon is an older build — x').endsWith('the daemon is an older build — x'))
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-field-findings-daemon-older: ALL LAWS HOLD' : `\nprove-field-findings-daemon-older: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
