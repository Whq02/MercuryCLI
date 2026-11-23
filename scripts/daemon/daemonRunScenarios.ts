#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { copyDistChunks } from '../lib/copyDistChunks.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const WIN = process.platform === 'win32'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const UNKNOWN_SESSION = '00000000-0000-4000-8000-000000000000'
const UNORDERED = ['boot process census', '[daemon] hello from client', '[daemon] seat idle edge: ']
const CLOCK = String.raw`if (process.argv.includes('daemon') && process.argv.includes('run') && process.env.DMR_CLOCK) {
  const fs = require('fs')
  const net = require('net')
  const path = require('path')
  const writeSync = fs.writeSync
  const readFileSync = fs.readFileSync
  const say = line => {
    try {
      writeSync(2, '[daemon] clock: ' + line + '\n')
    } catch {}
  }
  const PLANE = /^(?:daemon\.json|control\.key|daemon\.lock|control\.sock(?:\.\d+)?)$/
  const named = at => (typeof at === 'string' && PLANE.test(path.basename(at)) ? path.basename(at) : null)
  let ticking = false
  const holds = process.env.DMR_CLOCK_HOLDS
  let held = false
  let letGo = null
  const wrap = (holder, fn, at, changes) => {
    const real = holder[fn]
    if (typeof real !== 'function') return
    const wrapped = function (...args) {
      const target = args[at]
      const run = () => {
        if (ticking && typeof target === 'string') say('  ' + fn + ' ' + target.replace(/\.\d+\.[0-9a-f]+\.tmp$/, '.<n>.tmp'))
        else if (changes && named(target) !== null) say(fn + ' ' + named(target) + (fn.startsWith('open') ? ' ' + String(args[1] === undefined ? 'r' : args[1]) : ''))
        return real.apply(this, args)
      }
      if (holds === undefined || held || fn + ' ' + named(target) !== holds) return run()
      held = true
      say('held at ' + holds)
      return new Promise(release => {
        letGo = release
      }).then(run)
    }
    holder[fn] = Object.assign(wrapped, real)
  }
  for (const fn of ['existsSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'accessSync', 'readlinkSync']) wrap(fs, fn, 0, false)
  for (const fn of ['writeFileSync', 'unlinkSync', 'rmSync', 'openSync']) wrap(fs, fn, 0, true)
  for (const fn of ['renameSync', 'linkSync', 'symlinkSync']) wrap(fs, fn, 1, true)
  for (const fn of ['writeFile', 'unlink', 'rm', 'open']) wrap(fs.promises, fn, 0, true)
  for (const fn of ['rename', 'link', 'symlink']) wrap(fs.promises, fn, 1, true)
  const watch = fs.watch
  fs.watch = function (...args) {
    say('a watch on ' + String(args[0]))
    return watch.apply(this, args)
  }
  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    const at = typeof args[0] === 'string' ? args[0] : args[0] && typeof args[0] === 'object' ? args[0].path : undefined
    if (typeof at === 'string') say('a server listens on ' + path.basename(at))
    return listen.apply(this, args)
  }
  require('module').syncBuiltinESMExports()
  const every = ms => ms / 1000 + 's'
  const rows = []
  const rowOf = new Map()
  const arm = globalThis.setInterval
  const clear = globalThis.clearInterval
  const clearOnce = globalThis.clearTimeout
  globalThis.setInterval = function (work, ms, ...rest) {
    if (process.env.DMR_CLOCK_REFUSES === String(ms)) {
      say('an interval every ' + every(ms) + ' is refused')
      throw new Error('the clock of the recording refused an interval every ' + every(ms))
    }
    const row = { n: rows.length + 1, ms, work: () => work(...rest), stopped: false }
    const timer = arm(() => {}, 2147483647)
    rows.push(row)
    rowOf.set(timer, row)
    say('interval #' + row.n + ' armed, every ' + every(ms))
    const unref = timer.unref.bind(timer)
    timer.unref = () => {
      say('interval #' + row.n + ' does not hold the process')
      unref()
      return timer
    }
    return timer
  }
  const stop = real =>
    function (timer) {
      const row = rowOf.get(timer)
      if (row !== undefined && !row.stopped) {
        row.stopped = true
        say('interval #' + row.n + ' stopped')
      }
      return real.call(this, timer)
    }
  globalThis.clearInterval = stop(clear)
  globalThis.clearTimeout = stop(clearOnce)
  process.on('SIGUSR2', () => {
    let order = ''
    try {
      order = readFileSync(process.env.DMR_CLOCK, 'utf8').trim()
    } catch {}
    if (order === 'go' && letGo !== null) {
      say('held no longer')
      const release = letGo
      letGo = null
      return release()
    }
    const asked = /^tick (\d+)$/.exec(order)
    const row = asked === null ? undefined : rows[Number(asked[1]) - 1]
    if (row === undefined) return say('no interval answers the order "' + order + '"')
    if (row.stopped) return say('interval #' + row.n + ' is stopped and does not tick')
    say('tick of #' + row.n + ', every ' + every(row.ms))
    ticking = true
    try {
      row.work()
    } catch (error) {
      say('  the tick threw: ' + (error && error.message))
    } finally {
      ticking = false
    }
    say('tick of #' + row.n + ' returned')
  })
}
`
const DEAD_ENV = ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_DAEMON_CONTROL', 'MERCURY_DAEMON_CONTROL_DISABLED', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_CONCOURSE_WORKER', 'NODE_ENV', 'NODE_OPTIONS']

type Reply = Record<string, unknown>
type Exit = { code: number | null; signal: string | null }
type Daemon = { label: string; pid: number; child: ChildProcess; logPath: string; exit: Exit | null }
type Session = { sid: string; runnerId: string; pid: number }
type BootOptions = { extra?: Record<string, string | undefined>; dist?: string; wait?: 'serve' | 'exit' | 'none'; waitMs?: number }
type Covers = { verbs?: string[]; doors?: string[]; periodic?: string[]; waysOut?: string[]; boot?: string[] }
export type Scenario = { name: string; about: string; covers: Covers; seconds: number; run: (w: World) => Promise<void> }

class World {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly daemonDir: string
  readonly dist: string
  readonly node: string
  readonly daemons: Daemon[] = []
  private readonly lines: string[] = []
  private readonly literals: Array<[string, string]> = []
  private readonly pids = new Map<number, string>()
  private readonly others: ChildProcess[] = []
  private readonly strays = new Set<number>()
  private rpcDoor: ((request: never, opts?: { timeoutMs?: number; protoRetry?: boolean }) => Promise<Reply>) | null = null
  private proto = 0

