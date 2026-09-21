#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const framesArg = process.argv.find(a => a.startsWith('--frames='))
const FRAMES = framesArg === undefined ? null : framesArg.slice('--frames='.length)

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-queuedimage-')))
const CWD = join(SCRATCH, 'ground')
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
for (const d of [CWD, HOME, DAEMON_DIR]) mkdirSync(d, { recursive: true })
writeFileSync(join(CWD, 'README.md'), '# ground\n\nThe readme the first turn reads.\n')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { STORED_IMAGE_SOURCE_TYPE } = await import('../../src/utils/imageStore.ts')
const sharp = (await import('sharp')).default
seedFirstRun(HOME, [CWD])

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      void 0
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-queued-image-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
const python = driver.python
const runCapture = (cfgPath: string, env: Record<string, string>, timeoutMs: number): Promise<{ status: number | null; stderr: string }> =>
  new Promise(resolve => {
    const child = spawn(python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', c => {
      stderr += String(c)
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ status: code, stderr })
    })
  })

console.log('============================================================')
console.log(' an image pasted while a turn runs reaches the wire as bytes')
console.log(`  bundle: ${BIN}`)
console.log('============================================================')

const png = join(SCRATCH, 'shot.png')
const svg = Buffer.from(
  `<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="500" fill="#f4f4f0"/>` +
    Array.from({ length: 12 }, (_, i) => `<rect x="40" y="${40 + i * 36}" width="${300 + ((i * 137) % 400)}" height="18" fill="#${i % 3 === 0 ? '2b2b2b' : i % 3 === 1 ? '3355aa' : '777777'}"/>`).join('') +
    `</svg>`,
)
await sharp(svg).png().toFile(png)
const pngBytes = readFileSync(png)
check('the fixture PNG is on disk', pngBytes.length > 500, `${pngBytes.length} bytes`)

const HOLD = 'holding the turn open while the operator pastes'
const FIRST = 'look at the readme'
const QUEUED = 'what is in this image'
const RESUMED = 'once more please'
const api = await startFixtureApi([
  {
    kind: 'paced_tool_use',
    preDeltas: Array.from({ length: 44 }, (_, i) => (i === 0 ? HOLD : ' ·')),
    gapMs: 500,
    tools: [{ name: 'Read', input: { file_path: join(CWD, 'README.md') } }],
    whenModel: 'sonnet',
    whenBody: FIRST,
  },
  { kind: 'text', text: 'Seen the image.', whenModel: 'sonnet', whenBody: QUEUED },
  { kind: 'text', text: 'Seen it again.', whenModel: 'sonnet', whenBody: RESUMED },
  ...Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'Spare.' })),
])
const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: DAEMON_DIR,
  MERCURY_TEAMS_DIR: join(SCRATCH, 'teams'),
  MERCURY_TABULA_DIR: join(SCRATCH, 'tabula'),
  MERCURY_HOME: join(SCRATCH, 'proof-home'),
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_AWAY_SUMMARY: '0',
  MERCURY_PARTY: '0',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_OPERATOR: 'sam',
  BROWSER: '/usr/bin/true',
  VISUAL: '',
  EDITOR: '',
}

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [BIN, 'daemon', 'run', CWD], { cwd: CWD, env: childEnv, stdio: ['ignore', logFd, logFd] })
const daemonLog = (): string => (existsSync(join(SCRATCH, 'daemon.log')) ? readFileSync(join(SCRATCH, 'daemon.log'), 'utf8') : '')
check('the daemon serves', await untilAsync(() => daemonLog().includes('control socket up'), 60_000), daemonLog().slice(-300))

