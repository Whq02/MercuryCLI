#!/usr/bin/env bun
// gate-watch: src/daemon/main.ts src/daemon/handshake.ts src/daemon/ownedDaemon.ts src/services/switchboard/ensureDaemon.ts src/cli/update.ts
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const OLD_SHA = '5acf54bac'
const OLD_VERSION = '1.0.0-beta.26'
const NEW_DIST = process.env.UPDATE_ROAD_NEW_DIST ?? process.env.E004_BUNDLE_DIR ?? join(ROOT, 'dist')
if (!existsSync(join(NEW_DIST, 'mercury.mjs'))) {
  console.error(`✗ ${join(NEW_DIST, 'mercury.mjs')} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 1200)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const note = (t: string): void => console.log(`  [NOTE] ${t}`)
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => boolean | Promise<boolean>, ms: number, step = 150): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await sleep(step)
  }
  return pred()
}
const REAL_NODE = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim()

const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-update-old-window-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')

section(`§0 the released product: the tree of ${OLD_SHA} (v${OLD_VERSION}) built beside this proof`)
const oldDist = ((): string => {
  const pinned = process.env.UPDATE_ROAD_OLD_DIST
  if (pinned !== undefined && existsSync(join(pinned, 'mercury.mjs'))) return pinned
  const cache = join(realpathSync(tmpdir()), `mercury-release-${OLD_SHA}`)
  const dist = join(cache, 'dist')
  const fresh = existsSync(join(dist, 'mercury.mjs')) && spawnSync(REAL_NODE, [join(dist, 'mercury.mjs'), '--version'], { encoding: 'utf8' }).stdout.includes(OLD_VERSION)
  if (fresh) return dist
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${OLD_SHA} | tar -x -C "${cache}"`], { stdio: 'inherit' })
  symlinkSync(join(ROOT, 'node_modules'), join(cache, 'node_modules'))
  const built = spawnSync(process.execPath, ['run', 'build.ts'], { cwd: cache, encoding: 'utf8', env: { ...process.env, MERCURY_GATE_PREBUILT: undefined } })
  if (built.status !== 0) {
    console.error(`✗ the ${OLD_SHA} tree did not build: ${(built.stdout + built.stderr).slice(-2000)}`)
    process.exit(1)
  }
  return dist
})()
const treeOf = (sha: string): string => execFileSync('git', ['-C', ROOT, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim()
function stampTree(dist: string, tree: string): string {
  const path = join(dist, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { buildTree?: string | null }
  if (typeof manifest.buildTree !== 'string' || manifest.buildTree === '') {
    writeFileSync(path, JSON.stringify({ ...manifest, buildTree: tree }, null, 2))
    return tree.slice(0, 12)
  }
  return manifest.buildTree.slice(0, 12)
}
const oldTree = stampTree(oldDist, treeOf(OLD_SHA))
const newTree = stampTree(NEW_DIST, treeOf('HEAD'))
const oldVersion = spawnSync(REAL_NODE, [join(oldDist, 'mercury.mjs'), '--version'], { encoding: 'utf8' }).stdout.trim()
const newVersion = spawnSync(REAL_NODE, [join(NEW_DIST, 'mercury.mjs'), '--version'], { encoding: 'utf8' }).stdout.trim()
check(`the old product answers --version as Mercury ${OLD_VERSION}`, oldVersion === `Mercury ${OLD_VERSION}`, oldVersion)
check('the new product answers --version as Mercury', newVersion.startsWith('Mercury '), newVersion)
check('the two products are different builds (their trees differ)', oldTree !== newTree, `${oldTree} vs ${newTree}`)
note(`old ${oldDist} (tree ${oldTree}) · new ${NEW_DIST} (tree ${newTree})`)

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'update-old-window-')))
const KEEP = process.argv.includes('--keep')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const FIXTURE_KEY = 'fixture-key-000'
const MODEL = 'claude-sonnet-5'
const COMPOSER = 'Type a prompt'
const FACE_READY = '↵ start'
const V26_USABLE_MEMO_MS = 5_000
const V26_SPAWN_COOLDOWN_MS = 30_000

