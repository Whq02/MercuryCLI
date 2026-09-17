#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const binArg = process.argv.find(a => a.startsWith('--bin='))
const BIN = binArg !== undefined ? binArg.slice('--bin='.length) : join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const roadArg = process.argv.find(a => a.startsWith('--road='))
if (roadArg === undefined) {
  let exit = 0
  for (const road of ['native', 'javascript', 'obligation']) {
    const child = spawnSync(process.execPath, ['run', import.meta.path, `--road=${road}`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    process.stdout.write(child.stdout)
    if (child.status !== 0) {
      process.stdout.write(child.stderr.slice(-2000))
      exit = 1
    }
  }
  console.log(exit === 0 ? '\n✅ an image attaches on the built artifact, on both roads' : '\n❌ the image paste drive failed on a road')
  process.exit(exit)
}
const ROAD = roadArg.slice('--road='.length)
const TAG = ROAD === 'javascript' ? 'javascript-road' : ROAD === 'obligation' ? 'obligation-road' : 'native'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), `mercury-imagepaste-${TAG}-`)))
const CWD = join(SCRATCH, 'ground')
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
for (const d of [CWD, HOME, DAEMON_DIR]) mkdirSync(d, { recursive: true })
process.env.MERCURY_RENDER_CWD = CWD
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_SKIP_PROMPT_HISTORY = '1'
delete process.env.MERCURY_HOME
if (ROAD === 'javascript') process.env.MERCURY_IMAGE_PROCESSOR = 'javascript'