const ESC = String.fromCharCode(27)
type Grid = { grid: { c: string }[][]; marks?: { label: string; grid: { c: string }[][] }[]; sendReceipts?: unknown; endReason?: string }
const rowsOf = (g: { c: string }[][]): string[] => g.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
type ImageOnWire = { type: string; mediaType: string; dataChars: number; sha256: string | null }
type WireBody = { model?: string; messages?: { role?: string; content?: unknown }[] }
const imagesOf = (body: unknown): ImageOnWire[] => {
  const messages = (body as WireBody | null)?.messages ?? []
  const out: ImageOnWire[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as { type?: string; source?: { type?: string; media_type?: string; data?: string } }[]) {
      if (block.type !== 'image') continue
      const source = block.source ?? {}
      out.push({
        type: String(source.type ?? ''),
        mediaType: String(source.media_type ?? ''),
        dataChars: typeof source.data === 'string' ? source.data.length : 0,
        sha256: typeof source.data === 'string' ? sha256(Buffer.from(source.data, 'base64')) : null,
      })
    }
  }
  return out
}
const requestsSaying = (words: string): { n: number; body: unknown }[] =>
  api
    .messageRequests()
    .map((r, i) => ({ n: i + 1, body: r.body }))
    .filter(r => JSON.stringify(r.body).includes(words))
const describe = (images: ImageOnWire[]): string => JSON.stringify(images.map(i => `${i.type}:${i.mediaType}:${i.dataChars}:${i.sha256 === null ? '-' : i.sha256.slice(0, 12)}`))

