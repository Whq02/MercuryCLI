#!/usr/bin/env bun
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
const SIZES = (arg('--sizes') ?? '80x21,80x14,82x17,120x40').split(',').map(size => size.split('x').map(Number) as [number, number])
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), arg('--scratch-prefix') ?? 'model-refresh-')))
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
if (!existsSync(DIST)) throw new Error(`Build missing: ${DIST}`)
if (FRAMES) mkdirSync(FRAMES, { recursive: true })
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}
type Cell = { c?: string }
type Grid = Cell[][]
type Payload = { grid: Grid; marks?: { label: string; grid: Grid; atMs: number }[]; sendReceipts?: { ts: number }[]; endReason?: string }
type Wire = { kind: string; at: number; models?: { id: string }[] }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const model = (id: string, display_name: string, priority: number) => ({ id, display_name, priority, visibility: 'public', supported_in_api: true, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000, input_modalities: ['text', 'image'] })
console.log(`bundle ${DIST}\nscratch ${SCRATCH}`)

for (const [cols, rows] of SIZES) {
  const tag = `${cols}x${rows}`
  const home = join(SCRATCH, tag)
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), '{}')
  writeFileSync(join(home, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { idToken: 'fixture-id', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 86_400_000 } }), { mode: 0o600 })
  const captureFile = join(home, 'wire.jsonl')
  const catalogueFile = join(home, 'models.json')
  writeFileSync(captureFile, '')
  writeFileSync(catalogueFile, JSON.stringify({ models: [model('gpt-5.6-sol', 'GPT-5.6 Sol', 1), model('gpt-5.6-terra', 'GPT-5.6 Terra', 2)], afterTurn: [model('gpt-6-astra', 'GPT-6 Astra', 1), model('gpt-5.6-sol', 'GPT-5.6 Sol', 2)], delayMs: 3000 }))
  const fixture = spawn(NODE, [join(ROOT, 'scripts/journey/cap-offer-fixture-server.ts'), captureFile, catalogueFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not print PORT')), vshotBudgetMs(15_000))
      let output = ''
      fixture.stdout!.on('data', chunk => {
        output += String(chunk)
        const match = /PORT (\d+)/.exec(output)
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
      })
      fixture.on('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)) })
    })
    const base = `http://127.0.0.1:${port}`
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor',
      MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`, MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
      MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:9',
      MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_TABULA_DIR: join(home, 'tabula'), MERCURY_HOME: join(home, 'proof-home'),
      MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'), MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0',
      MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
      MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TERMINAL_TITLE: '0', MERCURY_UPDATE_NOTICE: '0', MERCURY_OPERATOR: 'sam',
      MERCURY_CAP_FAILOVER: '0',
    }
    const out = join(home, 'grid.json')
    const cfg = join(home, 'cfg.json')
    const readyLanded = cols >= 100 && rows >= 26 ? '← back' : '1 session on'
    const ready = cols >= 100 && rows >= 26 ? 'ready · ' : '1 session on'
    const sends = [
      { requireAwait: true, awaitText: 'New Session', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: readyLanded, minTick: 15, awaitSettleTicks: 3, data: 'hello sol\r' },
      { requireAwait: true, awaitText: 'sol answers from the fixture', minTick: 4, awaitSettleTicks: 3, data: '', mark: 'turn' },
      { requireAwait: true, awaitText: ready, minTick: 3, awaitSettleTicks: 3, data: '/model\r', mark: 'open' },
      { requireAwait: true, awaitText: 'GPT-5.6 Terra', minTick: 1, awaitSettleTicks: 1, data: '', mark: 'cached' },
      { afterPrevTicks: 60, awaitText: 'GPT-6 Astra                    ○ switch', awaitSettleTicks: 2, data: '', mark: 'refreshed' },
    ]
    writeFileSync(cfg, JSON.stringify({ argv: [NODE, DIST, '--model', 'gpt-5.6-sol'], cwd, cols, rows, total: 450, stableTicks: 4, sends, out }))
    const status = await new Promise<number>((resolveCapture, reject) => {
      execFile(driver.python, [captureEngineEntry(driver, ROOT), cfg], { env, cwd, timeout: vshotBudgetMs(180_000) }, (error, _stdout, stderr) => {
        if (error && !existsSync(out)) reject(new Error(`${error}\n${stderr}`))
        else { if (error) console.log(stderr); resolveCapture(error ? Number(error.code) || 1 : 0) }
      })
    })
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    const wire = readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire)
    const cached = payload.marks?.find(mark => mark.label === 'cached')
    const refreshed = payload.marks?.find(mark => mark.label === 'refreshed')
    const before = cached ? text(cached.grid) : ''
    const after = refreshed ? text(refreshed.grid) : text(payload.grid)
    if (FRAMES) {
      writeFileSync(join(FRAMES, `${tag}-cached.txt`), before + '\n')
      writeFileSync(join(FRAMES, `${tag}-refreshed.txt`), after + '\n')
      writeFileSync(join(FRAMES, `${tag}-grid.json`), JSON.stringify(payload))
      writeFileSync(join(FRAMES, `${tag}-wire.jsonl`), readFileSync(captureFile))
    }
    const turn = wire.find(event => event.kind === 'openai')
    const initial = wire.filter(event => event.kind === 'models' && event.at < (turn?.at ?? 0))
    const refreshes = wire.filter(event => event.kind === 'models' && event.at > (turn?.at ?? Infinity))
    check(`${tag}: the drive reached every state`, status === 0 && payload.sendReceipts?.length === sends.length, `${payload.sendReceipts?.length}/${sends.length}; ${payload.endReason}`)
    check(`${tag}: one turn primed the old list`, initial.length === 1 && turn !== undefined, `initial models requests ${initial.length}`)
    const liveTerra = (frame: string): boolean => /GPT-5\.6 Terra[^\n]*switch/.test(frame)
    const liveAstra = (frame: string): boolean => /GPT-6 Astra[^\n]*switch/.test(frame)
    const openAt = payload.sendReceipts?.[3]?.ts ?? Infinity
    const cachedAt = payload.sendReceipts?.[4]?.ts ?? Infinity
    const landed = wire.find(event => event.kind === 'models-landed' && event.at > openAt)
    check(`${tag}: the cached rows paint before the delayed refresh`, liveTerra(before) && !liveAstra(before) && (landed === undefined || cachedAt < landed.at))
    check(`${tag}: opening makes exactly one background models request within the cache span`, refreshes.length === 1 && refreshes[0]!.at >= openAt && refreshes[0]!.at - turn!.at < 300_000, `refresh requests ${refreshes.length}`)
    check(`${tag}: the new rows replace the old live rows in place`, liveAstra(after) && !liveTerra(after), after)
    check(`${tag}: focus stays on Sol after its row moves`, after.includes('gpt-5.6-sol · model IDs') || /❯\s+GPT-5\.6 Sol/.test(after))
    if (after.includes('CHOOSE A MODEL')) check(`${tag}: the existing notice names the changed list`, after.includes('GPT — the live list changed'))
  } finally {
    fixture.kill('SIGTERM')
  }
}
console.log(`${checks} checks, ${failures} failures; worlds kept at ${SCRATCH}`)
process.exit(failures === 0 ? 0 : 1)
