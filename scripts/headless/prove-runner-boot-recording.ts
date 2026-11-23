#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { FIXTURE_MODEL } from '../lib/builtProduct.ts'
import { handoffTurn, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { hostRunner, type HostedRunner } from '../lib/runnerHost.ts'

type Env = Record<string, string | undefined>
type WireBoot = { name: string; argv: string[]; env: Env; lines: unknown[]; stderr: unknown[]; exit: number | null | string; last: { stdout: unknown; stderr: unknown }; notifications?: { failed: number; dropped: number } }
type PrintBoot = { name: string; args: string[]; env: Env; status: number | null; stdout: unknown[]; stderr: unknown[]; last: { stdout: unknown; stderr: unknown }; phases: string[] | null; phaseReport?: unknown }
type Recording = { wire: WireBoot[]; print: PrintBoot[] }

const argOf = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const TREE = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(TREE, 'dist', 'mercury.mjs')
const PROMPT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CLAIMED = '6f1d2c3b-4a59-4e68-9f70-a1b2c3d4e5f6'
const NO_SUCH = '7e2d3c4b-5a69-4f78-8a81-b2c3d4e5f6a7'
const REFUSED_MODEL = 'compat/no-such-lane/no-such-model'
const DEAD_ADDRESS = 'http://127.0.0.1:1'
const BOOT_PHASES = ['graph_load', 'cli_parse', 'invocation_resolution', 'config_auth', 'flush_exit']

const remask = argOf('--remask')
if (remask === undefined && !existsSync(DIST)) {
  console.log(`${DIST} is absent: run \`bun run build.ts\` in ${TREE}, then run this proof again`)
  process.exit(1)
}

const parent = remask === undefined ? realpathSync(mkdtempSync(join(tmpdir(), 'boot-recording-'))) : ''
const world = (name: string): { home: string; cwd: string } => {
  const home = join(parent, name, 'home')
  const cwd = join(parent, name, 'cwd')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { home, cwd }
}
const envOf = (home: string, api: string | null, extra: Env): Env => ({
  ...Object.fromEntries(['ANTHROPIC_BASE_URL', ...FLAG_REGISTRY.map(row => row.env).filter(name => /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/.test(name))].map(name => [name, DEAD_ADDRESS])),
  ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
  HOME: home,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: join(home, '.mercury'),
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ...(api !== null ? { ANTHROPIC_BASE_URL: api } : {}),
  ...extra,
})

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const linesOf = (text: string): unknown[] =>
  text
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return line
      }
    })

type Booted = { runner: HostedRunner; quiet: () => Promise<void>; sessionId: string | null }

async function wireBoot(name: string, at: { home: string; cwd: string }, argv: string[], extra: Env, turns: ScriptedTurn[], use: (booted: Booted) => Promise<void>, how: { ends?: 'kill'; first?: (runner: HostedRunner) => void; logFile?: string } = {}): Promise<WireBoot & { sessionId: string | null }> {
  const api = await startFixtureApi(turns)
  let out = ''
  const runner = hostRunner({ dist: DIST, node: nodeBinPath(), cwd: at.cwd, home: at.home, env: envOf(at.home, api.url, extra), argv: [...argv, ...(how.logFile !== undefined ? ['--log-file', how.logFile] : [])], raw: chunk => (out += chunk), report: () => {} })
  how.first?.(runner)
  const quiet = async (): Promise<void> => {
    let seen = -1
    let still = 0
    for (let waited = 0; waited < 20_000 && still < 600; waited += 50) {
      await pause(50)
      still = out.length === seen ? still + 50 : 0
      seen = out.length
    }
  }
  let sessionId: string | null = null
  let exit: number | null | string = 'still running'
  try {
    const hello = await runner.initialize()
    sessionId = hello.session_id
    await quiet()
    await use({ runner, quiet, sessionId })
    if (how.ends === 'kill') {
      endProcessGroup(runner.child)
      exit = await Promise.race([runner.exited.then(code => (code === null ? 'killed' : code)), pause(10_000).then(() => 'still running')])
    } else exit = await runner.stop(10_000)
  } catch (error) {
    exit = `the boot failed: ${(error as Error).message}`
  } finally {
    await runner.stop(1_000).catch(() => undefined)
    await api.close()
  }
  const lines = linesOf(out)
  const stderr = linesOf(runner.stderr())
  const logged = how.logFile !== undefined && existsSync(how.logFile) ? readFileSync(how.logFile, 'utf8').split('\n').filter(text => text.includes('runner wire: notification ')) : null
  return { name, argv, env: extra, lines, stderr, exit, last: { stdout: lines.at(-1) ?? null, stderr: stderr.at(-1) ?? null }, sessionId, ...(logged !== null ? { notifications: { failed: logged.filter(text => text.includes(' failed: ')).length, dropped: logged.filter(text => text.includes(' is dropped ')).length } } : {}) }
}

