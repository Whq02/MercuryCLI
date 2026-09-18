#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const HINT = keyHintLabel('⇧→ concourse')
const REFUSAL = /needs \d+ rows|this window is|needs at least|terminal too small|too small for|resize to continue/i

const tree = DIST === join(ROOT, 'dist', 'mercury.mjs') ? ROOT : dirname(dirname(DIST))
const driver = requireCaptureDriver('face-update-line')
const printed = spawnSync(productNode(), [DIST, '--version'], { encoding: 'utf8', timeout: 60_000 }).stdout ?? ''
const RUNNING = printed.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0] ?? ''
if (RUNNING === '') {
  console.log(`  [FAIL] the bundle did not print its version (${printed.slice(0, 80)})`)
  process.exit(1)
}
const bump = (version: string, by: number): string => version.replace(/(\d+)$/, m => String(Number(m) + by))
const NEWER = bump(RUNNING, 1)
const NEWER_STILL = bump(RUNNING, 2)
const noticeOf = (version: string): string => `v${version} available · mercury update`
const framesDir = process.env.FACE_LINE_FRAMES_DIR ?? ''
if (framesDir !== '') mkdirSync(framesDir, { recursive: true })

const fixtureCwd = join(realpathSync(scratch), 'face-update-line-cwd')
mkdirSync(fixtureCwd, { recursive: true })
console.log(`face update line artifacts: ${scratch} (dist ${DIST}, running ${RUNNING})`)

type Cache = { schema: 1; checkedAtMs: number; runningVersion: string; available?: { version: string; tag: string }; faceAnnounced?: string }
const cachePath = (home: string): string => join(home, 'update-notice.json')
const seedCache = (home: string, version: string, keep: Partial<Cache> = {}): void => {
  const cache: Cache = { schema: 1, checkedAtMs: Date.now(), runningVersion: RUNNING, available: { version, tag: `v${version}` }, ...keep }
  writeFileSync(cachePath(home), JSON.stringify(cache))
}
const readCache = (home: string): Cache | null => {
  try {
    return JSON.parse(readFileSync(cachePath(home), 'utf8')) as Cache
  } catch {
    return null
  }
}

async function capture(tag: string, home: string, cols: number, rows: number, extra: Record<string, string | undefined>, leg: Awaited<ReturnType<typeof startLeg>>): Promise<{ status: number | null; rows: string[]; endReason: string; stderr: string }> {
  const out = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST], cwd: fixtureCwd, cols, rows, sends: [], resizes: [], readyText: FACE_READY, readySettleTicks: 4, stableTicks: 4, total: 120, out }))
  const env = childEnv(leg, {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DESKTOP_DRIVER: 'none',
    MERCURY_SPLASH: 'off',
    MERCURY_UPDATE_NOTICE: undefined,
    MERCURY_UPDATE_API_BASE_URL: 'http://127.0.0.1:9',
    MERCURY_GH_CMD: JSON.stringify(['/usr/bin/false']),
    ...extra,
  })
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', chunk => { stderr += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(120 * 200 + 60_000))
    child.once('error', () => { clearTimeout(wall); resolve(null) })
    child.once('exit', code => { clearTimeout(wall); resolve(code) })
  })
  const payload = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; endReason?: string } : null
  const lines = payload === null ? [] : payload.grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
  writeFileSync(join(scratch, `${tag}.txt`), lines.join('\n') + '\n')
  if (framesDir !== '') writeFileSync(join(framesDir, `${tag}.txt`), lines.join('\n') + '\n')
  printFrame(`${tag} (${cols}x${rows})`, lines)
  return { status, rows: lines, endReason: payload?.endReason ?? '', stderr }
}

const compactRow = (cols: number, notice: string): string => ' '.repeat(cols - notice.length - 3 - HINT.length - 2) + notice + '   ' + HINT
const fullRow = (cols: number, notice: string): string => '  ' + HINT + ' '.repeat(cols - 2 - HINT.length - notice.length - 2) + notice
const plainCompactRow = (cols: number): string => ' '.repeat(cols - HINT.length - 2) + HINT
const plainFullRow = '  ' + HINT

