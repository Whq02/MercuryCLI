import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import sharp from 'sharp'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { readTeeAsAppleTerminal } from './appleTerminalReading.ts'
import { gridToPng } from './gridToPng.ts'
import { fixture, option, ROOT } from './viewportFixture.ts'

const at = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i < 0 ? undefined : process.argv[i + 1]
}

if (process.argv.includes('--beside')) {
  const i = process.argv.indexOf('--beside')
  const [left, right, out] = process.argv.slice(i + 1, i + 4)
  if (!left || !right || !out) throw new Error('usage: --beside <left.png> <right.png> <out.png>')
  const a = await sharp(left).metadata()
  const b = await sharp(right).metadata()
  const gap = 24
  const width = (a.width ?? 0) + gap + (b.width ?? 0)
  const height = Math.max(a.height ?? 0, b.height ?? 0)
  await sharp({ create: { width, height, channels: 4, background: { r: 60, g: 60, b: 60, alpha: 1 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: (a.width ?? 0) + gap, top: 0 }])
    .png()
    .toFile(out)
  console.log(`wrote ${out} (${width}x${height}; left ${left}, right ${right})`)
  process.exit(0)
}

const dist = option('--dist')
if (!isAbsolute(dist)) throw new Error('The bundle path must be absolute')
const out = resolve(option('--out'))
const label = option('--label')
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Use a plain file label')
const scratch = at('--scratch') ?? join(out, 'scratch')
mkdirSync(scratch, { recursive: true })
mkdirSync(out, { recursive: true })
const node = Bun.which('node')
if (!node) throw new Error('node is required')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`a POSIX pty capture driver is required (${driver.kind})`)
const sizes = process.argv.includes('--size') ? [option('--size')] : ['120x40', '80x24']
const extra: Record<string, string> = {}
if (at('--colorterm')) extra.COLORTERM = at('--colorterm')!
if (at('--truecolor-flag')) extra.MERCURY_TRUECOLOR = at('--truecolor-flag')!
const scene = at('--scene') ?? 'theme'

function replay(tee: string, cols: number, rows: number, gridOut: string): void {
  const run = spawnSync(driver.kind === 'posix-pty' ? driver.python : 'python3', [join(ROOT, 'scripts', 'ui', 'replay-tee-grid.py'), tee, String(cols), String(rows), gridOut], { encoding: 'utf8', env: { ...process.env, HOME: process.env.HOME } })
  if (run.status !== 0) throw new Error(`replay failed: ${run.stderr}`)
  writeFileSync(gridOut.replace(/\.json$/, '.txt'), run.stdout)
}

for (const size of sizes) {
  const [cols, rows] = size.split('x').map(Number) as [number, number]
  const world = fixture(scratch)
  const cfgPath = join(world.config, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  if (scene === 'theme') cfg.hasCompletedOnboarding = false
  cfg.optionAsMetaKeyInstalled = true
  writeFileSync(cfgPath, JSON.stringify(cfg))
  writeFileSync(join(world.config, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }))
  const env: NodeJS.ProcessEnv = { ...world.env, TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455', ...extra }
  if (!extra.COLORTERM) delete env.COLORTERM
  delete env.FORCE_COLOR
  const tag = `${label}-${scene}-${size}`
  const tee = join(out, `${tag}.tee.bin`)
  if (existsSync(tee)) throw new Error(`Refusing to overwrite ${tee}`)
  env.VSHOT_TEE = tee
  const gridPath = join(out, `${tag}.capture.json`)
  const gate = { requireAwait: true, minTick: 3, awaitSettleTicks: 6 }
  const ready = scene === 'theme' ? '↑↓ preview' : scene === 'boot' ? '↑↓ choose' : 'Type a prompt'
  const sends = scene === 'session'
    ? [{ ...gate, awaitText: '↑↓ choose', data: '\r' }, { ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 8, data: '', mark: scene }]
    : [{ ...gate, awaitText: ready, data: '', mark: scene }]
  const cfgFile = join(scratch, `${tag}.capture-cfg.json`)
  writeFileSync(cfgFile, JSON.stringify({ argv: [node, dist], cwd: world.cwd, cols, rows, total: 400, sends, readyText: ready, readySettleTicks: 4, out: gridPath }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgFile], { cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += String(bytes) })
  child.stderr.on('data', bytes => { log += String(bytes) })
  const status = await new Promise<number | null>(resolveStatus => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(150_000))
    child.once('close', code => { clearTimeout(wall); resolveStatus(code) })
  })
  writeFileSync(join(out, `${tag}.log`), log)
  if (status !== 0 || !existsSync(tee)) throw new Error(`capture ${tag} failed (${status}): ${log.slice(-800)}`)
  const appleTee = join(out, `${tag}.apple-read.tee.bin`)
  writeFileSync(appleTee, readTeeAsAppleTerminal(readFileSync(tee)))
  const standardGrid = join(out, `${tag}.standard.json`)
  const appleGrid = join(out, `${tag}.apple.json`)
  replay(tee, cols, rows, standardGrid)
  replay(appleTee, cols, rows, appleGrid)
  await gridToPng(standardGrid, standardGrid.replace(/\.json$/, '.png'))
  await gridToPng(appleGrid, appleGrid.replace(/\.json$/, '.png'))
  world.dispose()
  console.log(`${tag}: standard ${standardGrid.replace(/\.json$/, '.png')} · as Apple Terminal 455 reads it ${appleGrid.replace(/\.json$/, '.png')}`)
}