async function printBoot(name: string, at: { home: string; cwd: string }, args: string[], extra: Env, turns: ScriptedTurn[], logFile?: string): Promise<PrintBoot> {
  const api = await startFixtureApi(turns)
  const full = ['run', ...args, ...(logFile !== undefined ? ['--log-file', logFile] : [])]
  const child = spawnInOwnGroup(nodeBinPath(), [DIST, ...full], { cwd: at.cwd, env: { PATH: process.env.PATH, ...envOf(at.home, api.url, extra) } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => (stdout += String(chunk)))
  child.stderr!.on('data', chunk => (stderr += String(chunk)))
  const ceiling = setTimeout(() => endProcessGroup(child), 120_000)
  const status = await new Promise<number | null>(done => {
    child.once('close', code => done(code))
    child.once('error', () => done(null))
  })
  clearTimeout(ceiling)
  endProcessGroup(child)
  await api.close()
  let phases: PrintBoot['phases'] = null
  let phaseReport: unknown
  if (logFile !== undefined && existsSync(logFile)) {
    const line = readFileSync(logFile, 'utf8').split('\n').findLast(text => text.includes('[run-phases] '))
    if (line !== undefined) {
      const report = JSON.parse(line.slice(line.indexOf('[run-phases] ') + '[run-phases] '.length)) as { phases: Array<{ phase: string; atMs: number }> }
      phaseReport = report
      phases = report.phases.filter(p => BOOT_PHASES.includes(p.phase)).sort((x, y) => x.atMs - y.atMs).map(p => p.phase)
    }
  }
  const out = linesOf(stdout)
  const err = linesOf(stderr)
  return { name, args: full, env: extra, status, stdout: out, stderr: err, last: { stdout: out.at(-1) ?? null, stderr: err.at(-1) ?? null }, phases, ...(phaseReport !== undefined ? { phaseReport } : {}) }
}

const outcomes = (runner: HostedRunner): number => runner.rows.filter(row => row.type === 'outcome').length
const settled = (runner: HostedRunner, n: number): Promise<unknown> => runner.waitFor(`outcome ${n}`, () => outcomes(runner) >= n, 60_000)
const facts = (runner: HostedRunner): Promise<unknown> => runner.peer.request('session/facts' as never, {} as never, { deadlineMs: 30_000 })
async function serversSettled(runner: HostedRunner): Promise<void> {
  for (let tries = 0; tries < 150; tries++) {
    const answer = (await facts(runner)) as { mcp?: Array<{ type?: string }> }
    if ((answer.mcp ?? []).length > 0 && (answer.mcp ?? []).every(row => row.type !== 'pending')) return
    await pause(200)
  }
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const CLOCK_KEYS = /^(?:ts|t|at|pid|port|load_per_core|available_mb)$|(?:Ms|_ms|At|_at|Duration|Seconds|_s|Time|Bytes)$/
const FIXED = new Set(['next_fire_ms', 'nextFireMs', 'streamIdleTimeoutMs', 'stream_idle_timeout_ms'])
const BUILD_KEYS = new Set(['build_tree', 'buildTree', 'build'])

function masked(recording: Recording, scratch: string): Recording {
  const ids = new Map<string, string>()
  const idOf = (uuid: string): string => {
    const key = uuid.toLowerCase()
    if (!ids.has(key)) ids.set(key, `<uuid ${ids.size + 1}>`)
    return ids.get(key)!
  }
  const roots = [...new Set([scratch, tmpdir(), realpathSync(tmpdir())])].filter(root => root !== '').sort((x, y) => y.length - x.length)
  const words = (text: string): string => {
    let out = text
    for (const root of roots) out = out.split(root).join(root === scratch ? '<scratch>' : '<tmp>')
    return out
      .split(TREE)
      .join('<tree>')
      .replace(/\/[A-Za-z0-9._/-]*?\/boot-recording-[A-Za-z0-9]+/g, '<scratch>')
      .replace(/projects\/-[A-Za-z0-9_-]+/g, 'projects/<slug>')
      .replace(UUID, idOf)
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<time>')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?\b/g, '<time>')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?\b/g, '<clock>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/\bpid \d+\b/g, 'pid <pid>')
      .replace(/\b1[6-9]\d{11}\b/g, '<ms>')
      .replace(/\b[0-9a-f]{40}\b/g, '<digest>')
  }
  const walk = (value: unknown, key = '', under = ''): unknown => {
    if (typeof value === 'string') return BUILD_KEYS.has(key) ? `<${key}>` : key === 'read' && under === 'memory' ? '<read>' : words(value)
    if (typeof value === 'number') return CLOCK_KEYS.test(key) && !FIXED.has(key) ? `<${key}>` : value
    if (Array.isArray(value)) return value.map(item => walk(item, key, under))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, key)]))
    return value
  }
  return walk(recording) as Recording
}

