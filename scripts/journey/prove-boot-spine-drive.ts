#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { vshotBudgetMs, resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { untilAsync } = await import('../lib/untilAsync.ts')
const { BOOT_FACE_READY, paintsBootFaceReady } = await import('../lib/bootFace.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-boot-spine-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` | what to change: ${hint}` : ''}`)
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')

async function capture(cfg: Record<string, unknown>, env: Record<string, string>, budgetMs: number): Promise<{ text: string; endReason: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'boot-spine-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(driver.python, [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(budgetMs))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 600)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; endReason?: string }
  rmSync(dir, { recursive: true, force: true })
  return { text: gridText(payload.grid), endReason: payload.endReason ?? '', stderr: stderr.join('') }
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'boot-spine-home-')))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'boot-spine-cwd-')))
writeFileSync(join(cwd, 'README.md'), '# fixture\n')
seedFirstRun(home, [cwd])
const env: Record<string, string> = {
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  OPENAI_API_KEY: '',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_OPERATOR: 'sam',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
}

type Row = { pid: number; milestone: string; atMs: number; boot?: string }
const STORE = join(home, 'launch-milestones.json')
const readRows = (): Row[] => {
  if (!existsSync(STORE)) return []
  const store = JSON.parse(readFileSync(STORE, 'utf8')) as { rows?: Row[] }
  return Array.isArray(store.rows) ? store.rows : []
}
const lastSpine = (): Row[] => {
  const rows = readRows()
  const pid = rows[rows.length - 1]?.pid
  return pid === undefined ? [] : rows.filter(r => r.pid === pid)
}
const lastInteractiveSpine = (): Row[] => {
  const rows = readRows()
  const headless = new Set(rows.filter(r => r.boot === 'headless').map(r => r.pid))
  for (let i = rows.length - 1; i >= 0; i--) {
    const pid = rows[i]!.pid
    if (!headless.has(pid)) return rows.filter(r => r.pid === pid)
  }
  return []
}
const ORDER = ['runtime-entry', 'route-ready', 'first-frame', 'input-live']
const inOrder = (spine: Row[]): boolean => {
  const rungs = spine.filter(r => ORDER.includes(r.milestone))
  if (rungs.map(r => r.milestone).join('→') !== ORDER.join('→')) return false
  for (let i = 1; i < rungs.length; i++) if (rungs[i]!.atMs < rungs[i - 1]!.atMs) return false
  return true
}
const spineWords = (spine: Row[]): string => spine.map(r => `${r.milestone}@${r.atMs}${r.boot ? `(${r.boot})` : ''}`).join(' → ')

console.log('============================================================')
console.log(' the launch spine on every boot road — real bundle, PTY')
console.log('============================================================')

{
  let ok = false
  try {
    const cap = await capture({ argv: ['node', BIN], cwd, cols: 120, rows: 40, sends: [{ data: '', awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, minTick: 10, awaitSettleTicks: 6 }], readyText: ['↑↓'], total: 300 }, env, 90_000)
    ok = paintsBootFaceReady(cap.text)
    check('B1 the Boot face painted', ok, cap.text.split('\n').filter(r => r.trim()).slice(0, 6).join(' | '), 'the interactive boot must paint the Boot face (the arrows line matched by BOOT_FACE_READY in scripts/lib/bootFace.ts); read the frame above, or rebuild dist with bun run build.ts')
  } catch (error) {
    check('B1 the face capture ran', false, String(error).slice(0, 300))
  }
  const spine = lastInteractiveSpine()
  check('B1 the face boot stamped the four rungs in order, first-frame before input-live', inOrder(spine), spineWords(spine), 'a boot must stamp runtime-entry, route-ready, first-frame, input-live in that order through recordLaunchMilestone (src/platform/substrate/launchMilestones.ts); the rung missing or out of order is the call site to fix')
  check('B1 the face boot is stamped interactive on its entry rung', spine[0]?.boot === 'interactive', spineWords(spine), 'the entry rung of an interactive boot must be recorded with boot interactive in recordLaunchMilestone (src/platform/substrate/launchMilestones.ts)')
  await untilAsync(() => lastSpine()[0]?.pid !== spine[0]?.pid, vshotBudgetMs(10_000), 100)
  const runners = lastSpine()
  check('B1 the boot\'s own headless children (the daemon, the runner) stamp headless, so they are never the judged spine', runners[0]?.pid === spine[0]?.pid || runners[0]?.boot === 'headless', spineWords(runners), 'headless children of a boot (the daemon, the runner) must stamp their entry rung with boot headless via recordLaunchMilestone (src/platform/substrate/launchMilestones.ts)')
}