async function capture(tag: string, argv: string[], sends: unknown[], ready: string, total: number): Promise<{ payload: Grid | null; status: number | null; stderr: string }> {
  const out = join(SCRATCH, `${tag}.json`)
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv, cwd: CWD, sends, total, cols: 120, rows: 40, out, readyText: ready, stableTicks: 6 }))
  const res = await runCapture(cfgPath, childEnv, vshotBudgetMs(300_000))
  let payload: Grid | null = null
  try {
    payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
  } catch {
    payload = null
  }
  return { payload, status: res.status, stderr: res.stderr }
}
const markRows = (payload: Grid | null, label: string): string[] => rowsOf((payload?.marks ?? []).find(m => m.label === label)?.grid ?? [])
const composer = (rows: string[]): string => rows.filter(r => r.includes('│❯')).join(' | ')
const storedFiles = (): string[] => {
  const store = join(HOME, 'image-cache')
  if (!existsSync(store)) return []
  return readdirSync(store).flatMap(s => readdirSync(join(store, s)).map(f => join(store, s, f)))
}
const transcriptFile = (): string | null => {
  const projects = join(HOME, 'projects')
  if (!existsSync(projects)) return null
  const files: { file: string; mtime: number }[] = []
  for (const proj of readdirSync(projects)) {
    const dir = join(projects, proj)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || f.endsWith('.receipts.jsonl')) continue
      files.push({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files[0]?.file ?? null
}
const transcriptRecords = (): Record<string, unknown>[] => {
  const file = transcriptFile()
  if (file === null) return []
  const records: Record<string, unknown>[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      void 0
    }
  }
  return records
}

console.log('\n── leg 1: the paste lands while the first turn holds ──')
const leg1 = await capture(
  'leg1',
  ['node', BIN, '--model', 'claude-sonnet-5'],
  [
    { atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' },
    { requireAwait: true, awaitText: 'ready · type a prompt', awaitSettleTicks: 5, data: `${FIRST}\r`, mark: 'typed' },
    { requireAwait: true, awaitText: 'holding the turn open', awaitSettleTicks: 2, data: `${ESC}[200~${png}${ESC}[201~`, mark: 'hold' },
    { requireAwait: true, awaitText: '[Image #1]', awaitSettleTicks: 2, data: QUEUED, mark: 'chip' },
    { afterPrevTicks: 3, data: '\r', mark: 'sent' },
    { requireAwait: true, awaitText: 'Seen the image.', data: '', mark: 'reply' },
  ],
  'Seen the image.',
  1150,
)
check('leg 1: the capture ran whole', leg1.status === 0 && leg1.payload !== null, `vshot exit ${leg1.status}: ${leg1.stderr.slice(-400)}`)
check('leg 1: the first prompt started a turn the fixture holds open', markRows(leg1.payload, 'hold').some(r => r.includes(FIRST)) && markRows(leg1.payload, 'hold').some(r => r.includes('holding the turn open')), markRows(leg1.payload, 'hold').filter(r => /❯|holding/.test(r)).join(' | '))
check('leg 1: the paste landed as [Image #1] while the turn ran', composer(markRows(leg1.payload, 'chip')).includes('[Image #1]'), composer(markRows(leg1.payload, 'chip')))
const stored = storedFiles()
check('leg 1: the paste is a file in the image store', stored.length === 1, stored.join(', '))
const storedSha = stored.length === 1 ? sha256(readFileSync(stored[0]!)) : ''
console.log(`  store: ${stored.join(', ')} · sha256 ${storedSha.slice(0, 12)} · fixture sha256 ${sha256(pngBytes).slice(0, 12)}`)
await untilAsync(() => requestsSaying(QUEUED).length >= 1, vshotBudgetMs(20_000))
const records1 = transcriptRecords()
const queuedRow = records1.find(r => {
  const payload = r.payload as { kind?: string; attachmentType?: string; fields?: { prompt?: unknown } } | undefined
  return payload?.kind === 'attachment' && payload.attachmentType === 'queued_command' && JSON.stringify(payload.fields?.prompt ?? '').includes(QUEUED)
})
const inputRow = records1.find(r => {
  const payload = r.payload as { kind?: string; content?: unknown } | undefined
  return payload?.kind === 'input' && JSON.stringify(payload.content ?? '').includes(QUEUED)
})
check('leg 1: the words folded into the running turn as a queued_command row (not a new turn)', queuedRow !== undefined && inputRow === undefined, `queued row ${queuedRow === undefined ? 'absent' : 'present'} · input row ${inputRow === undefined ? 'absent' : 'present'} · ${records1.length} records in ${transcriptFile() ?? 'no transcript'}`)
const queuedPrompt = ((queuedRow?.payload as { fields?: { prompt?: unknown } } | undefined)?.fields?.prompt ?? null) as { type?: string; source?: { type?: string; path?: string } }[] | null
const rowImage = Array.isArray(queuedPrompt) ? queuedPrompt.find(b => b.type === 'image') : undefined
check('leg 1: the transcript row keeps the image as a store reference', rowImage !== undefined && rowImage.source?.type === STORED_IMAGE_SOURCE_TYPE && stored.includes(String(rowImage.source.path ?? '')), JSON.stringify(rowImage?.source ?? null).slice(0, 200))
const folded = requestsSaying(QUEUED)
check('leg 1: the next request after the fold reached the wire', folded.length >= 1, `${api.messageRequests().length} message request(s)`)
const foldedImages = folded.flatMap(r => imagesOf(r.body))
console.log(`  leg 1 wire: request(s) ${folded.map(r => r.n).join(',')} · image blocks ${describe(foldedImages)}`)
check('leg 1: the wire carries no store reference', foldedImages.length >= 1 && foldedImages.every(i => i.type !== STORED_IMAGE_SOURCE_TYPE), describe(foldedImages))
check('leg 1: the wire carries the pasted bytes as base64', foldedImages.some(i => i.type === 'base64' && i.sha256 === storedSha), describe(foldedImages))
check('leg 1: the fixture\'s reply landed on the glass', markRows(leg1.payload, 'reply').some(r => r.includes('Seen the image.')), markRows(leg1.payload, 'reply').filter(r => /Mercury\]/.test(r)).join(' | '))

console.log('\n── leg 2: the session brought back with the row in its history ──')
const leg2 = await capture(
  'leg2',
  ['node', BIN, '--continue', '--model', 'claude-sonnet-5'],
  [
    { requireAwait: true, awaitText: 'ready · type a prompt', awaitSettleTicks: 5, data: `${RESUMED}\r`, mark: 'typed2' },
    { requireAwait: true, awaitText: 'Seen it again.', data: '', mark: 'reply2' },
  ],
  'Seen it again.',
  750,
)
check('leg 2: the capture ran whole', leg2.status === 0 && leg2.payload !== null, `vshot exit ${leg2.status}: ${leg2.stderr.slice(-400)}`)
check('leg 2: the session came back with its history on the glass', markRows(leg2.payload, 'typed2').some(r => r.includes(FIRST)), markRows(leg2.payload, 'typed2').filter(r => /❯/.test(r)).join(' | '))
await untilAsync(() => requestsSaying(RESUMED).length >= 1, vshotBudgetMs(20_000))
const resumed = requestsSaying(RESUMED)
check('leg 2: the resumed session\'s send reached the wire', resumed.length >= 1, `${api.messageRequests().length} message request(s)`)
const resumedImages = resumed.flatMap(r => imagesOf(r.body))
console.log(`  leg 2 wire: request(s) ${resumed.map(r => r.n).join(',')} · image blocks ${describe(resumedImages)}`)
check('leg 2: the history\'s image reaches the wire as no store reference', resumedImages.length >= 1 && resumedImages.every(i => i.type !== STORED_IMAGE_SOURCE_TYPE), describe(resumedImages))
check('leg 2: the history\'s image reaches the wire as the pasted bytes', resumedImages.some(i => i.type === 'base64' && i.sha256 === storedSha), describe(resumedImages))
check('leg 2: the fixture\'s reply landed on the glass', markRows(leg2.payload, 'reply2').some(r => r.includes('Seen it again.')), markRows(leg2.payload, 'reply2').filter(r => /Mercury\]/.test(r)).join(' | '))
const records2 = transcriptRecords()
const stillReference = records2.some(r => {
  const payload = r.payload as { kind?: string; attachmentType?: string; fields?: { prompt?: unknown } } | undefined
  return payload?.kind === 'attachment' && payload.attachmentType === 'queued_command' && JSON.stringify(payload.fields?.prompt ?? '').includes(STORED_IMAGE_SOURCE_TYPE)
})
const bytesInTranscript = records2.some(r => JSON.stringify(r).includes(pngBytes.toString('base64').slice(0, 64)))
check('leg 2: the transcript still keeps the reference, never the bytes', stillReference && !bytesInTranscript, `${records2.length} records · reference ${stillReference ? 'kept' : 'gone'} · bytes ${bytesInTranscript ? 'present' : 'absent'}`)