  constructor(dist: string) {
    this.dist = realpathSync(dist)
    const vendored = join(this.dist, 'vendor', 'node', ...(WIN ? ['node.exe'] : ['bin', 'node']))
    this.node = existsSync(vendored) ? vendored : 'node'
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'dmr-')))
    this.home = join(this.root, 'h')
    this.work = join(this.root, 'w')
    this.daemonDir = join(this.home, 'daemon')
    for (const dir of [this.home, this.work, join(this.home, 'runtime')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(this.work, 'README.md'), '# the recorded daemon works here\n')
    symlinkSync(this.dist, join(this.home, 'runtime', 'current'))
    seedFirstRun(this.home, [this.work])
    for (const key of DEAD_ENV) delete process.env[key]
    Object.assign(process.env, {
      HOME: this.home,
      MERCURY_CONFIG_DIR: this.home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      OPENAI_API_KEY: '',
      MERCURY_DAEMON_NO_SELF_WARM: '1',
      MERCURY_WARM_RUNNER: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
      BROWSER: '/usr/bin/true',
    })
    this.literal(this.root, '<world>')
    this.pid(process.pid, 'recorder')
    this.literal(this.dist, '<dist>')
    this.literal(this.node, '<node>')
    const tree = (() => {
      try {
        return String((JSON.parse(read(join(this.dist, 'manifest.json'))) as { buildTree?: unknown }).buildTree ?? '')
      } catch {
        return ''
      }
    })()
    if (tree.length >= 12) {
      this.literal(tree, '<tree>')
      this.literal(tree.slice(0, 12), '<tree>')
    }
  }

  literal(value: string, token: string): void {
    if (value !== '' && !this.literals.some(([known]) => known === value)) this.literals.push([value, token])
  }

  pid(pid: number, token: string): void {
    if (pid > 0 && !this.pids.has(pid)) this.pids.set(pid, `<pid:${token}>`)
  }

  mask(text: string): string {
    let out = text
    for (const [value, token] of [...this.literals].sort((a, b) => b[0].length - a[0].length)) out = out.split(value).join(token)
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<iso>')
    out = out.replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}\b/g, '<start>')
    out = out.replace(/\b\d{14}\.\d{6}[+-]\d{3}\b/g, '<start>')
    out = out.replace(/"procStart":"\d+"/g, '"procStart":"<start>"')
    out = out.replace(/(?<![\d.])1[6-9]\d{11}(?![\d])/g, '<ms>')
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    for (const [pid, token] of [...this.pids].sort((a, b) => String(b[0]).length - String(a[0]).length)) out = out.replace(new RegExp(`(?<![\\d.])${pid}(?![\\d])`, 'g'), token)
    out = out.replace(/\bpid (\d+)/g, 'pid <pid>')
    out = out.replace(/"(pid|ownerPid|predecessorPid)":(\d+)/g, '"$1":"<pid>"')
    out = out.replace(/"uptimeSec":\d+/g, '"uptimeSec":"<n>"')
    out = out.replace(/control\.sock\.\d+/g, 'control.sock.<pid>')
    out = out.replace(/came back unchanged \d+s ago/g, 'came back unchanged <n>s ago')
    out = out.replace(/boot process census: \d+ Mercury process\(es\) read, \d+ stale/g, 'boot process census: <n> Mercury process(es) read, <n> stale')
    out = out.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
    out = out.replace(/\b\d+(?:\.\d+)? ?ms\b/g, '<n>ms')
    out = out.replace(/answered initialize after \d+ s/g, 'answered initialize after <n> s')
    out = out.replace(/ · up \d+[smhd][^·\n]*/g, ' · up <span>')
    out = out.replace(/empty and idle for [^(—"]+/g, 'empty and idle for <span> ')
    out = out.replace(/empty but idle only [^"]+/g, 'empty but idle only <span>')
    return out
  }

  say(line: string): void {
    this.lines.push(line)
  }

  note(label: string, value: unknown): void {
    this.say(`# ${label}: ${this.mask(typeof value === 'string' ? value : JSON.stringify(value))}`)
  }

  async call(request: Reply, timeoutMs = 15_000): Promise<Reply> {
    if (this.rpcDoor === null) {
      ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
      const control = await import('../../src/daemon/controlSocket.ts')
      this.proto = (await import('../../src/daemon/protocol.ts')).MERCURY_DAEMON_PROTO
      this.rpcDoor = control.daemonControlRpc as never
    }
    try {
      return await this.rpcDoor!(request as never, { timeoutMs })
    } catch (error) {
      return { ok: false, thrown: String(error) }
    }
  }

  hello(): Promise<Reply> {
    return this.call({ op: 'hello', proto: this.proto || undefined, clientVersion: '1.0.0', clientBuildTree: null }, 3000)
  }

  async rpc(label: string, request: Reply, timeoutMs = 15_000): Promise<Reply> {
    const reply = await this.call(request, timeoutMs)
    this.say(`> ${label}`)
    this.say(`< ${this.mask(JSON.stringify(reply))}`)
    return reply
  }

  async until(what: string, test: () => boolean | Promise<boolean>, ms = 30_000, every = 50): Promise<boolean> {
    const deadline = Date.now() + ms
    for (;;) {
      try {
        if (await test()) return true
      } catch {}
      if (Date.now() >= deadline) break
      await sleep(every)
    }
    this.say(`! not reached within ${ms / 1000}s: ${what}`)
    return false
  }

  env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_DAEMON_PERSIST: '1', ...extra }
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
    return env
  }

  async boot(label: string, opts: BootOptions = {}): Promise<Daemon> {
    const logPath = join(this.root, `${label}.log`)
    const log = openSync(logPath, 'a')
    const child = spawn(this.node, [join(opts.dist ?? this.dist, 'mercury.mjs'), 'daemon', 'run', this.work, '--log-stderr'], { cwd: this.work, env: this.env(opts.extra), stdio: ['ignore', log, log] })
    const daemon: Daemon = { label, pid: child.pid ?? 0, child, logPath, exit: null }
    child.once('exit', (code, signal) => {
      daemon.exit = { code, signal }
    })
    this.daemons.push(daemon)
    this.pid(daemon.pid, label)
    this.say(`> boot ${label}${opts.extra ? ` ${this.mask(JSON.stringify(opts.extra))}` : ''}`)
    const wait = opts.wait ?? 'serve'
    if (wait === 'serve') {
      await this.until(`${label} serves`, async () => {
        if (daemon.exit !== null) return true
        const h = await this.hello()
        return h.ok === true && h.pid === daemon.pid && h.ready === true
      }, opts.waitMs ?? 60_000)
      if (daemon.exit !== null) this.say(`! ${label} left before it served: ${JSON.stringify(daemon.exit)}`)
    } else if (wait === 'exit') await this.left(daemon, opts.waitMs ?? 60_000)
    return daemon
  }

  logOf(daemon: Daemon): string {
    return read(daemon.logPath)
  }

  logged(daemon: Daemon, pattern: RegExp, ms = 30_000): Promise<boolean> {
    return this.until(`${daemon.label} logs ${pattern}`, () => pattern.test(this.logOf(daemon)), ms)
  }

  async left(daemon: Daemon, ms = 30_000): Promise<void> {
    await this.until(`${daemon.label} leaves`, () => daemon.exit !== null, ms)
    this.say(`= ${daemon.label} left: ${daemon.exit === null ? 'still running' : `code ${daemon.exit.code} signal ${daemon.exit.signal}`}`)
  }

  signal(daemon: Daemon, signal: NodeJS.Signals): void {
    this.say(`> ${signal} to ${daemon.label}`)
    try {
      process.kill(daemon.pid, signal)
    } catch {}
  }

  clock(refuses?: number, holds?: string): Record<string, string> {
    const preload = join(this.root, 'clock.cjs')
    if (!existsSync(preload)) writeFileSync(preload, CLOCK)
    return { NODE_OPTIONS: `--require ${preload}`, DMR_CLOCK: join(this.root, 'clock.order'), ...(refuses === undefined ? {} : { DMR_CLOCK_REFUSES: String(refuses) }), ...(holds === undefined ? {} : { DMR_CLOCK_HOLDS: holds }) }
  }

  async goOn(daemon: Daemon): Promise<void> {
    writeFileSync(join(this.root, 'clock.order'), 'go\n')
    this.say(`> ${daemon.label} is held no longer`)
    try {
      process.kill(daemon.pid, 'SIGUSR2')
    } catch {}
    await this.until(`${daemon.label} goes on`, () => this.logOf(daemon).includes('clock: held no longer'), 15_000)
  }

  window(label: string): { said: () => string } {
    const script = join(this.root, `${label}.ts`)
    const lines = [
      ';(globalThis as Record<string, unknown>).MACRO ??= { VERSION: \'1.0.0\' }',
      `process.argv[1] = ${JSON.stringify(join(this.dist, 'mercury.mjs'))}`,
      `try {\n  Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(this.node)}, configurable: true, writable: true })\n} catch {\n  process.execPath = ${JSON.stringify(this.node)}\n}`,
      `if (process.execPath !== ${JSON.stringify(this.node)}) console.log('the window could not take the node of the build: it runs ' + process.execPath)`,
      `const { ensureOwnedDaemon } = await import(${JSON.stringify(join(ROOT, 'src/services/switchboard/ensureDaemon.ts'))})`,
      "console.log('the window asks for its daemon')",
      'const usable = await ensureOwnedDaemon()',
      "console.log('the daemon of the window is usable: ' + usable)",
      'setInterval(() => {}, 1 << 30)',
    ]
    writeFileSync(script, lines.join('\n') + '\n')
    const child = spawn(process.execPath, [script], { cwd: this.work, env: this.env({ MERCURY_DAEMON_PERSIST: undefined }), stdio: ['ignore', 'pipe', 'inherit'] })
    this.others.push(child)
    this.pid(child.pid ?? 0, label)
    let said = ''
    child.stdout?.on('data', data => (said += String(data)))
    this.say(`> ${label} opens: it asks for its daemon as a window does`)
    return { said: () => said }
  }

  async direct(label: string, daemon: Daemon, request: Reply, timeoutMs = 10_000): Promise<Reply> {
    ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
    const { forwardFrame, predecessorSockPath } = await import('../../src/daemon/handover.ts')
    let reply: Reply
    try {
      reply = (await forwardFrame(predecessorSockPath(daemon.pid), JSON.stringify(request), timeoutMs)) as Reply
    } catch (error) {
      reply = { ok: false, thrown: String(error) }
    }
    this.say(`> ${label}`)
    this.say(`< ${this.mask(JSON.stringify(reply))}`)
    return reply
  }

  armed(daemon: Daemon): number {
    return this.logOf(daemon).split('clock: interval #').filter(rest => /^\d+ armed/.test(rest)).length
  }

  async tick(daemon: Daemon, n: number): Promise<void> {
    const returned = `clock: tick of #${n} returned`
    const before = this.logOf(daemon).split(returned).length
    writeFileSync(join(this.root, 'clock.order'), `tick ${n}\n`)
    this.say(`> tick of interval #${n} of ${daemon.label}`)
    try {
      process.kill(daemon.pid, 'SIGUSR2')
    } catch {}
    await this.until(`interval #${n} of ${daemon.label} ticked`, () => this.logOf(daemon).split(returned).length > before, 15_000)
  }

  async cli(label: string, args: string[], dist?: string): Promise<{ code: number | null; text: string }> {
    const child = spawn(this.node, [join(dist ?? this.dist, 'mercury.mjs'), ...args], { cwd: this.work, env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => (text += String(data)))
    const code = await new Promise<number | null>(done => child.once('close', done))
    this.say(`> ${label}`)
    this.say(`< code ${code}`)
    for (const line of text.split('\n').filter(l => l.trim() !== '')) this.say(`< ${this.mask(line)}`)
    return { code, text }
  }

  files(label: string): void {
    const names = existsSync(this.daemonDir) ? readdirSync(this.daemonDir).map(name => this.mask(name)).sort() : ['(the daemon folder is gone)']
    this.say(`@ ${label}: ${names.join(' ')}`)
    for (const name of ['daemon.json', 'daemon.lock']) {
      const text = read(join(this.daemonDir, name))
      if (text !== '') this.say(`@ ${label} ${name}: ${this.mask(text.replace(/\s+/g, ' ').trim())}`)
    }
    const ledger = read(join(this.daemonDir, 'spawn-ledger.jsonl'))
    for (const row of ledger.split('\n').filter(Boolean)) if (!/"event":"exit","id":"[^"]*@concourse"/.test(row)) this.say(`@ ${label} spawn-ledger: ${this.mask(row)}`)
  }

  workers(): Array<{ runnerId: string; sessionId: string; pid?: number; endedAt?: number; stoppedAt?: number; parkedAt?: number; lastDeliveryAt?: number; lastTurnSettledAt?: number }> {
    try {
      return Object.values((JSON.parse(read(join(this.daemonDir, 'concourse-workers.json'))) as { workers: Record<string, { runnerId: string; sessionId: string; pid?: number }> }).workers)
    } catch {
      return []
    }
  }

  record(sid: string): { runnerId: string; sessionId: string; pid?: number; endedAt?: number; stoppedAt?: number; parkedAt?: number; lastDeliveryAt?: number; lastTurnSettledAt?: number } | undefined {
    return this.workers().find(r => r.sessionId === sid)
  }

  async admit(label: string): Promise<Session> {
    const before = this.initializations()
    const reply = await this.call({ op: 'sessionAdmit', workspaceDir: this.work, birthKey: randomUUID(), isolation: 'shared', bornBlank: true }, 60_000)
    const sid = String(reply.sessionId ?? '')
    if (sid !== '') this.literal(sid, `<sid:${label}>`)
    await this.until(`${label} has a live runner`, () => {
      const rec = this.record(sid)
      return rec?.pid !== undefined && alive(rec.pid)
    }, 60_000)
    const rec = this.record(sid)
    const session = { sid, runnerId: rec?.runnerId ?? String(reply.runnerId ?? ''), pid: rec?.pid ?? 0 }
    this.pid(session.pid, `runner:${label}`)
    await this.until(`${label} reads idle`, () => {
      try {
        return (JSON.parse(read(join(this.daemonDir, 'session-facts', `${sid}.json`))) as { busy?: boolean }).busy === false
      } catch {
        return false
      }
    }, 60_000)
    await this.initialized(before)
    this.say(`> admit ${label}`)
    this.say(`< ${this.mask(JSON.stringify(reply))}`)
    return session
  }

  initializations(): number {
    return this.daemons.reduce((n, d) => n + this.logOf(d).split(': the runner answered initialize').length - 1, 0)
  }

  initialized(from: number): Promise<boolean> {
    return this.until('a runner answers initialize', () => this.initializations() > from, 60_000)
  }

  said(words: string): number {
    return this.daemons.reduce((n, d) => n + this.logOf(d).split(words).length - 1, 0)
  }

  saidPast(words: string, from: number): Promise<boolean> {
    return this.until(`the log says "${words}" again`, () => this.said(words) > from, 60_000)
  }

  control(label: string, session: string, action: string, extra: Reply = {}): Promise<Reply> {
    return this.rpc(label, { op: 'sessionControl', action, sessionId: session, by: 'recorder', ...extra }, 30_000)
  }

  async gone(label: string, sid: string, pid: number, how: 'parkedAt' | 'stoppedAt'): Promise<void> {
    await this.until(`${label} reads ${how === 'parkedAt' ? 'parked' : 'stopped'} and its runner is gone`, () => {
      const rec = this.record(sid)
      return rec?.[how] !== undefined && !alive(pid) && (rec.pid === undefined || !alive(rec.pid))
    }, 30_000)
  }

  holder(label: string, script?: string): ChildProcess {
    const child = script === undefined ? spawn(this.node, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' }) : spawn(process.execPath, [script], { cwd: ROOT, env: this.env(), stdio: ['ignore', 'pipe', 'inherit'] })
    this.others.push(child)
    this.pid(child.pid ?? 0, label)
    return child
  }

  async lockHolder(label: string): Promise<ChildProcess> {
    const script = join(this.root, `${label}.ts`)
    writeFileSync(script, `;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }\nconst { acquireDaemonLock } = await import(${JSON.stringify(join(ROOT, 'src/daemon/controlSocket.ts'))})\nconst lock = await acquireDaemonLock()\nconsole.log(lock === null ? 'refused' : 'held')\nsetInterval(() => {}, 1 << 30)\n`)
    const child = this.holder(label, script)
    let said = ''
    child.stdout?.on('data', data => (said += String(data)))
    await this.until(`${label} holds the daemon lock`, () => said.includes('held') || said.includes('refused'), 30_000)
    this.say(`> ${label} takes the daemon lock: ${said.trim()}`)
    return child
  }

  async end(child: ChildProcess, label: string): Promise<void> {
    const pid = child.pid ?? 0
    try {
      child.kill('SIGKILL')
    } catch {}
    await this.until(`${label} is gone`, () => !alive(pid), 10_000)
    this.say(`> ${label} ended`)
  }

  payload(name: string): string {
    const dir = join(this.root, name)
    if (existsSync(dir)) return dir
    mkdirSync(dir)
    copyDistChunks(this.dist, dir)
    const manifest = JSON.parse(read(join(this.dist, 'manifest.json'))) as Record<string, unknown>
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, buildTree: name.repeat(12) }))
    return dir
  }

  deploy(dir: string): void {
    rmSync(join(this.home, 'runtime', 'current'), { force: true })
    symlinkSync(dir, join(this.home, 'runtime', 'current'))
    this.say(`> deploy ${this.mask(dir)}`)
  }

  stray(pid: unknown): void {
    if (typeof pid === 'number' && pid > 0 && !this.daemons.some(d => d.pid === pid)) {
      this.strays.add(pid)
      this.pid(pid, `successor${this.strays.size}`)
    }
  }

  killAll(): void {
    const pids = [...this.daemons.map(d => d.pid), ...this.strays, ...this.workers().flatMap(rec => (rec.pid === undefined ? [] : [rec.pid])), ...this.others.flatMap(child => (child.pid === undefined ? [] : [child.pid]))]
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }

  async successor(of: Daemon, ms = 30_000): Promise<number> {
    let pid = 0
    await this.until(`a successor of ${of.label} serves`, async () => {
      const h = await this.hello()
      if (h.ok === true && typeof h.pid === 'number' && h.pid !== of.pid && h.ready === true) {
        pid = h.pid
        return true
      }
      return false
    }, ms)
    this.stray(pid)
    return pid
  }

  async finish(): Promise<string> {
    for (const daemon of this.daemons) {
      if (daemon.exit !== null) continue
      await this.call({ op: 'shutdown', reapWorkers: true }, 5000)
      const deadline = Date.now() + 10_000
      while (daemon.exit === null && Date.now() < deadline) await sleep(50)
      if (daemon.exit === null) {
        this.say(`! ${daemon.label} was still running at the end and was killed`)
        try {
          process.kill(daemon.pid, 'SIGKILL')
        } catch {}
      }
    }
    for (const pid of this.strays) {
      if (!alive(pid)) continue
      await this.call({ op: 'shutdown', reapWorkers: true }, 5000)
      const deadline = Date.now() + 10_000
      while (alive(pid) && Date.now() < deadline) await sleep(50)
      if (alive(pid)) {
        this.say(`! the successor pid ${pid} was still running at the end and was killed`)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
    for (const rec of this.workers()) {
      if (rec.pid !== undefined && alive(rec.pid)) {
        const deadline = Date.now() + 8000
        while (alive(rec.pid) && Date.now() < deadline) await sleep(50)
        if (alive(rec.pid)) {
          try {
            process.kill(rec.pid, 'SIGKILL')
          } catch {}
        }
      }
    }
    for (const child of this.others) {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    const out = [...this.lines]
    for (const daemon of this.daemons) {
      out.push(`--- the log of ${daemon.label}`)
      let last = ''
      for (const line of this.logOf(daemon).split('\n')) {
        if (!line.includes('[daemon]') && !line.includes('[mercury-daemon]')) continue
        if (UNORDERED.some(words => line.includes(words))) continue
        const said = this.mask(line).replace(/^<iso> /, '')
        if (said === last) {
          if (!out.at(-1)!.endsWith(' (said again)')) out[out.length - 1] = `${said} (said again)`
          continue
        }
        last = said
        out.push(said)
      }
    }
    return out.join('\n') + '\n'
  }

  drop(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

const VERBS: Array<[string, Reply]> = [
  ['answer-permission', {}],
  ['answer-permission', { requestId: 'request-nobody-asked', allow: true }],
  ['set-title', { title: 'the recorded title', titleSource: 'operator' }],
  ['set-schedule', {}],
  ['set-schedule', { scheduleEdit: { op: 'remove', scheduleId: 'deadbeef' } }],
  ['mcp-action', { mcpAction: { name: 'nothing', action: 'reconnect' } }],
  ['mcp-tools', { mcpServer: 'nothing' }],
  ['set-kit', {}],
  ['set-kit', { kitEdit: { mcp: [{ name: 'nothing', on: false }] } }],
  ['set-model', {}],
  ['set-effort', {}],
  ['set-effort', { effort: 'high' }],
  ['set-spawn-switch', {}],
  ['set-spawn-switch', { spawnSwitch: { kind: 'workflows', on: true } }],
  ['set-spawn-switch', { spawnSwitch: { kind: 'subagents', on: false } }],
  ['set-permission-mode', {}],
  ['set-permission-mode', { mode: 'plan' }],
  ['session-facts', {}],
  ['focus', {}],
  ['blur', {}],
  ['stop-agent', {}],
  ['stop-agent', { agentId: 'agent-nobody' }],
  ['resume-agent', { agentId: 'agent-nobody', note: 'go on' }],
  ['withdraw-send', {}],
  ['withdraw-send', { clientMessageId: 'message-nobody-sent' }],
  ['background-shell', {}],
  ['send-now', {}],
  ['board-post', { boardPost: { clientOpId: 'post-1', channel: 'general', text: 'the recorded post' } }],
  ['pause-gate', {}],
  ['pause-gate', { paused: true }],
  ['pause-gate', { paused: false }],
]
const LATER_VERBS: Array<[string, Reply]> = [
  ['pause', {}],
  ['resume', {}],
  ['interrupt', { clientOpId: 'interrupt-1' }],
  ['interrupt', { clientOpId: 'interrupt-1' }],
  ['interrupt', { hard: true }],
  ['grant-workflows', {}],
  ['revoke-workflows', {}],
]

async function verbsOn(w: World, who: string, sid: string, verbs: Array<[string, Reply]> = [...VERBS, ...LATER_VERBS]): Promise<void> {
  for (const [action, extra] of verbs) await w.control(`${action} ${JSON.stringify(extra)} on ${who}`, sid, action, extra)
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'boot-hello-stop',
    about: 'a boot, a hello, every door that needs no session, `mercury daemon status` and `mercury daemon stop`',
    seconds: 8,
    covers: { boot: ['serve'], doors: ['hello', 'concourseList', 'signIns', 'processSweep facts', 'warmRunnerCount', 'isReady', 'onShutdown'], waysOut: ['control:shutdown'] },
    run: async w => {
      const d = await w.boot('d1')
      await w.rpc('hello', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      for (const op of ['ping', 'status', 'list', 'leases', 'sessionList', 'signIns']) await w.rpc(op, { op })
      await w.rpc('has', { op: 'has', short: 'nobody' })
      await w.rpc('processSweep facts', { op: 'processSweep', action: 'facts' })
      await w.rpc('sessionRelease of nobody', { op: 'sessionRelease', runnerId: 'concourse-w-nobody' })
      await w.rpc('sessionRewind of nobody', { op: 'sessionRewind', sessionId: UNKNOWN_SESSION, mode: 'code', userMessageId: 'nobody', dryRun: true })
      await w.rpc('concourseWithdraw of nothing', { op: 'concourseWithdraw', clientMessageId: 'message-nobody-sent' })
      w.files('served')
      await w.cli('mercury daemon status', ['daemon', 'status'])
      await w.cli('mercury daemon stop', ['daemon', 'stop'])
      await w.left(d)
      w.files('stopped')
      await w.cli('mercury daemon stop, nothing running', ['daemon', 'stop'])
    },
  },
  {
    name: 'session-verbs',
    about: 'a session claimed, every verb of concourseControl against nobody and against the live session, parked, resumed, released, and the stop that reaps it',
    seconds: 60,
    covers: { verbs: ['answer-permission', 'park-all', 'park', 'set-title', 'set-schedule', 'mcp-action', 'mcp-tools', 'set-kit', 'set-model', 'set-effort', 'set-spawn-switch', 'set-permission-mode', 'session-facts', 'focus', 'blur', 'interrupt', 'stop-agent', 'resume-agent', 'withdraw-send', 'background-shell', 'send-now', 'board-post', 'pause-gate', 'leave', 'stop', 'attach', 'detach', 'grant-workflows', 'revoke-workflows', 'pause', 'resume'], doors: ['concourseAdmit', 'concourseControl', 'concourseList', 'concourseRelease', 'hello', 'onShutdown'], waysOut: ['control:shutdown with a worker reaped'] },
    run: async w => {
      const d = await w.boot('d1', { extra: { MERCURY_MAX_RETRIES: '0' } })
      await verbsOn(w, 'nobody', UNKNOWN_SESSION)
      for (const action of ['park', 'park-all', 'attach', 'detach', 'leave', 'stop', 'set-model']) await w.control(`${action} on nobody`, UNKNOWN_SESSION, action, action === 'set-model' ? { model: 'claude-sonnet-5' } : {})
      const s = await w.admit('s1')
      await w.rpc('hello with one session', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await verbsOn(w, 's1', s.sid, VERBS)
      await verbsOn(w, 's1', s.sid, LATER_VERBS.slice(0, 5))
      const edges = w.said('seat idle edge: ')
      await w.control('grant-workflows on s1', s.sid, 'grant-workflows')
      await w.until('the notice turn of s1 settled', () => {
        const rec = w.record(s.sid)
        return rec?.lastDeliveryAt !== undefined && (rec.lastTurnSettledAt ?? 0) >= rec.lastDeliveryAt
      }, 60_000)
      await w.saidPast('seat idle edge: ', edges)
      await w.control('revoke-workflows on s1', s.sid, 'revoke-workflows')
      await w.control('park s1', s.sid, 'park')
      await w.until('s1 is parked and its runner is gone', () => w.record(s.sid)?.parkedAt !== undefined && !alive(s.pid), 30_000)
      await w.control('park s1 again', s.sid, 'park')
      const revived = w.initializations()
      const revivedEdges = w.said('seat idle edge: ')
      await w.control('resume the parked s1', s.sid, 'resume')
      await w.initialized(revived)
      await w.saidPast('seat idle edge: ', revivedEdges)
      await w.control('park-all', s.sid, 'park-all')
      await w.until('s1 is parked again', () => w.record(s.sid)?.parkedAt !== undefined, 30_000)
      await w.rpc('sessionRelease of s1', { op: 'sessionRelease', runnerId: s.runnerId })
      await w.until('s1 is released', () => !w.workers().some(rec => rec.sessionId === s.sid && rec.pid !== undefined && alive(rec.pid)), 30_000)
      await w.until('the roster let go of the runner of s1', async () => (await w.call({ op: 'has', short: s.runnerId })).present === false, 30_000, 250)
      const t = await w.admit('s2')
      await w.control('set-model on s2', t.sid, 'set-model', { model: 'claude-sonnet-5' })
      await w.control('attach s2', t.sid, 'attach')
      await w.control('detach s2', t.sid, 'detach')
      await w.control('leave s2', t.sid, 'leave')
      await w.control('stop s2', t.sid, 'stop')
      await w.gone('s2', t.sid, t.pid, 'stoppedAt')
      await w.control('stop s2 again', t.sid, 'stop')
      await w.control('grant-workflows on the stopped s2', t.sid, 'grant-workflows')
      await w.control('revoke-workflows on the stopped s2', t.sid, 'revoke-workflows')
      const restarted = w.initializations()
      const restartedEdges = w.said('seat idle edge: ')
      await w.control('resume the stopped s2', t.sid, 'resume')
      await w.initialized(restarted)
      await w.saidPast('seat idle edge: ', restartedEdges)
      const n = await w.admit('s4')
      await w.control('park the newborn s4', n.sid, 'park')
      await w.until('the runner of s4 is gone', () => !alive(n.pid), 30_000)
      const u = await w.admit('s3')
      await w.rpc('shutdown reaping workers', { op: 'shutdown', reapWorkers: true })
      await w.left(d)
      await w.until('s3 is reaped', () => !alive(u.pid), 15_000)
      w.files('stopped')
    },
  },
  {
    name: 'plane-served',
    about: 'a second daemon, a successor of somebody else and a handover from the same build each find the plane served',
    seconds: 12,
    covers: { boot: ['refuse', 'stand-down (successor)', 'stand-down (same build)'], waysOut: ['refused start', 'stood down', 'SIGTERM'] },
    run: async w => {
      const d = await w.boot('d1')
      const second = await w.boot('d2', { wait: 'exit' })
      const third = await w.boot('d3', { wait: 'exit', extra: { MERCURY_DAEMON_SUCCESSOR_OF: '1' } })
      const fourth = await w.boot('d4', { wait: 'exit', extra: { MERCURY_DAEMON_HANDOVER_FROM: String(d.pid) } })
      void second
      void third
      void fourth
      await w.rpc('hello, the first still serves', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.files('three were turned away')
      w.signal(d, 'SIGTERM')
      await w.left(d)
      w.files('left')
    },
  },
  {
    name: 'signals',
    about: 'SIGINT and SIGHUP end the daemon as SIGTERM does',
    seconds: 8,
    covers: { waysOut: ['SIGINT', 'SIGHUP'] },
    run: async w => {
      const a = await w.boot('d1')
      w.signal(a, 'SIGINT')
      await w.left(a)
      const b = await w.boot('d2')
      w.signal(b, 'SIGHUP')
      await w.left(b)
      w.files('left')
    },
  },
  {
    name: 'control-off',
    about: 'a daemon with the control layer switched off serves nothing and leaves on SIGTERM',
    seconds: 6,
    covers: { boot: ['control disabled'], periodic: ['the keep-alive'], waysOut: ['SIGTERM without a control layer'] },
    run: async w => {
      const d = await w.boot('d1', { wait: 'none', extra: { MERCURY_DAEMON_CONTROL: '0' } })
      await w.logged(d, /starting daemon for/)
      await sleep(500)
      await w.rpc('ping finds nobody', { op: 'ping' }, 1500)
      w.files('running')
      w.signal(d, 'SIGTERM')
      await w.left(d)
    },
  },
  {
    name: 'control-held',
    about: 'the plane cannot be bound: the daemon gives the home back and exits 1',
    seconds: 8,
    covers: { boot: ['the control layer fails to start'], waysOut: ['the failed boot'] },
    run: async w => {
      mkdirSync(join(w.daemonDir, 'control.sock'), { recursive: true })
      const d = await w.boot('d1', { wait: 'exit' })
      void d
      w.files('left')
    },
  },
  {
    name: 'heal',
    about: 'the heal check finds the key, the record and the socket gone, one after another, and the installed build moved',
    seconds: 14,
    covers: { periodic: ['the plane heal (by its watch)', 'the installed-build watch'], doors: ['hello'], waysOut: ['SIGTERM'] },
    run: async w => {
      const d = await w.boot('d1')
      for (const name of ['control.key', 'daemon.json', 'control.sock']) {
        unlinkSync(join(w.daemonDir, name))
        w.say(`> ${name} removed`)
        await w.until(`${name} is back`, () => existsSync(join(w.daemonDir, name)), 45_000)
        await sleep(600)
        await w.rpc(`hello after ${name} came back`, { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      }
      w.files('healed')
      w.deploy(w.payload('c'))
      await w.logged(d, /the installed build moved to/, 15_000)
      w.signal(d, 'SIGTERM')
      await w.left(d)
    },
  },
  {
    name: 'home-gone',
    about: 'the daemon folder is removed under a running daemon',
    seconds: 10,
    covers: { waysOut: ['home-gone'] },
    run: async w => {
      const d = await w.boot('d1')
      rmSync(w.daemonDir, { recursive: true, force: true })
      w.say('> the daemon folder removed')
      await w.left(d, 45_000)
      w.files('left')
    },
  },
  {
    name: 'crash',
    about: 'an exception nobody caught, then a rejection nobody handled, each planted in a running daemon',
    seconds: 12,
    covers: { waysOut: ['crashShutdown (uncaughtException)', 'crashShutdown (unhandledRejection)'] },
    run: async w => {
      const plant = join(w.root, 'plant.cjs')
      writeFileSync(plant, "if (process.argv.includes('daemon')) process.on('SIGUSR2', () => { if (process.env.DMR_PLANT === 'rejection') Promise.reject(new Error('the planted rejection')); else setImmediate(() => { throw new Error('the planted exception') }) })\n")
      for (const [label, kind] of [['d1', 'exception'], ['d2', 'rejection']] as const) {
        const d = await w.boot(label, { extra: { NODE_OPTIONS: `--require ${plant}`, DMR_PLANT: kind } })
        w.signal(d, 'SIGUSR2')
        await w.left(d)
        w.files(`${label} left`)
        w.say(`@ crash reports, by kind: ${existsSync(join(w.home, 'crashes')) ? [...new Set(readdirSync(join(w.home, 'crashes')).map(name => name.replace(/\d+/g, '<n>')))].sort().join(' ') : 'none'}`)
      }
    },
  },
  {
    name: 'owner-gone',
    about: 'the owner of an owned daemon dies with one session live: every session is parked, then the daemon leaves',
    seconds: 25,
    covers: { periodic: ['the owner watch'], waysOut: ['parkAllThenShutdown (owner-orphaned)'], doors: ['hello', 'processSweep facts'] },
    run: async w => {
      const owner = w.holder('owner')
      const d = await w.boot('d1', { extra: { MERCURY_DAEMON_PERSIST: undefined, MERCURY_DAEMON_OWNER_PID: String(owner.pid) } })
      await w.rpc('hello names the owner', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      const s = await w.admit('s1')
      await w.rpc('processSweep facts', { op: 'processSweep', action: 'facts' })
      await w.end(owner, 'the owner')
      await w.left(d, 45_000)
      await w.until('s1 is gone', () => !alive(s.pid), 15_000)
      w.files('left')
      const rec = w.record(s.sid)
      w.note('the record of s1', { parked: rec?.parkedAt !== undefined, stopped: rec?.stoppedAt !== undefined, ended: rec?.endedAt !== undefined })
    },
  },
  {
    name: 'sessionless',
    about: 'an owned daemon whose one session was stopped leaves by itself after the grace',
    seconds: 55,
    covers: { periodic: ['the sessionless beat'], verbs: ['stop'], waysOut: ['sessionless'] },
    run: async w => {
      const d = await w.boot('d1', { extra: { MERCURY_DAEMON_PERSIST: undefined, MERCURY_DAEMON_OWNER_PID: String(process.pid) } })
      const s = await w.admit('s1')
      await w.control('stop s1', s.sid, 'stop')
      await w.until('s1 stopped', () => w.record(s.sid)?.stoppedAt !== undefined && !alive(s.pid), 30_000)
      await w.left(d, 60_000)
      w.files('left')
    },
  },
  {
    name: 'idle-retire',
    about: 'the reconcile tick, a minute after the boot, retires a session that stayed empty and idle',
    seconds: 75,
    covers: { periodic: ['the reconcile tick'], waysOut: ['SIGTERM'] },
    run: async w => {
      const d = await w.boot('d1', { extra: { MERCURY_SESSION_IDLE_RETIRE_MINUTES: '0.2', MERCURY_SESSION_NEWBORN_GRACE_MINUTES: '0.1' } })
      const s = await w.admit('s1')
      await w.logged(d, /retired .*empty and idle for/, 100_000)
      await w.gone('s1', s.sid, s.pid, 'stoppedAt')
      await w.rpc('hello after the retirement', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.signal(d, 'SIGTERM')
      await w.left(d)
    },
  },
  {
    name: 'process-sweep',
    about: 'the process sweep reads the facts, is refused for a stranger, for a live owner and for an open session, ends a released runner, then ends the daemon nothing uses',
    seconds: 30,
    covers: { doors: ['processSweep facts', 'processSweep end (daemon)', 'processSweep end (runner)'], waysOut: ['control:processSweep'] },
    run: async w => {
      const owner = w.holder('owner')
      const d = await w.boot('d1', { extra: { MERCURY_DAEMON_PERSIST: undefined, MERCURY_DAEMON_OWNER_PID: String(owner.pid) } })
      const state = JSON.parse(read(join(w.daemonDir, 'daemon.json'))) as { startToken?: string; startInstant?: string }
      const self = { kind: 'daemon', process: { pid: d.pid }, startToken: state.startInstant ?? state.startToken }
      await w.rpc('facts', { op: 'processSweep', action: 'facts' })
      await w.rpc('end with no identity', { op: 'processSweep', action: 'end' })
      await w.rpc('end a stranger', { op: 'processSweep', action: 'end', expected: { ...self, process: { pid: 1 } } })
      await w.rpc('end while the owner lives', { op: 'processSweep', action: 'end', expected: self })
      await w.rpc('end something else', { op: 'processSweep', action: 'end', expected: { kind: 'helper', process: { pid: d.pid }, startToken: self.startToken } })
      const s = await w.admit('s1')
      const facts = (await w.call({ op: 'processSweep', action: 'facts' })) as { facts?: { runners?: Array<{ pid?: number; procStart?: string }> } }
      const runner = facts.facts?.runners?.find(r => r.pid === s.pid)
      const reviewed = { kind: 'runner', process: { pid: s.pid }, startToken: runner?.procStart }
      await w.rpc('end the runner of an open session', { op: 'processSweep', action: 'end', expected: reviewed })
      await w.rpc('end a runner nobody rosters', { op: 'processSweep', action: 'end', expected: { ...reviewed, process: { pid: 1 } } })
      await w.control('stop s1', s.sid, 'stop')
      await w.until('s1 stopped', () => w.record(s.sid)?.stoppedAt !== undefined && !alive(s.pid), 30_000)
      await w.rpc('facts with the stopped session', { op: 'processSweep', action: 'facts' })
      await w.end(owner, 'the owner')
      await w.rpc('end the daemon nothing uses', { op: 'processSweep', action: 'end', expected: self })
      await w.left(d)
      w.files('left')
    },
  },
  {
    name: 'restart-idle',
    about: 'a restart asked of an idle daemon is taken at once, and the successor refuses a second one inside the minute',
    seconds: 20,
    covers: { doors: ['restartWhenIdle'], boot: ['serve as successor (wait-lock)'], waysOut: ['control:restart-when-idle', 'the restart after teardown'] },
    run: async w => {
      const d = await w.boot('d1')
      await w.rpc('restart-when-idle', { op: 'restart-when-idle', by: 'recorder' })
      await w.left(d)
      const next = await w.successor(d)
      await w.rpc('hello of the successor', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.rpc('restart-when-idle again', { op: 'restart-when-idle', by: 'recorder' })
      await w.rpc('restart-when-idle by a screen heal', { op: 'restart-when-idle', by: 'screen 4242' })
      w.files('the successor serves')
      await w.cli('mercury daemon stop', ['daemon', 'stop'])
      await w.until('the successor left', () => !alive(next), 20_000)
      w.files('left')
    },
  },
  {
    name: 'restart-armed',
    about: 'a restart asked while a session lives is armed, answered in hello, and taken by the beat once the session is stopped',
    seconds: 40,
    covers: { doors: ['restartWhenIdle', 'hello'], periodic: ['the armed-restart beat'], waysOut: ['restart-when-idle:armed', 'the restart after teardown'] },
    run: async w => {
      const d = await w.boot('d1')
      const s = await w.admit('s1')
      await w.rpc('restart-when-idle', { op: 'restart-when-idle', by: 'recorder' })
      await w.rpc('hello reads armed', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.rpc('restart-when-idle again', { op: 'restart-when-idle', by: 'recorder' })
      await w.control('stop s1', s.sid, 'stop')
      await w.until('s1 stopped', () => w.record(s.sid)?.stoppedAt !== undefined && !alive(s.pid), 30_000)
      await w.left(d, 30_000)
      const next = await w.successor(d)
      await w.rpc('hello of the successor', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.cli('mercury daemon stop', ['daemon', 'stop'])
      await w.until('the successor left', () => !alive(next), 20_000)
      w.files('left')
    },
  },
  {
    name: 'restart-other-build',
    about: 'a restart asked of a daemon that is not the installed build: it leaves and re-executes nothing; with a session it arms and leaves at the beat',
    seconds: 40,
    covers: { doors: ['restartWhenIdle'], periodic: ['the armed-restart beat'], waysOut: ['control:restart-when-idle (another build installed)', 'restart-when-idle:armed (another build installed)'] },
    run: async w => {
      const d = await w.boot('d1')
      w.deploy(w.payload('c'))
      await w.logged(d, /the installed build moved to/, 15_000)
      await w.rpc('restart-when-idle', { op: 'restart-when-idle', by: 'recorder' })
      await w.left(d)
      w.deploy(w.dist)
      const e = await w.boot('d2')
      const s = await w.admit('s1')
      w.deploy(w.payload('c'))
      await w.logged(e, /the installed build moved to/, 15_000)
      await w.rpc('restart-when-idle with a session', { op: 'restart-when-idle', by: 'recorder' })
      await w.control('stop s1', s.sid, 'stop')
      await w.until('s1 stopped', () => w.record(s.sid)?.stoppedAt !== undefined && !alive(s.pid), 30_000)
      await w.left(e, 30_000)
      w.files('left')
    },
  },
  {
    name: 'handover-live',
    about: 'a newer build takes the plane from a daemon that hosts a session; a restart asked of it arms behind the older one; the stop is forwarded and both leave',
    seconds: 40,
    covers: { boot: ['handover'], doors: ['hello', 'concourseList', 'restartWhenIdle', 'onShutdown (forwarding)'], periodic: ['the idle-predecessor sweep', 'the handover lock beat'], waysOut: ['control:shutdown forwarded to a predecessor'] },
    run: async w => {
      const a = w.payload('a')
      w.deploy(a)
      const older = await w.boot('older', { dist: a })
      const s = await w.admit('s1')
      const b = w.payload('b')
      w.deploy(b)
      await w.logged(older, /the installed build moved to/, 15_000)
      const newer = await w.boot('newer', { dist: b, extra: { MERCURY_DAEMON_HANDOVER_FROM: String(older.pid) } })
      await w.logged(newer, /took the plane/)
      await w.rpc('hello of the plane', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.rpc('sessionList across both', { op: 'sessionList' })
      await w.control('session-facts of the session the older one hosts', s.sid, 'session-facts')
      await w.rpc('restart-when-idle behind the older one', { op: 'restart-when-idle', by: 'recorder' })
      w.files('two daemons')
      await sleep(7000)
      await w.rpc('hello after one sweep', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.cli('mercury daemon stop', ['daemon', 'stop'], b)
      await w.left(newer)
      await w.left(older)
      await w.until('s1 is gone', () => !alive(s.pid), 15_000)
      w.files('left')
    },
  },
  {
    name: 'handover-idle',
    about: 'a newer build takes the plane from an idle daemon, asks it to leave, and takes the daemon lock when it has',
    seconds: 30,
    covers: { boot: ['handover'], periodic: ['the idle-predecessor sweep (asks to leave)', 'the handover lock beat (takes the lock)'], waysOut: ['control:shutdown asked by the successor'] },
    run: async w => {
      const a = w.payload('a')
      w.deploy(a)
      const older = await w.boot('older', { dist: a })
      const started = Number(((await w.hello()) as { startedAt?: number }).startedAt ?? Date.now())
      const b = w.payload('b')
      w.deploy(b)
      await w.logged(older, /the installed build moved to/, 15_000)
      const wait = 5600 - ((Date.now() - started) % 5000)
      await sleep(wait > 5000 ? wait - 5000 : wait)
      const newer = await w.boot('newer', { dist: b, extra: { MERCURY_DAEMON_HANDOVER_FROM: String(older.pid) } })
      await w.left(older, 30_000)
      await w.logged(newer, /the predecessor released the daemon lock/, 15_000)
      await w.rpc('hello of the plane', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.files('the newer one holds the lock')
      await w.cli('mercury daemon stop', ['daemon', 'stop'], b)
      await w.left(newer)
      w.files('left')
    },
  },
  {
    name: 'take-back',
    about: 'a build that is not the installed one takes the plane; the installed build takes it back and the other leaves once superseded',
    seconds: 30,
    covers: { periodic: ['the plane heal (takes the plane back)', 'the sessionless beat (superseded)'], waysOut: ['sessionless (superseded)'] },
    run: async w => {
      const a = w.payload('a')
      w.deploy(a)
      const older = await w.boot('older', { dist: a })
      const newer = await w.boot('newer', { dist: w.payload('b'), extra: { MERCURY_DAEMON_HANDOVER_FROM: String(older.pid) }, wait: 'none' })
      await w.logged(older, /taking it back/, 30_000)
      await w.left(newer, 45_000)
      await w.until('the installed build serves again', async () => {
        const h = await w.hello()
        return h.ok === true && h.pid === older.pid
      }, 15_000)
      await w.rpc('hello of the plane', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.files('taken back')
      await w.cli('mercury daemon stop', ['daemon', 'stop'], a)
      await w.left(older)
    },
  },
  {
    name: 'lock-held',
    about: 'the daemon lock is held by a process that serves no plane: a daemon takes the plane, then the lock when the holder dies; a successor of a holder that never leaves is refused after 10 s',
    seconds: 35,
    covers: { boot: ['handover (the lock held, no plane)', 'wait-lock then serve', 'wait-lock then refuse'], periodic: ['the handover lock beat (takes the lock)', 'the idle-predecessor sweep (nobody answers)'], waysOut: ['refused start', 'SIGTERM'] },
    run: async w => {
      const first = await w.lockHolder('holder1')
      const d = await w.boot('d1')
      await w.rpc('hello while another holds the lock', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.files('the lock is held by another')
      await sleep(2500)
      await w.end(first, 'holder1')
      await w.logged(d, /the predecessor released the daemon lock/, 15_000)
      w.files('the daemon holds the lock')
      w.signal(d, 'SIGTERM')
      await w.left(d)
      const second = await w.lockHolder('holder2')
      const e = await w.boot('d2', { wait: 'none', extra: { MERCURY_DAEMON_SUCCESSOR_OF: String(second.pid) } })
      await sleep(2000)
      await w.end(second, 'holder2')
      await w.until('d2 serves', async () => {
        const h = await w.hello()
        return h.ok === true && h.pid === e.pid && h.ready === true
      }, 20_000)
      w.signal(e, 'SIGTERM')
      await w.left(e)
      const third = await w.lockHolder('holder3')
      const f = await w.boot('d3', { wait: 'exit', waitMs: 30_000, extra: { MERCURY_DAEMON_SUCCESSOR_OF: String(third.pid) } })
      void f
      w.files('refused')
    },
  },
  {
    name: 'periodic-cold',
    about: 'a cold start under a clock the scenario owns: each interval as it is armed among the steps of the boot, with its period; one tick of each, with the files it reads; and what stops it on SIGTERM',
    seconds: 8,
    covers: { boot: ['serve'], periodic: ['the plane heal (armed, ticked, stopped)', 'the armed-restart beat (armed, ticked, stopped)', 'the sessionless beat (armed, ticked, stopped)', 'the reconcile tick (armed, ticked)', 'the keep-alive (armed, ticked, stopped)'], waysOut: ['SIGTERM'] },
    run: async w => {
      const d = await w.boot('d1', { extra: w.clock() })
      const armed = w.armed(d)
      for (let n = 1; n <= armed; n++) await w.tick(d, n)
      w.signal(d, 'SIGTERM')
      await w.left(d)
      w.files('left')
    },
  },
  {
    name: 'periodic-handover',
    about: 'a handover under a clock the scenario owns: the two beats a handover adds, armed in their place; the first sweep, a second after the boot, asks the idle older daemon to leave; a tick of the lock beat takes the lock; and what stops each in the older daemon and in the newer',
    seconds: 20,
    covers: { boot: ['handover'], periodic: ['the idle-predecessor sweep (armed, its first run, stopped)', 'the handover lock beat (armed, ticked, stops itself)', 'the plane heal (armed, ticked, stopped)'], waysOut: ['control:shutdown asked by the successor', 'control:shutdown'] },
    run: async w => {
      const a = w.payload('a')
      w.deploy(a)
      const older = await w.boot('older', { dist: a, extra: w.clock() })
      const b = w.payload('b')
      w.deploy(b)
      await w.logged(older, /the installed build moved to/, 15_000)
      const newer = await w.boot('newer', { dist: b, extra: { ...w.clock(), MERCURY_DAEMON_HANDOVER_FROM: String(older.pid) } })
      await w.left(older, 30_000)
      for (const n of [1, 2, 3]) await w.tick(newer, n)
      await w.tick(newer, 5)
      await w.logged(newer, /the predecessor released the daemon lock/, 15_000)
      const armed = w.armed(newer)
      for (let n = 6; n <= armed; n++) await w.tick(newer, n)
      await w.rpc('hello of the plane', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.files('the newer one holds the lock')
      await w.cli('mercury daemon stop', ['daemon', 'stop'], b)
      await w.left(newer)
      w.files('left')
    },
  },
  {
    name: 'periodic-restart',
    about: 'a restart under a clock the scenario owns: armed behind a session, it is taken by one tick of the armed-restart beat and by no other; what the leaving daemon stops, and each interval of the successor as it is armed',
    seconds: 30,
    covers: { boot: ['serve as successor (wait-lock)'], doors: ['restartWhenIdle'], periodic: ['the armed-restart beat (its tick takes the restart)', 'the sessionless beat (its tick does not)'], waysOut: ['restart-when-idle:armed', 'the restart after teardown'] },
    run: async w => {
      const d = await w.boot('d1', { extra: { ...w.clock(), MERCURY_MAX_RETRIES: '0' } })
      const s = await w.admit('s1')
      await w.rpc('restart-when-idle behind a session', { op: 'restart-when-idle', by: 'recorder' })
      await w.control('stop s1', s.sid, 'stop')
      await w.until('s1 stopped', () => w.record(s.sid)?.stoppedAt !== undefined && !alive(s.pid), 30_000)
      await w.tick(d, 3)
      await w.rpc('hello, the restart still armed', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.tick(d, 2)
      await w.left(d, 30_000)
      const next = await w.successor(d)
      await w.rpc('hello of the successor', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      await w.cli('mercury daemon stop', ['daemon', 'stop'])
      await w.until('the successor left', () => !alive(next), 20_000)
      w.files('left')
    },
  },
  {
    name: 'periodic-failed-boot',
    about: 'a boot that fails with intervals armed, under a clock the scenario owns: the clock refuses the third interval, before the daemon is ready, and in a second daemon the one armed after it is ready; nothing stops the ones that were armed, the home is given back, exit 1',
    seconds: 8,
    covers: { boot: ['the control layer fails to start (intervals armed)'], periodic: ['the plane heal (armed, a failed boot stops nothing)'], waysOut: ['the failed boot (intervals armed)'] },
    run: async w => {
      const early = await w.boot('d1', { wait: 'exit', extra: w.clock(5000) })
      void early
      w.files('the first left')
      const late = await w.boot('d2', { wait: 'exit', extra: w.clock(60_000) })
      void late
      w.files('the second left')
    },
  },
]

const MENDED: Scenario[] = [
  {
    name: 'stop-during-boot',
    about: 'a stop that reaches a daemon while it boots: the boot is held where the control server listens and the way out is not yet bound, the stop is sent there and acknowledged, the boot goes on, and the daemon leaves',
    seconds: 8,
    covers: { doors: ['onShutdown (during the boot)'], waysOut: ['control:shutdown asked during the boot'] },
    run: async w => {
      const d = await w.boot('d1', { wait: 'none', extra: w.clock(undefined, 'rename control.sock') })
      await w.logged(d, /clock: held at rename control\.sock/, 30_000)
      await w.direct('shutdown while the boot is held', d, { op: 'shutdown', reapWorkers: true })
      await w.goOn(d)
      await w.logged(d, /control socket up/, 30_000)
      await w.left(d, 10_000)
      w.files('left')
    },
  },
  {
    name: 'second-while-first-leaves',
    about: 'a daemon is held on its way out, its record marked stopping: a second daemon started by hand is refused; a window that opens waits, starts no daemon beside the one that leaves, and has its own once the first has left',
    seconds: 15,
    covers: { boot: ['refuse (the record marked stopping)'], waysOut: ['SIGTERM', 'refused start'] },
    run: async w => {
      const d = await w.boot('d1', { extra: w.clock(undefined, 'unlink daemon.json') })
      w.signal(d, 'SIGTERM')
      await w.logged(d, /clock: held at unlink daemon\.json/, 30_000)
      w.files('the first is leaving')
      const second = await w.boot('d2', { wait: 'exit' })
      void second
      const opened = w.window('window')
      await w.until('the window asks for its daemon', () => opened.said().includes('asks for its daemon'), 30_000)
      await sleep(1500)
      w.note('what the window has said while the first holds the plane', opened.said().trim())
      w.files('the window waits')
      await w.goOn(d)
      await w.left(d)
      await w.until('the window has its daemon', () => opened.said().includes('is usable: '), 45_000)
      w.note('what the window says once the first has left', opened.said().trim().split('\n').at(-1) ?? '')
      const served = (await w.hello()) as { pid?: number }
      w.stray(served.pid)
      await w.rpc('hello of the daemon the window started', { op: 'hello', clientVersion: '1.0.0', clientBuildTree: null })
      w.files('the window has its daemon')
    },
  },
]

const WORLDS: World[] = []

async function recordScenario(name: string, dist: string, keep = false): Promise<string> {
  const scenario = [...SCENARIOS, ...MENDED].find(s => s.name === name)
  if (scenario === undefined) throw new Error(`no scenario named ${name}; the names: ${[...SCENARIOS, ...MENDED].map(s => s.name).join(', ')}`)
  const w = new World(dist)
  WORLDS.push(w)
  w.say(`# ${scenario.name}: ${scenario.about}`)
  try {
    await scenario.run(w)
  } catch (error) {
    w.say(`! the scenario threw: ${w.mask(String(error))}`)
  }
  const text = await w.finish()
  if (keep) console.error(`world kept: ${w.root}`)
  else w.drop()
  return text
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const after = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const name = args.find(a => !a.startsWith('--') && a !== after('--dist') && a !== after('--out'))
  if (args.includes('--list') || name === undefined) {
    for (const s of [...SCENARIOS, ...MENDED]) console.log(`${s.name}\t${s.seconds}s\t${s.about}`)
    process.exit(name === undefined && !args.includes('--list') ? 2 : 0)
  }
  const guard = setTimeout(() => {
    console.error(`daemonRunScenarios: ${name} ran past 300 s: every process it started is ended`)
    for (const w of WORLDS) w.killAll()
    process.exit(3)
  }, 300_000)
  const text = await recordScenario(name, after('--dist') ?? join(ROOT, 'dist'), args.includes('--keep'))
  clearTimeout(guard)
  const out = after('--out')
  if (out !== undefined) writeFileSync(out, text)
  else process.stdout.write(text)
  process.exit(text.split('\n').some(line => line.startsWith('! ')) ? 1 : 0)
}