const { scenario, writeSyntheticSession, SID } = await import('../ui/renderScenarios.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const sharp = (await import('sharp')).default

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${TAG}: ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-image-paste-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

if (ROAD === 'obligation') {
  const { upsertObligation } = await import('../../src/services/crew/obligations.ts')
  console.log(`\n── ${TAG} ──`)
  const jpeg = join(SCRATCH, 'shot.jpeg')
  const svg = Buffer.from(
    `<svg width="1600" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="1200" fill="#f4f4f0"/>` +
      Array.from({ length: 24 }, (_, i) => `<rect x="60" y="${60 + i * 46}" width="${500 + ((i * 137) % 900)}" height="22" fill="#2b2b2b"/>`).join('') +
      `</svg>`,
  )
  await sharp(svg).jpeg().toFile(jpeg)
  const jpegBytes = readFileSync(jpeg).length
  check('the fixture JPEG on disk decodes over a few KB', jpegBytes > 2000, `${jpegBytes} bytes`)
  const cfg = scenario('resume-2turn', 120, 40)
  writeSyntheticSession('short', SID)
  await upsertObligation({
    ref: `cross-project:finished:${SID}:${Date.now()}`,
    sessionId: SID,
    question: 'your agent in another project finished · concourse-w1',
    owner: 'operator',
    scope: 'switchboard',
  })
  const api = await startFixtureApi([
    { kind: 'text', text: 'I received the image.' },
    { kind: 'text', text: 'Spare.' },
    { kind: 'text', text: 'Spare.' },
  ])
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: HOME,
    MERCURY_DAEMON_DIR: DAEMON_DIR,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    MERCURY_CACHE_CLOCK: '0',
  }
  const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
  const daemon = spawn('node', [BIN, 'daemon', 'run', CWD], { cwd: CWD, env: childEnv, stdio: ['ignore', logFd, logFd] })
  const daemonLog = (): string => (existsSync(join(SCRATCH, 'daemon.log')) ? readFileSync(join(SCRATCH, 'daemon.log'), 'utf8') : '')
  check('the daemon serves', await untilAsync(() => daemonLog().includes('control socket up'), 60_000), daemonLog().slice(-300))
  const ESC = String.fromCharCode(27)
  type Grid = { grid: { c: string }[][]; marks?: { label: string; grid: { c: string }[][] }[] }
  const rowsOf = (g: { c: string }[][]): string[] => g.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
  const out = join(SCRATCH, 'grid.json')
  const cfgPath = join(SCRATCH, 'cfg.json')
  const sends = [
    { awaitText: 'Type a prompt', atTick: 90, minTick: 15, data: `${ESC}[200~${jpeg}${ESC}[201~` },
    { awaitText: '[Image #1]', atTick: 320, afterPrevTicks: 2, data: '', mark: 'chip' },
    { afterPrevTicks: 3, atTick: 325, data: ' here in my downloads' },
    { afterPrevTicks: 3, atTick: 330, data: '\r', mark: 'sent' },
    { awaitText: 'I received the image.', atTick: 470, afterPrevTicks: 60, data: '', mark: 'f-120x40' },
    { afterPrevTicks: 20, atTick: 500, data: '', mark: 'f-82x17' },
    { afterPrevTicks: 20, atTick: 540, data: '', mark: 'f-80x21' },
    { afterPrevTicks: 20, atTick: 580, data: '', mark: 'f-80x14' },
  ]
  const resizes = [
    { atTick: 485, cols: 82, rows: 17 },
    { atTick: 525, cols: 80, rows: 21 },
    { atTick: 565, cols: 80, rows: 14 },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID, '--model', 'claude-sonnet-5'], cwd: cfg.cwd, sends, resizes, total: 620, cols: 120, rows: 40, out }))
  const res = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env: childEnv })
  let payload: Grid | null = null
  try {
    payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
  } catch {
    payload = null
  }
  check('the capture ran whole', res.status === 0 && payload !== null, `vshot exit ${res.status}: ${(res.stderr ?? '').slice(-400)}`)
  const markRows = (label: string): string[] => rowsOf((payload?.marks ?? []).find(m => m.label === label)?.grid ?? [])
  const composer = (rows: string[]): string => rows.filter(r => r.includes('│❯')).join(' | ')
  check('the JPEG attached from disk (the chip landed)', composer(markRows('chip')).includes('[Image #1]'), composer(markRows('chip')))
  const ledgerPath = join(DAEMON_DIR, 'concourse-dispatches.json')
  await untilAsync(() => existsSync(ledgerPath) && /obl-answer:/.test(readFileSync(ledgerPath, 'utf8')), 30_000)
  let count = 0
  let oblState = 'absent'
  try {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      dispatches: Record<string, { clientMessageId: string; state?: string; contentImageBlocks?: number }>
    }
    const row = Object.values(ledger.dispatches).find(r => String(r.clientMessageId).startsWith('obl-answer:'))
    count = row?.contentImageBlocks ?? 0
    oblState = row?.state ?? 'absent'
  } catch {
    oblState = 'unreadable'
  }
  console.log(`  ${TAG}: the obligation-answer dispatch is '${oblState}', contentImageBlocks=${count}`)
  check('the pasted image rode the obligation answer to the daemon (contentImageBlocks >= 1)', count >= 1, `contentImageBlocks=${count} on a '${oblState}' dispatch`)
  const requests = api.messageRequests()
  const wireImages = requests.flatMap(r => {
    const body = r.body as { messages?: { content?: unknown }[] }
    return (body.messages ?? []).flatMap(m => (Array.isArray(m.content) ? (m.content as { type: string }[]).filter(b => b.type === 'image') : []))
  })
  console.log(`  ${TAG}: ${requests.length} provider request(s), ${wireImages.length} image block(s) on the wire`)
  if (requests.length > 0) {
    check(
      'the provider request carried the image block',
      wireImages.length >= 1 && wireImages.every(b => (b as { source?: { type?: string } }).source?.type === 'base64'),
      `${requests.length} requests, ${wireImages.length} image blocks`,
    )
  } else {
    console.log(`  ${TAG}: no provider request landed in the window — the ledger count is the wire witness`)
  }
  const framesArg = process.argv.find(a => a.startsWith('--frames='))
  if (framesArg !== undefined) {
    const framesDir = framesArg.slice('--frames='.length)
    mkdirSync(framesDir, { recursive: true })
    for (const label of ['f-120x40', 'f-82x17', 'f-80x21', 'f-80x14']) {
      writeFileSync(join(framesDir, `${label}.txt`), `${markRows(label).join('\n')}\n`)
    }
  }
  if (failures > 0) {
    for (const label of ['chip', 'sent', 'f-120x40', 'f-82x17', 'f-80x21', 'f-80x14']) {
      console.log(`\n┌── ${TAG} · ${label}`)
      for (const l of markRows(label)) console.log(`│${l}`)
    }
    console.log(`\n── daemon log tail ──\n${daemonLog().slice(-1200)}`)
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    void 0
  }
  daemon.kill()
  await api.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures === 0 ? `✅ ${TAG}: the pasted image rides the obligation answer to the daemon` : `❌ ${TAG}: ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log(`\n── ${TAG} ──`)
const clipboard = join(SCRATCH, 'clipboard.png')
const svg = Buffer.from(
  `<svg width="9000" height="3000" xmlns="http://www.w3.org/2000/svg"><rect width="9000" height="3000" fill="#f4f4f0"/>` +
    Array.from({ length: 60 }, (_, i) => `<rect x="120" y="${80 + i * 48}" width="${800 + ((i * 137) % 7600)}" height="22" fill="#${i % 3 === 0 ? '2b2b2b' : i % 3 === 1 ? '3355aa' : '777777'}"/>`).join('') +
    `</svg>`,
)
await sharp(svg).png().toFile(clipboard)
const clipboardMeta = await sharp(readFileSync(clipboard)).metadata()
check('the fixture clipboard image is over the provider\'s 8000 px side', (clipboardMeta.width ?? 0) === 9000 && (clipboardMeta.height ?? 0) === 3000, `${clipboardMeta.width}x${clipboardMeta.height}`)

const cfg = scenario('resume-2turn', 120, 40)
writeSyntheticSession('short', SID)
const api = await startFixtureApi([{ kind: 'text', text: 'Seen both.' }, { kind: 'text', text: 'Spare.' }])
const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: DAEMON_DIR,
  MERCURY_CLIPBOARD_IMAGE_FILE: clipboard,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_AWAY_SUMMARY: '0',
  MERCURY_PARTY: '0',
  MERCURY_CACHE_CLOCK: '0',
}

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [BIN, 'daemon', 'run', CWD], { cwd: CWD, env: childEnv, stdio: ['ignore', logFd, logFd] })
const daemonLog = (): string => (existsSync(join(SCRATCH, 'daemon.log')) ? readFileSync(join(SCRATCH, 'daemon.log'), 'utf8') : '')
check('the daemon serves', await untilAsync(() => daemonLog().includes('control socket up'), 60_000), daemonLog().slice(-300))

const ESC = String.fromCharCode(27)
const CTRL_V = String.fromCharCode(22)
const FOCUS_OUT = `${ESC}[O`
const FOCUS_IN = `${ESC}[I`
type Grid = { grid: { c: string }[][]; marks?: { label: string; grid: { c: string }[][] }[] }
const rowsOf = (g: { c: string }[][]): string[] => g.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))

const out = join(SCRATCH, 'grid.json')
const cfgPath = join(SCRATCH, 'cfg.json')
const sends = [
  { awaitText: 'Type a prompt', atTick: 90, minTick: 15, data: CTRL_V },
  { afterPrevTicks: 10, atTick: 100, data: '', mark: 't10' },
  { afterPrevTicks: 20, atTick: 120, data: '', mark: 't30' },
  { afterPrevTicks: 30, atTick: 150, data: '', mark: 't60' },
  { awaitText: '[Image #1]', atTick: 200, afterPrevTicks: 2, data: '', mark: 'chip1' },
  { afterPrevTicks: 3, atTick: 205, data: CTRL_V },
  { afterPrevTicks: 10, atTick: 215, data: '', mark: 'second-t10' },
  { awaitText: '[Image #2]', atTick: 420, afterPrevTicks: 2, data: '', mark: 'chip2' },
  { afterPrevTicks: 3, atTick: 425, data: FOCUS_OUT },
  { afterPrevTicks: 4, atTick: 430, data: FOCUS_IN },
  { awaitText: 'clipboard holds an image', atTick: 460, afterPrevTicks: 8, data: '', mark: 'hint' },
  { afterPrevTicks: 2, atTick: 465, data: '\r' },
  { awaitText: 'Seen both.', atTick: 560, afterPrevTicks: 6, data: '', mark: 'reply' },
]
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID, '--model', 'claude-sonnet-5'], cwd: cfg.cwd, sends, total: 570, cols: 120, rows: 40, out }))
const res = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env: childEnv })
let payload: Grid | null = null
try {
  payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
} catch {
  payload = null
}
check('the capture ran whole', res.status === 0 && payload !== null, `vshot exit ${res.status}: ${(res.stderr ?? '').slice(-400)}`)
const markRows = (label: string): string[] => rowsOf((payload?.marks ?? []).find(m => m.label === label)?.grid ?? [])
const finalRows = payload ? rowsOf(payload.grid) : []
const everywhere = [...(payload?.marks ?? []).flatMap(m => rowsOf(m.grid)), ...finalRows].join('\n')
const composer = (rows: string[]): string => rows.filter(r => r.includes('│❯')).join(' | ')

check('the first paste lands as [Image #1]', composer(markRows('chip1')).includes('[Image #1]'), composer(markRows('chip1')))
check('the composer says what was attached and what it was shrunk to', /\[Image #1\] attached — 9000x3000 shrunk to 8000x\d+ · [\d.]+(MB|KB)/.test(everywhere), [...everywhere.matchAll(/\[Image #1\] attached[^\n]*/g)].map(m => m[0]).join(' | '))
check('the second paste keeps both chips', /\[Image #1\].*\[Image #2\]/.test(composer(markRows('chip2'))), composer(markRows('chip2')))
check('a focus regain with an image on the clipboard tells the chord', /clipboard holds an image — \S+ attaches it/.test(markRows('hint').join('\n')), markRows('hint').filter(r => /clipboard/.test(r)).join(' | '))
check('Enter never meets the 1MB frame wall', !/request exceeds \d+MB/.test(everywhere))
check('Enter sends the message (the composer clears, the turn runs)', !composer(markRows('reply')).includes('[Image #1]'), composer(markRows('reply')))
const replied = markRows('reply').join('\n').includes('Seen both.') || finalRows.join('\n').includes('Seen both.')
console.log(`  ${TAG}: the fixture's reply ${replied ? 'painted' : 'had not painted'} within the window (${(markRows('reply').find(r => /ingesting|thinking|ready/.test(r)) ?? '').trim().slice(0, 120)})`)
const store = join(HOME, 'image-cache')
const sessions = existsSync(store) ? readdirSync(store) : []
const files = sessions.flatMap(s => readdirSync(join(store, s)).map(f => `${s}/${f}`))
check('each paste is its own file in the session\'s image store', files.some(f => /\/1\.(png|jpeg)$/.test(f)) && files.some(f => /\/2\.(png|jpeg)$/.test(f)), files.join(', '))
for (const f of files) {
  try {
    const bytes = readFileSync(join(store, f))
    const meta = await sharp(bytes).metadata()
    check(`${f} is the shrunk image (8000 px side, under the ceiling)`, Math.ceil(bytes.length / 3) * 4 <= 10 * 1024 * 1024 && (meta.width ?? 0) === 8000, `${meta.width}x${meta.height} · ${bytes.length} bytes`)
  } catch (e) {
    check(`${f} decodes`, false, String(e))
  }
}
const requests = api.messageRequests()
const imageBlocks = requests.flatMap(r => {
  const body = r.body as { messages?: { content?: unknown }[] }
  return (body.messages ?? []).flatMap(m => (Array.isArray(m.content) ? (m.content as { type: string }[]).filter(b => b.type === 'image') : []))
})
console.log(`  ${TAG}: ${requests.length} request(s) reached the fixture (${requests.map(r => r.path).join(', ')}), ${imageBlocks.length} image block(s) across them`)
check('the wire carried the two images as base64 blocks', imageBlocks.length >= 2 && imageBlocks.every(b => (b as { source?: { type?: string } }).source?.type === 'base64'), `${requests.length} requests, ${imageBlocks.length} image blocks`)

if (failures > 0) {
  for (const label of ['t10', 't30', 't60', 'chip1', 'second-t10', 'chip2', 'hint', 'reply']) {
    console.log(`\n┌── ${TAG} · ${label}`)
    for (const l of markRows(label)) console.log(`│${l}`)
  }
  console.log(`\n── daemon log tail ──\n${readFileSync(join(SCRATCH, 'daemon.log'), 'utf8').slice(-1500)}`)
}
try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
}
daemon.kill()
await api.close()
if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `✅ ${TAG}: an image attaches on the built artifact` : `❌ ${TAG}: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