const evidence = [[leg1.payload, 'face'], [leg1.payload, 'typed'], [leg1.payload, 'hold'], [leg1.payload, 'chip'], [leg1.payload, 'sent'], [leg1.payload, 'reply'], [leg2.payload, 'typed2'], [leg2.payload, 'reply2']] as const
if (FRAMES !== null) {
  mkdirSync(FRAMES, { recursive: true })
  for (const [payload, label] of evidence) writeFileSync(join(FRAMES, `${label}-120x40.txt`), `${markRows(payload, label).join('\n')}\n`)
  writeFileSync(join(FRAMES, 'leg1-final-120x40.txt'), `${(leg1.payload ? rowsOf(leg1.payload.grid) : []).join('\n')}\n`)
  writeFileSync(join(FRAMES, 'leg2-final-120x40.txt'), `${(leg2.payload ? rowsOf(leg2.payload.grid) : []).join('\n')}\n`)
  writeFileSync(join(FRAMES, 'wire-images.json'), `${JSON.stringify({ bundle: BIN, leg1: { requests: folded.map(r => r.n), images: foldedImages }, leg2: { requests: resumed.map(r => r.n), images: resumedImages }, storedSha256: storedSha, fixtureSha256: sha256(pngBytes) }, null, 2)}\n`)
  if (queuedRow !== undefined) writeFileSync(join(FRAMES, 'queued-command-row.json'), `${JSON.stringify(queuedRow, null, 2)}\n`)
  writeFileSync(join(FRAMES, 'capture-receipts.json'), `${JSON.stringify({ leg1: { receipts: leg1.payload?.sendReceipts, end: leg1.payload?.endReason }, leg2: { receipts: leg2.payload?.sendReceipts, end: leg2.payload?.endReason } }, null, 2)}\n`)
}
if (failures > 0) {
  for (const [payload, label] of evidence) {
    console.log(`\n┌── ${label}`)
    for (const l of markRows(payload, label)) console.log(`│${l}`)
  }
  console.log(`\n── daemon log tail ──\n${daemonLog().slice(-1500)}`)
}
try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
  void 0
}
daemon.kill()
await api.close()
if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ an image pasted while a turn runs reaches the wire as bytes, and a resumed session sends them again' : `\n❌ ${failures} failure(s) (scratch kept at ${SCRATCH})`)
process.exit(failures === 0 ? 0 : 1)
