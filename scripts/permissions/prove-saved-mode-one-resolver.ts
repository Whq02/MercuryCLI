#!/usr/bin/env bun
// gate-watch: src/utils/permissions/permissionSetup.ts src/daemon/concourseSupervisor.ts src/daemon/headlessRun.ts
// gate-watch: src/daemon/controlSocket.ts src/daemon/protocol.ts src/services/engine-connector/seatProjections.ts
// gate-watch: scripts/lib/firstRunSeed.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_CONCOURSE_WORKER', 'CI', 'NODE_ENV']) {
  delete process.env[key]
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'saved-mode-doors-')))
const ROOT = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')
const BUN = process.execPath
const KEEP = process.argv.includes('--keep')
const WORDS = ['sovereign', 'apollo', 'frobnicate', 'implement'] as const
const EXPECTED: Record<(typeof WORDS)[number], string> = { sovereign: 'default', apollo: 'apollo', frobnicate: 'default', implement: 'implement' }
const SENTENCE = 'Sovereign Mode requires launching with --sovereign'
const PROOF_ENV = {
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_DAP: '0',
  NO_COLOR: '1',
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const tryKill = (child: ChildProcess, signal: NodeJS.Signals): boolean => {
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  do {
    if (await cond()) return true
    await wait(150)
  } while (Date.now() < deadline)
  return cond()
}
const homeWith = (name: string, settings: unknown): string => {
  const home = join(SCRATCH, `home-${name}`)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  return home
}

section('§1 the one resolver at the module seam: the seat spawn and the direct boot read a saved guardrails.mode alike')
type Seam = { seat: string; argv: string[]; direct: { mode: string; notification?: string }; carried: Record<string, string> }
function seamIn(name: string, settings: unknown): Seam | null {
  const home = homeWith(`seam-${name}`, settings)
  const src = `
    import { seatInitialPermissionMode } from ${JSON.stringify(join(ROOT, 'src/daemon/concourseSupervisor.ts'))}
    import { headlessPermissionArgv } from ${JSON.stringify(join(ROOT, 'src/daemon/headlessRun.ts'))}
    import { initialPermissionModeFromCLI } from ${JSON.stringify(join(ROOT, 'src/utils/permissions/permissionSetup.ts'))}
    const seat = seatInitialPermissionMode(undefined)
    const carried = Object.fromEntries(['sovereign', 'apollo', 'implement', 'flow'].map(word => [word, seatInitialPermissionMode(word)]))
    process.stdout.write(JSON.stringify({ seat, argv: headlessPermissionArgv(seat, false), direct: initialPermissionModeFromCLI({ permissionModeCli: undefined, dangerouslySkipPermissions: false }), carried }))
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'test', MERCURY_DAEMON_PERMISSION_MODE: '' } })
  try {
    return JSON.parse((res.stdout ?? '').trim().split('\n').pop() ?? '') as Seam
  } catch {
    console.log(`  (the seam probe for '${name}' answered nothing: ${(res.stderr ?? '').trim().slice(-300)})`)
    return null
  }
}
for (const word of WORDS) {
  const seam = seamIn(word, { guardrails: { mode: word } })
  if (seam === null) {
    failures++
    continue
  }
  check(`saved '${word}' ⇒ the seat boots '${EXPECTED[word]}' (${JSON.stringify(seam.seat)}, argv ${JSON.stringify(seam.argv)})`, seam.seat === EXPECTED[word] && !seam.argv.includes('--sovereign'))
  check(`saved '${word}' ⇒ the direct boot opens '${EXPECTED[word]}' (${JSON.stringify(seam.direct.mode)})`, seam.direct.mode === EXPECTED[word])
  check(`saved '${word}' ⇒ the two doors agree`, seam.seat === seam.direct.mode, `seat=${seam.seat} direct=${seam.direct.mode}`)
  if (word === 'sovereign') {
    check('saved sovereign is refused with the one sentence on the direct boot', (seam.direct.notification ?? '').includes(SENTENCE), JSON.stringify(seam.direct.notification))
  }
}
{
  const none = seamIn('none', {})
  check("nothing saved ⇒ the seat keeps its board posture 'flow' and the direct boot 'default' (the floors stand)", none?.seat === 'flow' && none?.direct.mode === 'default', JSON.stringify(none))
  check("the admission's carried posture still crosses as itself (the launch's own resolved word)", none?.carried.sovereign === 'sovereign' && none?.carried.apollo === 'apollo' && none?.carried.implement === 'implement' && none?.carried.flow === 'flow', JSON.stringify(none?.carried))
}

if (!existsSync(BIN)) {
  console.log(`\n  [SKIP] ${BIN} absent — the built-product doors need a build`)
} else {
  section('§2 the direct door on the built product: the init row of `run` under each saved word')
  async function initRowMode(word: string): Promise<string | null> {
    const home = homeWith(`run-${word}`, { guardrails: { mode: word } })
    const work = join(SCRATCH, `run-work-${word}`)
    mkdirSync(work, { recursive: true })
    const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
    seedFirstRun(home, [work])
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: word } }))
    return new Promise(resolvePromise => {
      const child = spawn('node', [BIN, 'run', 'say ok', '--format', 'rows'], { cwd: work, env: { ...process.env, ...PROOF_ENV, MERCURY_CONFIG_DIR: home }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let settled = false
      const finish = (mode: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(killer)
        child.stdin.end()
        tryKill(child, 'SIGTERM')
        resolvePromise(mode)
      }
      const killer = setTimeout(() => finish(null), 60_000)
      child.stdout.on('data', d => {
        out += String(d)
        for (const line of out.split('\n')) {
          try {
            const row = JSON.parse(line) as { type?: string; mode?: string }
            if (row.type === 'session') finish(row.mode ?? null)
          } catch {
            continue
          }
        }
      })
      child.on('close', () => finish(null))
    })
  }
  const direct: Record<string, string | null> = {}
  for (const word of ['sovereign', 'apollo', 'frobnicate'] as const) {
    direct[word] = await initRowMode(word)
    check(`run door · saved '${word}' ⇒ the session row's mode '${EXPECTED[word]}'`, direct[word] === EXPECTED[word], JSON.stringify(direct[word]))
  }

  section('§3 the seat door on the built product: a daemon-admitted session under each saved word')
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
  const rpc = (request: object, timeoutMs = 10_000) => daemonControlRpc(request as never, { timeoutMs })
  type Seat = { record?: string; consent?: true; runner?: string; spoke: boolean; log: string }
  async function seatUnder(word: string): Promise<Seat> {
    const home = homeWith(`seat-${word}`, { guardrails: { mode: word } })
    const work = join(SCRATCH, `seat-work-${word}`)
    const daemonDir = join(home, 'daemon')
    mkdirSync(work, { recursive: true })
    const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
    seedFirstRun(home, [work])
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: word } }))
    writeFileSync(join(work, 'README.md'), '# work\n')
    process.env.MERCURY_CONFIG_DIR = home
    process.env.MERCURY_DAEMON_DIR = daemonDir
    const env = { ...process.env, ...PROOF_ENV, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_WARM_RUNNER: '0' }
    let log = ''
    const daemon: ChildProcess = spawn('node', [BIN, 'daemon', 'run', work], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [daemon.stdout, daemon.stderr]) stream?.on('data', d => (log += String(d)))
    const exited = new Promise<void>(r => daemon.once('exit', () => r()))
    const out: Seat = { spoke: false, log: '' }
    try {
      const ready = await until(async () => {
        const hello = (await rpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }).catch(() => ({ ok: false }))) as { ok: boolean; ready?: boolean }
        return hello.ok && hello.ready === true
      }, 60_000)
      if (!ready) {
        out.log = log.slice(-600)
        return out
      }
      const admit = (await rpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', bornBlank: true }, 60_000)) as { ok: boolean; sessionId?: string; error?: string }
      if (!admit.ok || admit.sessionId === undefined) {
        out.log = JSON.stringify(admit)
        return out
      }
      const sid = admit.sessionId
      await until(() => Object.values(readSessionWorkers(daemonDir)).some(r => r.sessionId === sid && r.pid !== undefined), 30_000)
      const record = Object.values(readSessionWorkers(daemonDir)).find(r => r.sessionId === sid)
      out.record = record?.permissionMode
      out.consent = record?.bypassConsent
      out.spoke = await until(async () => {
        await rpc({ op: 'sessionControl', action: 'session-facts', sessionId: sid, by: 'operator' }).catch(() => undefined)
        await wait(300)
        return (readSessionFacts(sid, daemonDir) as { queueReady?: boolean } | null)?.queueReady === true
      }, 60_000)
      out.runner = readSessionFacts(sid, daemonDir)?.permissionMode
      out.log = log.split('\n').filter(l => /sovereign|permission/i.test(l)).slice(-4).join(' | ')
      return out
    } finally {
      await rpc({ op: 'shutdown', reapWorkers: true }, 5_000).catch(() => undefined)
      const gone = await Promise.race([exited.then(() => true), wait(15_000).then(() => false)])
      if (!gone) tryKill(daemon, 'SIGKILL')
      delete process.env.MERCURY_DAEMON_DIR
    }
  }
  for (const word of ['sovereign', 'apollo', 'frobnicate'] as const) {
    const seat = await seatUnder(word)
    check(`seat door · saved '${word}' ⇒ the record stamps '${EXPECTED[word]}' and no consent`, seat.record === EXPECTED[word] && seat.consent === undefined, `record=${seat.record} consent=${seat.consent} ${seat.log}`)
    check(`seat door · saved '${word}' ⇒ the runner's own word is '${EXPECTED[word]}'`, seat.spoke && seat.runner === EXPECTED[word], `spoke=${seat.spoke} runner=${seat.runner}`)
    check(`saved '${word}' ⇒ the run door and the seat door open the same posture`, direct[word] !== null && direct[word] === seat.runner, `run=${direct[word]} seat=${seat.runner}`)
  }
}

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n[keep] ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-saved-mode-one-resolver: ALL LAWS HOLD' : `\nprove-saved-mode-one-resolver: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
