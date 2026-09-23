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
const SIZES = (arg('--sizes') ?? '178x51').split(',').map(size => size.split('x').map(Number) as [number, number])
const LEGS = (arg('--legs') ?? 'openrouter,gemini,huggingface,local,unchanged,dark').split(',')
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), arg('--scratch-prefix') ?? 'model-refresh-families-')))
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
const DEAD = 'http://127.0.0.1:9'
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
type Wire = { kind: string; family?: string; phase?: string; at: number }
type FamilyName = 'openrouter' | 'gemini' | 'huggingface' | 'local'
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const live = (frame: string, name: string): boolean => new RegExp(`${escapeRe(name)}[^\\n]*(switch|current)`).test(frame)
const current = (frame: string, name: string): boolean => new RegExp(`${escapeRe(name)}[^\\n]*current`).test(frame)

const orRow = (id: string, name: string) => ({ id, name, context_length: 131_072, created: 1_755_800_000 })
const gemRow = (id: string, displayName: string) => ({ name: `models/${id}`, displayName, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 8192 })
const hfRow = (id: string) => ({ id, object: 'model', created: 1_755_800_000, owned_by: 'fixture-org', providers: [{ provider: 'novita', status: 'live', context_length: 131_072, supports_tools: true }] })
const ollama = (ids: string[]) => ({
  tags: { models: ids.map(id => ({ name: id, model: id, details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' } })) },
  ps: { models: [] },
  show: Object.fromEntries(ids.map(id => [id, { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131_072 }, parameters: 'num_ctx 131072' }])),
})

type FamilySpec = {
  name: FamilyName
  word: string
  model: string
  keys: Record<string, string>
  before: unknown
  after: unknown
  delayMs: number
  oldName: string
  newName: string
  keepName: string
}
const FAMILIES: Record<FamilyName, FamilySpec> = {
  openrouter: {
    name: 'openrouter', word: 'OpenRouter', model: 'openrouter/fixture-vendor/refresh-alpha',
    keys: { OPENROUTER_API_KEY: 'sk-or-v1-fixture-refresh-000001' },
    before: [orRow('fixture-vendor/refresh-alpha', 'Refresh Alpha'), orRow('fixture-vendor/refresh-beta', 'Refresh Beta')],
    after: [orRow('fixture-vendor/refresh-gamma', 'Refresh Gamma'), orRow('fixture-vendor/refresh-alpha', 'Refresh Alpha')],
    delayMs: 3000, oldName: 'Refresh Beta', newName: 'Refresh Gamma', keepName: 'Refresh Alpha',
  },
  gemini: {
    name: 'gemini', word: 'Gemini', model: 'gemini-refresh-alpha',
    keys: { GEMINI_API_KEY: 'AIza-fixture-refresh-0000000000000' },
    before: [gemRow('gemini-refresh-alpha', 'Gemini Refresh Alpha'), gemRow('gemini-refresh-beta', 'Gemini Refresh Beta')],
    after: [gemRow('gemini-refresh-gamma', 'Gemini Refresh Gamma'), gemRow('gemini-refresh-alpha', 'Gemini Refresh Alpha')],
    delayMs: 3000, oldName: 'Gemini Refresh Beta', newName: 'Gemini Refresh Gamma', keepName: 'Gemini Refresh Alpha',
  },
  huggingface: {
    name: 'huggingface', word: 'Hugging Face', model: 'huggingface/fixture-org/refresh-alpha',
    keys: { HF_TOKEN: 'hf_fixture_refresh_token_000001' },
    before: [hfRow('fixture-org/refresh-alpha'), hfRow('fixture-org/refresh-beta')],
    after: [hfRow('fixture-org/refresh-gamma'), hfRow('fixture-org/refresh-alpha')],
    delayMs: 3000, oldName: 'refresh-beta', newName: 'refresh-gamma', keepName: 'refresh-alpha',
  },
  local: {
    name: 'local', word: 'Local', model: 'local/refresh-alpha',
    keys: {},
    before: ollama(['refresh-alpha', 'refresh-beta']),
    after: ollama(['refresh-gamma', 'refresh-alpha']),
    delayMs: 700, oldName: 'refresh-beta', newName: 'refresh-gamma', keepName: 'refresh-alpha',
  },
}

type Leg = { name: string; family?: FamilySpec; families: FamilyName[]; changed: boolean; dark: boolean }
const legOf = (name: string): Leg => {
  if (name === 'unchanged') return { name, family: FAMILIES.openrouter, families: ['openrouter'], changed: false, dark: false }
  if (name === 'dark') return { name, families: ['openrouter', 'gemini', 'huggingface', 'local'], changed: false, dark: true }
  const family = FAMILIES[name as FamilyName]
  if (!family) throw new Error(`unknown leg ${name}`)
  return { name, family, families: [family.name], changed: true, dark: false }
}
console.log(`bundle ${DIST}\nscratch ${SCRATCH}`)

for (const legName of LEGS) {
  const leg = legOf(legName)
  for (const [cols, rows] of SIZES) {
    const tag = `${leg.name}-${cols}x${rows}`
    const home = join(SCRATCH, tag)
    const cwd = join(home, 'work')
    mkdirSync(cwd, { recursive: true })
    seedFirstRun(home, [cwd])
    writeFileSync(join(home, 'settings.json'), '{}')
    const captureFile = join(home, 'wire.jsonl')
    const catalogueFile = join(home, 'catalogue.json')
    writeFileSync(captureFile, '')
    const families: Record<string, unknown> = {}
    for (const name of leg.families) {
      const spec = FAMILIES[name]
      families[name] = { before: spec.before, after: leg.changed ? spec.after : spec.before, delayMs: spec.delayMs }
    }
    writeFileSync(catalogueFile, JSON.stringify({ families, switchOn: 'turn' }))
    const fixture = spawn(NODE, [join(ROOT, 'scripts/journey/model-refresh-families-fixture-server.ts'), captureFile, catalogueFile], { stdio: ['ignore', 'pipe', 'pipe'] })
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
        ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: base,
        MERCURY_OPENAI_CHATGPT_BASE: DEAD, MERCURY_OPENAI_API_BASE: `${DEAD}/v1`, MERCURY_OPENAI_AUTH_BASE: DEAD,
        MERCURY_OPENROUTER_API_BASE: `${base}/or/v1`,
        MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`, MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD, MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
        MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`, MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
        MERCURY_LOCAL_PROBE_TARGETS: leg.families.includes('local') ? `ollama=${base}/ollama` : 'none',
        MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
        MERCURY_TABULA_DIR: join(home, 'tabula'), MERCURY_HOME: join(home, 'proof-home'),
        MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
        MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0',
        MERCURY_CRITTER: 'clam', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
        MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0',
        MERCURY_TERMINAL_TITLE: '0', MERCURY_UPDATE_NOTICE: '0', MERCURY_OPERATOR: 'sam',
        MERCURY_CAP_FAILOVER: '0',
      }
      for (const name of leg.families) Object.assign(env, FAMILIES[name].keys)
      if (leg.dark) env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      const out = join(home, 'grid.json')
      const cfg = join(home, 'cfg.json')
      const landed = cols >= 100 && rows >= 26 ? '← back' : '1 session on'
      const ready = cols >= 100 && rows >= 26 ? 'ready · ' : '1 session on'
      const family = leg.family
      const walk = family?.name === 'local'
      const tight = !leg.dark && cols < 100 && rows >= 20
      const noticeWords = family ? `${family.word} — the live list changed; rows updated` : ''
      const DOWN = '\x1b[B'
      const sends = leg.dark
        ? [
            { requireAwait: true, awaitText: 'New Session', minTick: 3, awaitSettleTicks: 2, data: '\r' },
            { requireAwait: true, awaitText: landed, minTick: 15, awaitSettleTicks: 3, data: '/model\r', mark: 'open' },
            { requireAwait: true, awaitText: 'catalogue off', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'cached' },
            { afterPrevTicks: 30, data: '', mark: 'refreshed' },
          ]
        : [
            { requireAwait: true, awaitText: 'New Session', minTick: 3, awaitSettleTicks: 2, data: '\r' },
            { requireAwait: true, awaitText: landed, minTick: 15, awaitSettleTicks: 3, data: '/model\r', mark: 'prime' },
            { requireAwait: true, awaitText: walk ? 'CHOOSE A MODEL' : family!.keepName, minTick: 1, awaitSettleTicks: 3, data: '\x1b', mark: 'primed' },
            { requireAwait: true, awaitText: 'Kept model as', minTick: 1, awaitSettleTicks: 2, data: '' },
            { requireAwait: true, awaitText: landed, minTick: 2, awaitSettleTicks: 3, data: 'hello\r' },
            { requireAwait: true, awaitText: 'alpha answers from the fixture', minTick: 4, awaitSettleTicks: 3, data: '', mark: 'turn' },
            { requireAwait: true, awaitText: ready, minTick: 3, awaitSettleTicks: 3, data: '/model\r', mark: 'open' },
            ...(walk ? [{ requireAwait: true, awaitText: 'CHOOSE A MODEL', minTick: 1, awaitSettleTicks: 2, data: DOWN.repeat(60) }] : []),
            { requireAwait: true, awaitText: tight ? family!.keepName : family!.oldName, minTick: 1, awaitSettleTicks: 1, data: '', mark: 'cached' },
            leg.changed
              ? { afterPrevTicks: 60, awaitText: tight ? noticeWords : family!.newName, awaitSettleTicks: 2, data: '', mark: 'refreshed' }
              : { afterPrevTicks: 40, data: '', mark: 'refreshed' },
          ]
      const argv = family && !walk ? [NODE, DIST, '--model', family.model] : [NODE, DIST]
      writeFileSync(cfg, JSON.stringify({ argv, cwd, cols, rows, total: 600, stableTicks: 4, sends, out }))
      const status = await new Promise<number>((resolveCapture, reject) => {
        execFile(driver.python, [captureEngineEntry(driver, ROOT), cfg], { env, cwd, timeout: vshotBudgetMs(240_000) }, (error, _stdout, stderr) => {
          if (error && !existsSync(out)) reject(new Error(`${error}\n${stderr}`))
          else { if (error) console.log(stderr); resolveCapture(error ? Number(error.code) || 1 : 0) }
        })
      })
      const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
      const wire = readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire)
      const markOf = (label: string): string => { const mark = payload.marks?.find(m => m.label === label); return mark ? text(mark.grid) : '' }
      const cached = markOf('cached')
      const refreshed = markOf('refreshed') || text(payload.grid)
      if (FRAMES) {
        writeFileSync(join(FRAMES, `${tag}-cached.txt`), cached + '\n')
        writeFileSync(join(FRAMES, `${tag}-refreshed.txt`), refreshed + '\n')
        writeFileSync(join(FRAMES, `${tag}-grid.json`), JSON.stringify(payload))
        writeFileSync(join(FRAMES, `${tag}-wire.jsonl`), readFileSync(captureFile))
      }
      check(`${tag}: the drive reached every state`, status === 0 && payload.sendReceipts?.length === sends.length, `${payload.sendReceipts?.length}/${sends.length}; ${payload.endReason}`)
      const requestsOf = (name: string): Wire[] => wire.filter(event => event.kind === 'models' && event.family === name)
      const sendIndex = (mark: string): number => sends.findIndex(send => (send as { mark?: string }).mark === mark)
      const openAt = payload.sendReceipts?.[sendIndex('open')]?.ts ?? Infinity
      const cachedAt = payload.sendReceipts?.[sendIndex('cached')]?.ts ?? Infinity
      const full = cached.includes('CHOOSE A MODEL')
      if (leg.dark) {
        for (const name of ['openrouter', 'gemini', 'huggingface'] as const) {
          check(`${tag}: ${FAMILIES[name].word} sends nothing with catalogue traffic switched off`, requestsOf(name).length === 0, `models requests ${requestsOf(name).length}`)
          check(`${tag}: the ${FAMILIES[name].word} rows read catalogue off`, cached.includes(`${FAMILIES[name].word} — catalogue off`) || !full)
        }
        check(`${tag}: the local probe stays exempt from the switch (the gate's own law)`, requestsOf('local').length >= 1, `tags requests ${requestsOf('local').length}`)
        check(`${tag}: no notice line paints`, !refreshed.includes('the live list changed'))
        continue
      }
      const spec = family!
      const turn = wire.find(event => event.kind === 'turn')
      const requests = requestsOf(spec.name)
      const primed = requests.filter(event => event.at < (turn?.at ?? Infinity))
      const afterOpen = requests.filter(event => event.at >= openAt)
      const between = requests.filter(event => event.at >= (turn?.at ?? Infinity) && event.at < openAt)
      const landed = wire.filter(event => event.kind === 'landed' && event.family === spec.name && event.at >= openAt).at(-1)
      check(`${tag}: the turn reached the fixture and the list was read at least once before it`, turn !== undefined && primed.length >= 1, `turn ${turn !== undefined}; primed reads ${primed.length}`)
      check(`${tag}: nothing polls the list between the turn and the open`, between.length === 0, `reads ${between.length}`)
      check(`${tag}: opening makes exactly one background list request within the cache span`, afterOpen.length === 1 && afterOpen[0]!.phase === 'after', `reads after open ${afterOpen.length}`)
      if (tight) check(`${tag}: the cached frame shows the current row and no notice before the delayed refresh lands`, current(cached, spec.keepName) && !cached.includes(noticeWords) && (landed === undefined || cachedAt < landed.at), `cachedAt ${cachedAt} landed ${landed?.at}`)
      else check(`${tag}: the cached rows paint before the delayed refresh lands`, live(cached, spec.oldName) && (walk || current(cached, spec.keepName)) && !live(cached, spec.newName) && (landed === undefined || cachedAt < landed.at), `cachedAt ${cachedAt} landed ${landed?.at}`)
      for (const other of (['openrouter', 'gemini', 'huggingface', 'local'] as const).filter(name => name !== spec.name)) {
        check(`${tag}: the keyless ${FAMILIES[other].word} family sends nothing`, requestsOf(other).length === 0, `models requests ${requestsOf(other).length}`)
      }
      if (leg.changed) {
        if (!tight) check(`${tag}: the new rows replace the old live rows in place`, live(refreshed, spec.newName) && !live(refreshed, spec.oldName), refreshed.split('\n').filter(l => l.includes('efresh')).join(' | '))
        if (!walk) check(`${tag}: the highlight stays on ${spec.model} after its row moves`, current(refreshed, spec.keepName) && (refreshed.includes(`${spec.model} · model IDs`) || !full), refreshed.split('\n').filter(l => l.includes('model IDs')).join(' | '))
        else check(`${tag}: the kept row is still live after the refresh`, live(refreshed, spec.keepName), refreshed.split('\n').filter(l => l.includes('refresh-')).join(' | '))
        if (full) check(`${tag}: the notice names the family and the changed list`, refreshed.includes(noticeWords), refreshed.split('\n').filter(l => l.includes('changed')).join(' | '))
      } else {
        check(`${tag}: an unchanged list keeps the rows as they were`, live(refreshed, spec.oldName) && (walk || current(refreshed, spec.keepName)) && !live(refreshed, spec.newName))
        check(`${tag}: an unchanged list paints no notice`, !refreshed.includes('the live list changed'), refreshed.split('\n').filter(l => l.includes('catalogue')).join(' | '))
      }
    } finally {
      fixture.kill('SIGTERM')
    }
  }
}
console.log(`${checks} checks, ${failures} failures; worlds kept at ${SCRATCH}`)
process.exit(failures === 0 ? 0 : 1)