type Hit = { n: number; at: number; prompt: string }
type Fixture = { url: string; hits: Hit[]; release: (n: number) => void; waitFor: (n: number, ms: number) => Promise<Hit | null>; close: () => Promise<void> }
async function startFixture(opts: { hold: Set<number> }): Promise<Fixture> {
  const hits: Hit[] = []
  const holds = new Map<number, () => void>()
  const released = new Set<number>()
  const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
  const answer = (n: number, model: string, text: string): string =>
    [
      `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_uw_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
      `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
      `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
      `event: message_stop\n${sse({ type: 'message_stop' })}`,
    ].join('')
  const lastUserText = (body: unknown): string => {
    const messages = ((body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? []).filter(m => m.role === 'user')
    const last = messages[messages.length - 1]?.content
    if (typeof last === 'string') return last
    if (Array.isArray(last)) return last.map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : '')).join('')
    return ''
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const prompt = lastUserText(body)
      const word = /say (\w+)/.exec(prompt)?.[1]
      const n = word === 'THREE' ? 3 : word === 'TWO' ? 2 : 1
      hits.push({ n, at: Date.now(), prompt: prompt.slice(0, 80) })
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const send = (): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(answer(n, model, n === 1 ? 'ANSWER-ONE from the fixture' : n === 2 ? 'ANSWER-TWO from the fixture' : 'ANSWER-THREE from the fixture'))
      }
      if (opts.hold.has(n) && !released.has(n)) holds.set(n, send)
      else send()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    release: n => {
      released.add(n)
      holds.get(n)?.()
      holds.delete(n)
    },
    waitFor: async (n, ms) => {
      await until(() => hits.some(h => h.n === n), ms, 100)
      return hits.find(h => h.n === n) ?? null
    },
    close: () => new Promise(done => server.close(() => done())),
  }
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; receipts: Array<{ atTick: number; ts: number }>; endReason: string; done: Promise<void> }
function startCapture(id: string, cfg: Record<string, unknown>, env: Record<string, string>): { result: Promise<Capture> } {
  const cfgPath = join(SCRATCH, `vshot-${id}.json`)
  const outPath = join(SCRATCH, `grid-${id}.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const result = new Promise<Capture>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(Number(cfg.total ?? 300) * 200 + 90_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      if (!existsSync(outPath)) {
        reject(new Error(`vshot wrote no grid: ${stderr.join('').slice(-600)}`))
        return
      }
      const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: Array<{ atTick: number; ts: number }>; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
      const marks: Record<string, string> = {}
      for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
      resolve({ text: gridText(payload.grid), marks, receipts: payload.sendReceipts ?? [], endReason: payload.endReason ?? '', done: Promise.resolve() })
    })
  })
  return { result }
}
function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  for (const row of (frame ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 160)}`)
}
const gate = (needle: string, data: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 3, awaitSettleTicks: 3, data, ...extra })

type World = { home: string; work: string; current: string; env: Record<string, string>; log: () => string }
function makeWorld(id: string, fixtureUrl: string): World {
  const home = join(SCRATCH, `home-${id}`)
  const work = join(SCRATCH, `work-${id}`)
  mkdirSync(join(home, 'runtime'), { recursive: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'README.md'), '# the old-window fixture folder\n')
  const current = join(home, 'runtime', 'current')
  symlinkSync(oldDist, current)
  seedFirstRun(home, [work])
  writeFileSync(join(home, 'settings.json'), '{}\n')
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_API_KEY: FIXTURE_KEY,
    ANTHROPIC_BASE_URL: fixtureUrl,
    OPENAI_API_KEY: '',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_EVOLUTION_LEDGER: '0',
  }
  return { home, work, current, env, log: () => (existsSync(join(home, 'daemon', 'daemon.log')) ? readFileSync(join(home, 'daemon', 'daemon.log'), 'utf8') : '') }
}
function pointCurrentAt(world: World, dist: string): void {
  const tmp = `${world.current}.next`
  try {
    unlinkSync(tmp)
  } catch {}
  symlinkSync(dist, tmp)
  renameSync(tmp, world.current)
  if (readlinkSync(world.current) !== dist) throw new Error(`runtime/current did not move to ${dist}`)
}
async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  delete process.env.MERCURY_HOME
  const sock = await import(join(ROOT, 'src/daemon/controlSocket.ts'))
  sock.clearControlKeyMemo?.()
  sock.forgetDaemonProtoForTesting?.()
  try {
    return await body()
  } finally {
    if (before === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = before
    sock.clearControlKeyMemo?.()
    sock.forgetDaemonProtoForTesting?.()
  }
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: OLD_VERSION }
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
const sockMod = await import(join(ROOT, 'src/daemon/controlSocket.ts'))
const protocol = await import(join(ROOT, 'src/daemon/protocol.ts'))
const hsMod = await import(join(ROOT, 'src/daemon/handshake.ts'))
const { isProcessAlive } = await import(join(ROOT, 'src/daemon/ownerWatch.ts'))
type Hello = { pid: number; buildTree: string | null; version: string; live: number; ownerPid: number | null }
const hello = (): Promise<Hello | null> =>
  sockMod.daemonControlRpc({ op: 'hello', proto: protocol.MERCURY_DAEMON_PROTO, clientVersion: OLD_VERSION, clientBuildTree: oldTree }, { timeoutMs: 1500, protoRetry: false }).then((r: { ok: boolean; op?: string; pid?: number; buildTree?: string | null; version?: string; live?: number; ownerPid?: number | null }) => (r.ok && r.op === 'hello' ? { pid: r.pid as number, buildTree: r.buildTree ?? null, version: r.version ?? '?', live: r.live ?? 0, ownerPid: r.ownerPid ?? null } : null))
const stopEverything = async (home: string): Promise<string[]> =>
  withHome(home, async () => {
    const seen: string[] = []
    for (let round = 0; round < 6; round++) {
      const h = await hello()
      if (h === null) break
      seen.push(`pid ${h.pid} (tree ${h.buildTree})`)
      await sockMod.daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5000 }).catch(() => undefined)
      await until(() => !isProcessAlive(h.pid), 20_000, 200)
      await sleep(400)
    }
    return seen
  })
const pidsInLog = (log: string): number[] => [...new Set([...log.matchAll(/\bpid (\d+)\b/g)].map(m => Number(m[1])).filter(n => Number.isInteger(n) && n > 1))]

const baseEnv = (world: World): Record<string, string> => ({ ...world.env })
const screenArgv = (world: World): string[] => [REAL_NODE, join(world.current, 'mercury.mjs'), '--model', MODEL]

section('§A the update moves the helper while a v26 window is mid-turn: the window keeps sending through the installed helper and nothing restarts for nothing')
{
  const fixture = await startFixture({ hold: new Set([1]) })
  const world = makeWorld('a', fixture.url)
  const capture = startCapture(
    'a',
    {
      cols: 230,
      rows: 44,
      total: 1500,
      cwd: world.work,
      argv: screenArgv(world),
      sends: [
        gate(FACE_READY, '\r', { mark: 'face', awaitSettleTicks: 6 }),
        gate(COMPOSER, 'say ONE\r', { mark: 'composer', awaitSettleTicks: 4 }),
        gate('ANSWER-ONE', 'say TWO\r', { mark: 'after-one', awaitSettleTicks: 4 }),
        gate('ANSWER-TWO', '', { mark: 'after-two', awaitSettleTicks: 8 }),
      ],
      readyText: ['ANSWER-TWO'],
      readySettleTicks: 6,
    },
    baseEnv(world),
  )
  const first = await fixture.waitFor(1, vshotBudgetMs(150_000))
  check('A1 the v26 window sent its first prompt through its own v26 helper (the request reached the API fixture)', first !== null, j(fixture.hits))
  const oldDaemon = await withHome(world.home, () => hello())
  check('A2 the helper serving it is the v26 build, started by the window through runtime/current', oldDaemon !== null && oldDaemon.buildTree === oldTree && oldDaemon.live >= 1, j(oldDaemon))
  pointCurrentAt(world, NEW_DIST)
  const receipt = await withHome(world.home, () => hsMod.moveDaemonToDeployedBuild({ by: 'mercury update', hosted: false, pollMs: 250, tries: 160 }))
  const movedAt = Date.now()
  check('A3 the update (its helper leg) hands the plane to the installed build while the v26 helper keeps its live session', receipt.state === 'moved' && /takes new sessions; daemon v1\.0\.0-beta\.26 \(pid \d+\) keeps its 1 live session until (it|they) finish/.test(receipt.line), j(receipt))
  const newDaemon = await withHome(world.home, () => hello())
  check('A4 the plane is now served by the installed build', newDaemon !== null && newDaemon.buildTree === newTree && newDaemon.pid !== oldDaemon?.pid, j(newDaemon))
  await sleep(Math.max(0, V26_USABLE_MEMO_MS + 1500 - (Date.now() - (first?.at ?? Date.now()))))
  fixture.release(1)
  const second = await fixture.waitFor(2, vshotBudgetMs(150_000))
  check('A5 THE OWNER\'S ARM: the v26 window, open through the update, still sends — its second prompt reached the API through the installed helper', second !== null && second.at > movedAt, `${j(fixture.hits)} movedAt=${movedAt}`)
  const afterSecond = await withHome(world.home, () => hello())
  check('A9 the window\'s heal ask was refused with the reopen reason and the installed helper stayed in place', afterSecond !== null && afterSecond.pid === newDaemon?.pid, j(afterSecond))
  const cap = await capture.result
  const afterTwo = cap.marks['after-two'] ?? cap.text
  check('A6 both answers are on the v26 screen, and the second prompt was not bounced back into the composer', afterTwo.includes('ANSWER-ONE') && afterTwo.includes('ANSWER-TWO') && !/^│❯ say TWO/m.test(afterTwo), cap.endReason)
  check('A7 the held session kept flowing to its own runner: the v26 helper that holds it was still alive when the second answer landed', /keeps its 1 live session/.test(receipt.line) && oldDaemon !== null && (second === null || second.at < movedAt + 120_000), j(receipt))
  const log = world.log()
  check('A8 no heal restarted the installed helper for nothing (no restart was armed or requested by the window)', !/restart (armed|requested) by screen/.test(log), log.split('\n').filter(l => /restart/.test(l)).join(' | ').slice(-600))
  check('A8b the window\'s heal ask met the installed helper\'s refusal with the reopen words', /restart asked by screen \d+ — refused: close this window and open Mercury again/.test(log), log.split('\n').filter(l => /restart asked/.test(l)).join(' | ').slice(-600))
  check('A10 every send the drive scheduled became due', cap.receipts.length === 4, `${cap.receipts.length}/4 · end ${cap.endReason}`)
  if (failures > 0 || KEEP) {
    for (const [mark, frame] of Object.entries(cap.marks)) dump(`A ${mark}`, frame)
    console.log(`  daemon log tail: ${log.slice(-1500)}`)
  }
  await sleep(1500)
  const stopped = await stopEverything(world.home)
  const leftovers = pidsInLog(world.log()).filter(pid => isProcessAlive(pid))
  check('A11 the way down: every helper left through Mercury\'s own stop and nothing of this arm survives', leftovers.length === 0, `stopped ${j(stopped)} leftovers ${j(leftovers)}`)
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await fixture.close()
}

section('§B the owner\'s shape: the v26 window\'s helper is gone and the install moved — the window starts a helper through runtime/current with its own words and still sends')
{
  const fixture = await startFixture({ hold: new Set() })
  const world = makeWorld('b', fixture.url)
  const SEND_TWO_AFTER_TICKS = Math.ceil((V26_SPAWN_COOLDOWN_MS + 8_000) / 200)
  const capture = startCapture(
    'b',
    {
      cols: 230,
      rows: 44,
      total: 700,
      cwd: world.work,
      argv: screenArgv(world),
      sends: [
        gate(FACE_READY, '\r', { mark: 'face', awaitSettleTicks: 6 }),
        gate(COMPOSER, 'say ONE\r', { mark: 'composer', awaitSettleTicks: 4 }),
        gate('ANSWER-ONE', '', { mark: 'after-one', awaitSettleTicks: 4 }),
        { afterPrevTicks: SEND_TWO_AFTER_TICKS, data: 'say TWO\r', mark: 'sent-two' },
        gate('ANSWER-TWO', '', { mark: 'after-two', awaitSettleTicks: 8 }),
        { afterPrevTicks: Math.ceil((V26_USABLE_MEMO_MS + 3_000) / 200), data: 'say THREE\r', mark: 'sent-three' },
        gate('ANSWER-THREE', '', { mark: 'after-three', awaitSettleTicks: 8 }),
      ],
      readyText: ['ANSWER-THREE'],
      readySettleTicks: 6,
    },
    baseEnv(world),
  )
  const first = await fixture.waitFor(1, vshotBudgetMs(150_000))
  check('B1 the v26 window sent its first prompt through its own v26 helper', first !== null, j(fixture.hits))
  const oldDaemon = await withHome(world.home, () => hello())
  check('B2 the helper serving it is the v26 build', oldDaemon !== null && oldDaemon.buildTree === oldTree, j(oldDaemon))
  await sleep(2500)
  const gone = await stopEverything(world.home)
  check('B3 the v26 helper (and its workers) are gone — through Mercury\'s own stop', gone.length >= 1 && (await withHome(world.home, () => hello())) === null && (oldDaemon === null || !isProcessAlive(oldDaemon.pid)), j(gone))
  pointCurrentAt(world, NEW_DIST)
  const movedAt = Date.now()
  const second = await fixture.waitFor(2, vshotBudgetMs(200_000))
  const spawnedAfter = await withHome(world.home, () => hello())
  check('B4 THE OWNER\'S BUG, CLOSED: the window\'s second prompt went through — the helper it started through runtime/current is the installed build, started with the window\'s own words', second !== null && spawnedAfter !== null && spawnedAfter.buildTree === newTree, `hits ${j(fixture.hits)} helper ${j(spawnedAfter)} log: ${world.log().split('\n').filter(l => /too many arguments|spawnOwnedDaemon|unknown/.test(l)).slice(-4).join(' | ')}`)
  check('B5 the update happened before the second prompt was typed (the drive\'s order held)', second !== null && second.at > movedAt, `movedAt=${movedAt} second=${second?.at ?? 'none'} — the drive types the second prompt ${SEND_TWO_AFTER_TICKS} ticks after the first answer (past the window's ${V26_SPAWN_COOLDOWN_MS / 1000}s helper-start cooldown)`)
  const third = await fixture.waitFor(3, vshotBudgetMs(120_000))
  const helperAfterThird = await withHome(world.home, () => hello())
  check('B6b a third prompt, past the window\'s memo, runs the window\'s version handshake and heal against the installed helper — and still goes through; the helper stays', third !== null && helperAfterThird !== null && helperAfterThird.pid === spawnedAfter?.pid, `${j(fixture.hits)} helper ${j(helperAfterThird)}`)
  const cap = await capture.result
  const afterTwo = cap.marks['after-two'] ?? cap.text
  const afterThree = cap.marks['after-three'] ?? cap.text
  check('B6 the answers are on the v26 screen — no prompt was bounced back into the composer', afterTwo.includes('ANSWER-ONE') && afterTwo.includes('ANSWER-TWO') && afterThree.includes('ANSWER-THREE') && !/^│❯ say (TWO|THREE)/m.test(afterThree), `end ${cap.endReason}; composer rows: ${afterThree.split('\n').filter(l => /^│❯/.test(l)).join(' | ').slice(0, 300)}`)
  const log = world.log()
  check('B7 at the window\'s next contact with the helper door its heal was refused with the reopen words (the released v26 screen paints no line for this state; a v27 window does — the skew proof\'s C9/C10)', /restart asked by screen \d+ — refused: close this window and open Mercury again — a newer Mercury \((v[\w.-]+|tree [0-9a-f]+)\) is installed and this daemon already runs it/.test(log), log.split('\n').filter(l => /restart asked/.test(l)).join(' | ').slice(-600))
  check('B8 the installed helper was never restarted for nothing by the window\'s heal', !/restart (armed|requested) by screen/.test(log), log.split('\n').filter(l => /restart/.test(l)).join(' | ').slice(-600))
  check('B9 every send the drive scheduled became due', cap.receipts.length === 7, `${cap.receipts.length}/7 · end ${cap.endReason}`)
  if (failures > 0 || KEEP) {
    for (const [mark, frame] of Object.entries(cap.marks)) dump(`B ${mark}`, frame)
    dump('B final grid', cap.text)
    console.log(`  daemon log tail: ${log.slice(-2000)}`)
  }
  await sleep(1500)
  const stopped = await stopEverything(world.home)
  const leftovers = pidsInLog(world.log()).filter(pid => isProcessAlive(pid))
  check('B10 the way down: every helper left through Mercury\'s own stop and nothing of this arm survives', leftovers.length === 0, `stopped ${j(stopped)} leftovers ${j(leftovers)}`)
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await fixture.close()
}

if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`[forensics] world kept: ${SCRATCH}`)
console.log(`\nprove-update-old-window-drive: ${checks} checks, ${failures} failed`)
console.log(failures === 0 ? ' ✅ A v26 WINDOW OPEN THROUGH THE UPDATE STILL SENDS' : ` ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