function differences(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (out.length >= 60) return out
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`)
    return out
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: one is a list and the other is not`)
    return out
  }
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])]
  for (const key of keys) differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`, out)
  return out
}

if (remask !== undefined) {
  const raw = JSON.parse(readFileSync(remask, 'utf8')) as Recording & { scratch: string }
  writeFileSync(argOf('--out') ?? remask.replace(/\.raw\.json$/, '.json'), JSON.stringify(masked({ wire: raw.wire, print: raw.print.map(({ phaseReport: _report, ...boot }) => boot) }, raw.scratch), null, 1) + '\n')
  process.exit(0)
}

const wire: WireBoot[] = []
const print: PrintBoot[] = []
const WORKER: Env = { MERCURY_CONCOURSE_WORKER: '1' }

section('§1 the wire runner boots: cold, resumed, continued, killed, restarted by the daemon, claimed warm, refused by the model, and a worker before its claim')
const w = world('w')
const cold = await wireBoot('cold', w, ['--model', FIXTURE_MODEL], {}, [handoffTurn(), { kind: 'text', text: 'First answer.' }], async ({ runner, quiet }) => {
  await facts(runner)
  await runner.prompt('say the first answer', { id: PROMPT_ID })
  await settled(runner, 1)
  await quiet()
})
wire.push(cold)
const sid = cold.sessionId ?? NO_SUCH
wire.push(
  await wireBoot('resumed', w, ['--model', FIXTURE_MODEL, '--resume', sid], {}, [handoffTurn(), { kind: 'text', text: 'Second answer.' }], async ({ runner, quiet }) => {
    await facts(runner)
    await runner.prompt('say the second answer')
    await settled(runner, 1)
    await quiet()
  }),
)
wire.push(
  await wireBoot('continued with the recorded model', w, ['--continue'], {}, [handoffTurn()], async ({ runner }) => {
    await facts(runner)
  }),
)
wire.push(
  await wireBoot(
    'killed in a turn',
    w,
    ['--model', FIXTURE_MODEL, '--resume', sid],
    {},
    [{ kind: 'hang', deltas: ['Thinking'] }],
    async ({ runner }) => {
      await runner.prompt('hang here')
      await runner.waitFor('the hanging turn has its first byte', row => row.type === 'wait' && row.state === 'done', 60_000)
    },
    { ends: 'kill' },
  ),
)
wire.push(
  await wireBoot('restarted by the daemon', w, ['--model', FIXTURE_MODEL, '--resume', sid], { ...WORKER, MERCURY_RUNNER_RESTART_REASON: 'crash' }, [handoffTurn(), { kind: 'text', text: 'Third answer.' }], async ({ runner, quiet }) => {
    await facts(runner)
    await runner.prompt('say the third answer')
    await settled(runner, 1)
    await quiet()
  }),
)
wire.push(
  await wireBoot('claimed warm with a resume', w, [], WORKER, [handoffTurn()], async ({ runner, quiet }) => {
    await runner.peer.request('session/claim' as never, { session_id: sid, resume: true, restart_reason: 'crash' } as never, { deadlineMs: 60_000 }).catch(() => undefined)
    await serversSettled(runner)
    await facts(runner)
    await quiet()
  }),
)
wire.push(
  await wireBoot('refused by the model', world('refused'), ['--model', REFUSED_MODEL], {}, [], async ({ runner, quiet }) => {
    await facts(runner)
    await runner.prompt('say anything')
    await settled(runner, 1).catch(() => undefined)
    await quiet()
  }),
)
wire.push(
  await wireBoot('a worker before its claim', world('worker'), [], WORKER, [handoffTurn(), { kind: 'text', text: 'Claimed answer.' }], async ({ runner, quiet }) => {
    await runner.peer.request('session/claim' as never, { session_id: CLAIMED, model: FIXTURE_MODEL, mode: 'implement', effort: 'high', title: 'the recorded boot' } as never, { deadlineMs: 60_000 }).catch(() => undefined)
    await serversSettled(runner)
    await facts(runner)
    await runner.prompt('say the claimed answer')
    await settled(runner, 1)
    await quiet()
  }),
)
const worker = wire.at(-1) as WireBoot & { sessionId: string | null }
const early = world('early')
const earlier = await wireBoot('the session the next boot resumes', early, ['--model', FIXTURE_MODEL], {}, [handoffTurn(), { kind: 'text', text: 'First answer.' }], async ({ runner, quiet }) => {
  await runner.prompt('say the first answer')
  await settled(runner, 1)
  await quiet()
})
const told = await wireBoot(
  'told of new credentials while it resumes',
  early,
  ['--model', FIXTURE_MODEL, '--resume', earlier.sessionId ?? NO_SUCH],
  {},
  [handoffTurn()],
  async ({ runner }) => {
    await facts(runner)
  },
  { first: runner => runner.peer.notify('credentials/changed' as never, {} as never), logFile: join(parent, 'early', 'debug.txt') },
)
wire.push(told)
check('each wire boot answered initialize and ended', wire.every(boot => typeof boot.exit !== 'string' || boot.exit === 'killed'), wire.map(boot => `${boot.name}: ${boot.exit}`).join(' · ') + ' — a boot whose exit is a string other than killed did not answer initialize or did not end when stopped: read the boot steps under src/daemon/runner/boot/')
check('the cold boot carries a session and the worker carries none before its claim', cold.sessionId !== null && worker.sessionId === null, `cold: ${cold.sessionId}, worker: ${worker.sessionId} — the cold boot must answer initialize with a session_id and a MERCURY_CONCOURSE_WORKER boot must answer none until session/claim: see src/daemon/runner-wire/sessionVerbs.ts`)
check('a runner told of new credentials while it resumes a session takes them when it has booted: its debug log holds no notification that failed or was dropped', told.notifications !== undefined && told.notifications.failed === 0 && told.notifications.dropped === 0, JSON.stringify(told.notifications) + ' — the credentials/changed handler is in src/daemon/runner/runnerArms.ts and src/daemon/runner-wire/peer.ts logs each notification that failed or was dropped: read the debug log of the told boot')
check('the killed boot ended by its signal and every other boot by its own exit', wire.every(boot => (boot.name === 'killed in a turn') === (boot.exit === 'killed')), wire.map(boot => `${boot.name}: ${boot.exit}`).join(' · ') + ' — only the killed boot may read killed; any other boot that died by a signal ended without its own exit, so read its stderr in the recording')

section('§2 the print runner boots: the six it refuses, the session kinds, a rewind, a fork, and two whose phases are read')
const said: ScriptedTurn[] = [{ kind: 'text', text: 'DONE.' }]
print.push(await printBoot('--replay-to without --resume', world('p1'), ['--replay-to', NO_SUCH, 'hi'], {}, []))
print.push(await printBoot('--restore-files without --resume', world('p2'), ['--restore-files', NO_SUCH, 'hi'], {}, []))
print.push(await printBoot('--restore-files with a prompt', w, ['--resume', sid, '--restore-files', PROMPT_ID, 'hi'], {}, []))
print.push(await printBoot('--restore-files to a message nothing carries', w, ['--resume', sid, '--restore-files', NO_SUCH], {}, []))
print.push(await printBoot('--restore-files to the first prompt', w, ['--resume', sid, '--restore-files', PROMPT_ID], {}, []))
for (const format of ['text', 'json', 'rows']) print.push(await printBoot(`no prompt, ${format}`, world(`p6-${format}`), ['--format', format], {}, []))
for (const format of ['text', 'rows']) print.push(await printBoot(`an empty prompt on stdin, ${format}`, world(`p6-stdin-${format}`), ['--format', format, '-'], {}, []))
for (const format of ['text', 'rows']) print.push(await printBoot(`--resume of a session nothing recorded, ${format}`, world(`p7-${format}`), ['--format', format, '--model', FIXTURE_MODEL, '--resume', NO_SUCH, 'hi'], {}, said))
print.push(await printBoot('--continue with nothing to continue', world('p8'), ['--format', 'rows', '--model', FIXTURE_MODEL, '--continue', 'hi'], {}, said))
print.push(await printBoot('a session kind that is none', world('p9'), ['--model', FIXTURE_MODEL, 'hi'], { MERCURY_SESSION_KIND: 'bogus' }, said))
print.push(await printBoot('the oculus kind with no host', world('p10'), ['--model', FIXTURE_MODEL, 'hi'], { MERCURY_SESSION_KIND: 'oculus' }, said))
print.push(await printBoot('a model no provider serves, with a title', world('p11'), ['--format', 'rows', '--title', 'a titled run', '--model', REFUSED_MODEL, 'hi'], {}, []))
print.push(await printBoot('a cold run whose phases are read', world('p12'), ['--format', 'rows', '--title', 'a titled run', '--model', FIXTURE_MODEL, 'hi'], {}, said, join(parent, 'p12', 'debug.txt')))
print.push(await printBoot('a continued run whose phases are read', w, ['--format', 'rows', '--model', FIXTURE_MODEL, '--continue', 'again'], {}, said, join(parent, 'w', 'debug.txt')))
print.push(await printBoot('a fork of the resumed session', w, ['--format', 'rows', '--model', FIXTURE_MODEL, '--fork', '--resume', sid, 'forked'], {}, said))
for (const format of ['text', 'json', 'rows']) print.push(await printBoot(`a worker with no session on the rows door, ${format}`, world(`p13-${format}`), ['--format', format, '--model', FIXTURE_MODEL, 'hi'], WORKER, said))
const refusedBoots = print.filter(boot => /^(?:--replay-to without|--restore-files without|--restore-files with a prompt|--restore-files to a message nothing|no prompt|an empty prompt)/.test(boot.name))
check('each print boot ended with an exit code', print.every(boot => boot.status !== null), print.map(boot => `${boot.name}: ${boot.status}`).join(' · ') + ' — a null status means the run never closed or was ended at the 120 s ceiling: run the named boot by hand with `node dist/mercury.mjs run` and read its stderr')
check('the boots the runner refuses for their options or their prompt exit 1 or 2 with one line', refusedBoots.length === 9 && refusedBoots.every(boot => (boot.status === 1 || boot.status === 2) && boot.stdout.length + boot.stderr.length === 1), refusedBoots.map(boot => `${boot.name}: ${boot.status}, ${boot.stdout.length} + ${boot.stderr.length} lines`).join(' · ') + ' — each refusal must write one line and exit 1 or 2: see src/daemon/runner/boot/refuseBadOptions.ts and refuseEmptyPrompt.ts')
const unclaimable = print.filter(boot => boot.name.startsWith('a worker with no session on the rows door'))
check('a worker with no session on the rows door is refused at the boot: exit 2, nothing on stdout, and one sentence on stderr that names the claim it waits for', unclaimable.length === 3 && unclaimable.every(boot => boot.status === 2 && boot.stdout.length === 0 && boot.stderr.length === 1 && String(boot.stderr[0]).includes('session/claim')), unclaimable.map(boot => `${boot.name}: ${boot.status}, ${boot.stdout.length} + ${boot.stderr.length} lines`).join(' · ') + ' — the refusal is src/daemon/runner/boot/refuseClaimlessRowsDoor.ts: it must exit 2 with one stderr sentence naming session/claim')
const phased = print.filter(boot => boot.name.endsWith('whose phases are read'))
check(`the two runs whose phases are read stamp ${BOOT_PHASES.join(', ')} in that order by their clocks`, phased.length === 2 && phased.every(boot => JSON.stringify(boot.phases) === JSON.stringify(BOOT_PHASES)), phased.map(boot => `${boot.name}: ${JSON.stringify(boot.phases)}`).join(' · ') + ' — each phase is stamped by noteRunPhase (src/platform/logs/runPhases.ts) in a boot step under src/daemon/runner/boot/, and the [run-phases] line is written at close in src/daemon/runner/runnerDriver.ts and printRunEnd.ts')

const recording = masked({ wire, print: print.map(({ phaseReport: _report, ...boot }) => boot) }, parent)
const out = argOf('--out')
if (out !== undefined) {
  writeFileSync(out, JSON.stringify(recording, null, 1) + '\n')
  console.log(`  wrote ${out}`)
}
const raw = argOf('--raw')
if (raw !== undefined) writeFileSync(raw, JSON.stringify({ scratch: parent, wire, print }, null, 1) + '\n')
const against = argOf('--against')
if (against !== undefined) {
  section(`§3 the recording against ${against}`)
  const diffs = differences(JSON.parse(readFileSync(against, 'utf8')), JSON.parse(JSON.stringify(recording)))
  check('the recording equals the other, field for field, with clocks, ids, pids and scratch paths masked', diffs.length === 0, `${diffs.length} difference${diffs.length === 1 ? '' : 's'}:\n      ${diffs.join('\n      ')}\n      a field that moved is a change in what that boot prints: if it is intended, write the new recording with --out; if not, undo the change in the code that boot runs`)
}
try {
  removeScratch(parent)
} catch (error) {
  console.log(`  the scratch stays at ${parent}: ${(error as Error).message}`)
}

console.log(failures === 0 ? '\nprove-runner-boot-recording: green' : `\nprove-runner-boot-recording: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