const sizes: Array<[number, number]> = [[80, 21], [80, 14], [82, 17], [120, 40]]
console.log(`\n§1 the first boot after a newer release is cached paints the line once, at every size (${sizes.map(s => s.join('x')).join(', ')})`)
for (const [cols, rows] of sizes) {
  const tag = `face-line-first-${cols}x${rows}`
  const home = join(scratch, `home-${tag}`)
  seedFirstRun(home, [tree, fixtureCwd])
  seedCache(home, NEWER)
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const r = await capture(tag, home, cols, rows, {}, leg)
    const last = r.rows[rows - 1] ?? ''
    const compact = cols < 100 || rows < 26
    check(`${cols}x${rows}: the face painted and settled (${r.endReason})`, r.status === 0 && joined(r.rows).includes(FACE_READY) && r.endReason !== 'budget', r.stderr.slice(-400))
    check(`${cols}x${rows}: the bottom-right corner carries the notice beside the key-map hint`, last === (compact ? compactRow(cols, noticeOf(NEWER)) : fullRow(cols, noticeOf(NEWER))), JSON.stringify(last))
    check(`${cols}x${rows}: the notice appears on the last row only`, r.rows.filter(l => l.includes('available')).length === 1)
    check(`${cols}x${rows}: the card is intact — one caret on New Session, no refusal words`, r.rows.filter(l => l.includes('❯')).length === 1 && r.rows.some(l => l.includes('❯') && l.includes('New Session')) && !REFUSAL.test(joined(r.rows)))
    check(`${cols}x${rows}: the cache records the version announced on the face`, readCache(home)?.faceAnnounced === NEWER, JSON.stringify(readCache(home)))
    check(`${cols}x${rows}: the drive stayed on loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
  } finally {
    await endLeg(leg)
  }
}

console.log('\n§2 the second boot on the same home paints no line; a newer release still brings it back')
{
  const [cols, rows] = [80, 21] as const
  const tag = 'face-line-second-80x21'
  const home = join(scratch, `home-${tag}`)
  seedFirstRun(home, [tree, fixtureCwd])
  seedCache(home, NEWER, { faceAnnounced: NEWER })
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const r = await capture(tag, home, cols, rows, {}, leg)
    check(`second boot: the face painted and settled (${r.endReason})`, r.status === 0 && joined(r.rows).includes(FACE_READY) && r.endReason !== 'budget', r.stderr.slice(-400))
    check('second boot: the last row is the plain key-map hint again and no line says available', r.rows[rows - 1] === plainCompactRow(cols) && !joined(r.rows).includes('available'), JSON.stringify(r.rows[rows - 1]))
    check('second boot: the cache still names the version announced', readCache(home)?.faceAnnounced === NEWER)
  } finally {
    await endLeg(leg)
  }
  const tag3 = 'face-line-newer-80x21'
  seedCache(home, NEWER_STILL, { faceAnnounced: NEWER })
  const leg3 = await startLeg(tag3, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const r = await capture(tag3, home, cols, rows, {}, leg3)
    check(`a newer release: the face painted and settled (${r.endReason})`, r.status === 0 && joined(r.rows).includes(FACE_READY) && r.endReason !== 'budget', r.stderr.slice(-400))
    check('a newer release: the line is back with the new version', r.rows[rows - 1] === compactRow(cols, noticeOf(NEWER_STILL)), JSON.stringify(r.rows[rows - 1]))
    check('a newer release: the cache moves to it', readCache(home)?.faceAnnounced === NEWER_STILL)
  } finally {
    await endLeg(leg3)
  }
}

console.log('\n§3 MERCURY_UPDATE_NOTICE=0: no line, nothing recorded; the full-size face keeps its key-map row at the left')
{
  const [cols, rows] = [80, 14] as const
  const tag = 'face-line-off-80x14'
  const home = join(scratch, `home-${tag}`)
  seedFirstRun(home, [tree, fixtureCwd])
  seedCache(home, NEWER)
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const r = await capture(tag, home, cols, rows, { MERCURY_UPDATE_NOTICE: '0' }, leg)
    check(`flag off: the face painted and settled (${r.endReason})`, r.status === 0 && joined(r.rows).includes(FACE_READY) && r.endReason !== 'budget', r.stderr.slice(-400))
    check('flag off: no line, the plain key-map row', r.rows[rows - 1] === plainCompactRow(cols) && !joined(r.rows).includes('available'), JSON.stringify(r.rows[rows - 1]))
    check('flag off: the cache records no announcement', readCache(home)?.faceAnnounced === undefined)
  } finally {
    await endLeg(leg)
  }
  const [wcols, wrows] = [120, 40] as const
  const wtag = 'face-line-second-120x40'
  const whome = join(scratch, `home-${wtag}`)
  seedFirstRun(whome, [tree, fixtureCwd])
  seedCache(whome, NEWER, { faceAnnounced: NEWER })
  const wleg = await startLeg(wtag, [{ kind: 'text', text: 'Finished.' }], null)
  try {
    const r = await capture(wtag, whome, wcols, wrows, {}, wleg)
    check(`full size, second boot: the face painted and settled (${r.endReason})`, r.status === 0 && joined(r.rows).includes(FACE_READY) && r.endReason !== 'budget', r.stderr.slice(-400))
    check('full size, second boot: the key-map row stands alone at the left as before', r.rows[wrows - 1] === plainFullRow && !joined(r.rows).includes('available'), JSON.stringify(r.rows[wrows - 1]))
  } finally {
    await endLeg(wleg)
  }
}

finish('face-update-line')
