#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { recordPty, type PtyRecord } from '../lib/ptyRecorder.ts'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'
import { gridToPng } from '../ui/gridToPng.ts'

const repo = resolve(import.meta.dir, '../..')
const option = (flag: string): string | undefined => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1] }
const bundle = resolve(option('--bundle') ?? join(repo, 'dist/mercury.mjs'))
const parent = process.env.MERCURY_CONFIG_DIR
assert(parent, 'set MERCURY_CONFIG_DIR to a scratch directory')
assert(!process.env.MERCURY_HOME, 'MERCURY_HOME must be unset')
assert(existsSync(bundle), `build first: ${bundle}`)
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error('This capture uses the POSIX PTY; run the Windows repro with the box\'s ConPTY driver.')
const root = mkdtempSync(join(parent, 'clear-model-'))
const frames = option('--frames') ?? join(root, 'frames')
mkdirSync(frames, { recursive: true })
const gone = 'compat/nothing/none'
const note = `the model this chat ran on (${gone}) is no longer reachable — this fresh chat starts on the default model instead; /model picks another`
const normal = (text: string): string => text.split('\n').map(line => {
  const first = line.indexOf('│'), last = line.lastIndexOf('│')
  return first >= 0 && last > first ? line.slice(first + 1, last) : line
}).join(' ').replace(/\s+/g, ' ').trim()
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(read: () => boolean, ms = 45_000): Promise<boolean> {
  const deadline = Date.now() + ms
  do { if (read()) return true; await wait(200) } while (Date.now() < deadline)
  return false
}
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`)
}
const json = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const text = (path: string): string => { try { return readFileSync(path, 'utf8') } catch { return '' } }

async function road(name: 'keyless' | 'refused' | 'unchanged'): Promise<void> {
  const world = join(root, name), home = join(world, 'home'), work = join(world, 'work'), daemonDir = join(world, 'daemon')
  for (const path of [home, work, daemonDir]) mkdirSync(path, { recursive: true })
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^MERCURY_|_API_KEY$|TOKEN|^ANTHROPIC_|^CI$|^NODE_ENV$/.test(key)) delete env[key]
  Object.assign(env, {
    MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: '../daemon', MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_FULLSCREEN: '1', MERCURY_PARTY: '0', MERCURY_CACHE_CLOCK: '0',
    MERCURY_TERMINAL_TITLE: '0', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_NPM_REGISTRY_BASE: 'http://127.0.0.1:9', BROWSER: '/usr/bin/true',
  })
  if (name === 'refused') Object.assign(env, { ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
  seedFirstRun(home, [work])
  const settings = join(home, 'settings.json')
  const provider = { nothing: { baseUrl: 'http://127.0.0.1:9' } }
  writeFileSync(settings, JSON.stringify({ engine: { model: gone }, compatProvider: provider }))
  const pty = recordPty({ argv: ['node', bundle], cwd: work, env, cols: 120, rows: 40, path: join(world, 'pty.bin') })
  const workers = (): any[] => Object.values(json(join(daemonDir, 'concourse-workers.json'))?.workers ?? {})
  const facts = (sid: string): any => json(join(daemonDir, 'session-facts', `${sid}.json`))
  const raw = (): string => Buffer.concat(pty.records.filter(r => r.direction === 'output').map(r => r.bytes)).toString()
  const plain = (): string => stripVTControlCharacters(raw()).toLowerCase()
  function frame(label: string): string {
    const tee = join(frames, `${name}-${label}.tee`), grid = join(frames, `${name}-${label}.json`)
    const chunks = pty.records.filter(r => r.direction === 'output').map((r: PtyRecord, i: number) => {
      const h = Buffer.alloc(8); h.writeUInt32BE(i); h.writeUInt32BE(r.bytes.length, 4)
      return Buffer.concat([h, r.bytes])
    })
    writeFileSync(tee, Buffer.concat(chunks))
    const read = spawnSync(driver.kind === 'posix-pty' ? driver.python : 'python3', [join(repo, 'scripts/ui/replay-tee-grid.py'), tee, '120', '40', grid], { encoding: 'utf8' })
    assert.equal(read.status, 0, read.stderr)
    writeFileSync(join(frames, `${name}-${label}.txt`), read.stdout)
    return read.stdout
  }
  let old: any
  try {
    assert(await until(() => plain().includes('new session')), `boot menu missing: ${frame('boot-failed')}`)
    pty.send('\r')
    assert(await until(() => workers().length > 0), 'the old chat was never admitted')
    old = workers().find(r => r.endedAt === undefined)
    assert(await until(() => !!facts(old.sessionId)?.model), 'old runner facts never appeared')
    check(`${name}: old runner is on ${gone}`, facts(old.sessionId)?.model.effective === gone)
    await wait(500)
    frame('before')
    if (name !== 'unchanged') writeFileSync(settings, JSON.stringify(name === 'refused' ? { engine: { model: 'opus55' }, compatProvider: {} } : { compatProvider: {} }))
    await wait(2000)
    const logBefore = text(join(daemonDir, 'daemon.log')).length
    pty.send('/clear'); await wait(400); pty.send('\r')
    assert(await until(() => workers().some(r => r.sessionId !== old.sessionId && r.bornBlankAt)), 'no fresh chat after /clear')
    const born = workers().find(r => r.sessionId !== old.sessionId && r.bornBlankAt)
    assert(await until(() => !!facts(born.sessionId)?.model), 'born runner facts never appeared')
    const effective = facts(born.sessionId).model.effective
    check(`${name}: fresh runner model ${effective}`, name === 'unchanged' ? effective === gone : effective !== gone)
    const log = text(join(daemonDir, 'daemon.log')).slice(logBefore)
    check(`${name}: admission road is ${name === 'refused' ? 'refused then default' : 'admitted without a refusal'}`, name === 'refused' ? log.includes('admission refused: model refused (') : !log.includes('admission refused:'))
    writeFileSync(join(frames, `${name}-facts.json`), JSON.stringify({ oldSessionId: old.sessionId, bornSessionId: born.sessionId, admission: born, runner: facts(born.sessionId) }, null, 2))
    writeFileSync(join(frames, `${name}-daemon.log`), log)
    await wait(1500)
    const beforePrompt = frame('notice')
    check(`${name}: exactly ${name === 'unchanged' ? 'zero' : 'one'} existing notice before a prompt`, normal(beforePrompt).split(normal(note)).length - 1 === (name === 'unchanged' ? 0 : 1), beforePrompt)
    await gridToPng(join(frames, `${name}-notice.json`), join(frames, `${name}-notice.png`))
    pty.send('!printf CLEAR-NOTICE-FIXTURE'); await wait(400); pty.send('\r')
    const projects = join(home, 'projects')
    const transcript = (): string => {
      const glob = new Bun.Glob(`**/${born.sessionId}.jsonl`)
      return [...glob.scanSync({ cwd: projects, absolute: true })].map(text).join('\n')
    }
    assert(await until(() => transcript().includes('CLEAR-NOTICE-FIXTURE'), 30_000), `shell turn never persisted: ${frame('shell-failed')}`)
    await wait(1000)
    const stored = transcript().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const receiptRows = stored.filter(row => (row.payload?.kind === 'notice' && row.payload?.noticeKind === 'seat_receipt' && row.payload?.content === note) || (row.type === 'system' && row.subtype === 'seat_receipt' && row.content === note))
    check(`${name}: transcript carries exactly ${name === 'unchanged' ? 'zero' : 'one'} notice`, receiptRows.length === (name === 'unchanged' ? 0 : 1), JSON.stringify(receiptRows))
    writeFileSync(join(frames, `${name}-transcript.jsonl`), transcript())
    const after = frame('after-turn')
    check(`${name}: no double notice after transcript adoption`, normal(after).split(normal(note)).length - 1 === (name === 'unchanged' ? 0 : 1), after)
    check(`${name}: never the retired endpoint-variable advice`, !raw().includes('MERCURY_COMPAT_BASE_URL') && !transcript().includes('MERCURY_COMPAT_BASE_URL'))
    await gridToPng(join(frames, `${name}-after-turn.json`), join(frames, `${name}-after-turn.png`))
    writeFileSync(join(frames, `${name}-raw.ansi`), raw())
  } catch (error) {
    frame('failed')
    writeFileSync(join(frames, `${name}-raw.ansi`), raw())
    writeFileSync(join(frames, `${name}-daemon.log`), text(join(daemonDir, 'daemon.log')))
    throw error
  } finally {
    await pty.close()
    const child = spawn('node', [bundle, 'daemon', 'stop'], { cwd: work, env, stdio: 'ignore' })
    await new Promise<void>(r => child.once('exit', () => r()))
  }
}
try {
  for (const name of ['keyless', 'refused', 'unchanged'] as const) {
    try { await road(name) } catch (error) { check(`${name}: drive completed`, false, String(error)) }
  }
} finally {
  console.log(`frames: ${frames}`)
  if (option('--frames') !== undefined) rmSync(root, { recursive: true, force: true })
}
console.log(`clear-model-notice: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