{
  const before = readRows().length
  try {
    const cap = await capture(
      { argv: ['node', BIN, '--chat'], cwd, cols: 120, rows: 40, sends: [{ data: '\r', awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, minTick: 10, awaitSettleTicks: 6 }, { data: '', awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 4 }, { data: '/exit\r', afterPrevTicks: 2 }], total: 300 },
      env,
      120_000,
    )
    check('B2 the --chat road reached the chat', cap.text.includes('ype a prompt') || cap.endReason === 'eof', `end: ${cap.endReason}`, 'node dist/mercury.mjs --chat must reach the chat prompt (Type a prompt) after the Boot face; read how the --chat road boots in the built bundle and rebuild with bun run build.ts')
  } catch (error) {
    check('B2 the --chat capture ran', false, String(error).slice(0, 300))
  }
  const spine = lastInteractiveSpine()
  const appended = readRows().length > before
  check('B2 the --chat boot appended a new spine', appended, appended ? '' : 'no row was added to launch-milestones.json in the config home', 'the --chat boot must call recordLaunchMilestone (src/platform/substrate/launchMilestones.ts)')
  check('B2 the --chat boot stamped the four rungs in order', inOrder(spine), spineWords(spine), 'the --chat boot must stamp runtime-entry, route-ready, first-frame, input-live in order through recordLaunchMilestone (src/platform/substrate/launchMilestones.ts)')
}

{
  const interactive = lastInteractiveSpine()
  const run = spawn('node', [BIN, 'run', 'spine: hello'], { cwd, env: { ...process.env, ...env }, stdio: 'ignore' })
  const left = (): boolean => run.exitCode !== null || run.signalCode !== null
  const rungs = (): number => readRows().filter(r => r.pid === run.pid).length
  await untilAsync(() => left() || rungs() >= 1, vshotBudgetMs(60_000), 100)
  await untilAsync(() => left() || rungs() > 1, vshotBudgetMs(5000), 100)
  const status = run.exitCode
  run.kill('SIGTERM')
  if (!(await untilAsync(left, 5000, 100))) run.kill('SIGKILL')
  const spine = lastSpine()
  check('B3 the headless run stamped its entry rung as headless and no interactive rung', spine.length === 1 && spine[0]!.milestone === 'runtime-entry' && spine[0]!.boot === 'headless', `${spineWords(spine)} (exit ${status})`, 'node dist/mercury.mjs run must stamp only runtime-entry with boot headless, never route-ready, first-frame or input-live (recordLaunchMilestone in src/platform/substrate/launchMilestones.ts)')
  const ownPid = spine[0]?.pid !== interactive[0]?.pid
  check('B3 the headless run is a new pid after the interactive spine', ownPid, ownPid ? '' : 'the last spine in launch-milestones.json is still the interactive boot', 'a headless run must stamp its own rows (recordLaunchMilestone in src/platform/substrate/launchMilestones.ts)')
  const d = spawnSync('node', [BIN, 'health', '--json'], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 })
  let row: { status?: string; evidence?: string } | undefined
  try {
    const report = JSON.parse(d.stdout) as { sections?: Array<{ checks?: Array<{ id?: string; status?: string; evidence?: string }> }> }
    row = report.sections?.flatMap(s => s.checks ?? []).find(c => c.id === 'launch-spine')
  } catch {
    row = undefined
  }
  check('B3 /health judges the last INTERACTIVE boot ok — never the headless run as a truncated boot', row?.status === 'ok' && (row.evidence ?? '').includes('runtime-entry → route-ready → first-frame → input-live'), `${row?.status}: ${row?.evidence ?? d.stderr.slice(0, 200)}`, 'the launch-spine health check (src/platform/health/sections/crew/boot.ts) must judge the last interactive boot via lastInteractiveBootSpine (src/platform/substrate/launchMilestones.ts), not the headless run')
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spine-drive: all green' : `\nprove-boot-spine-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
