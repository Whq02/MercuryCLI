#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

{
  const gs = readFileSync(join(ROOT, 'src/utils/gracefulShutdown.ts'), 'utf8')
  t('§1 the bounded road exists (crashShutdown export)', /export async function crashShutdown\(/.test(gs))
  t('§1 …with the ruled budget beside it', /CRASH_SHUTDOWN_BUDGET_MS = 1500/.test(gs))
  t('§1 …and session-end hooks never run on it', !/executeSessionEndHooks/.test(gs.slice(gs.indexOf('export async function crashShutdown'), gs.indexOf('export async function crashShutdown') + 2200)))
  const failLoudBody = gs.slice(gs.indexOf('export function failLoud'), gs.indexOf('const BREAKER_WINDOW_MS'))
  t('§1 failLoud leaves through the bounded road, never a bare exit', /void crashShutdown\(1\)/.test(failLoudBody) && !/forceExit\(1\)/.test(failLoudBody))
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  const catchAt = main.indexOf('Mercury exited on an error')
  const catchRegion = main.slice(catchAt, catchAt + 900)
  t('§1 the render-crash catch takes the bounded road before its exit', /await crashShutdown\(1\)/.test(catchRegion))
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'crash-shutdown-'))
const bunExe = process.execPath

function runChild(body: string, timeoutMs: number): { status: number | null; ms: number; err: string } {
  const script = join(SCRATCH, `child-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(script, body)
  const started = Date.now()
  const r = spawnSync(bunExe, ['run', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, MERCURY_CONFIG_DIR: join(SCRATCH, 'home'), NODE_ENV: 'production' },
    cwd: ROOT,
  })
  return { status: r.status, ms: Date.now() - started, err: (r.stderr ?? '').slice(0, 400) }
}

{
  const out = join(SCRATCH, 'cleaned.txt')
  const child = `
    import { registerCleanup } from '${ROOT}/src/utils/cleanupRegistry.ts'
    import { crashShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
    import { writeFileSync } from 'node:fs'
    registerCleanup(async () => { writeFileSync('${out}', 'cleaned') })
    await crashShutdown(7)
  `
  const r = runChild(child, 10_000)
  t('§2 the child exits with the honest code', r.status === 7, `status=${r.status} ${r.err}`)
  t('§2 the cleanup registry ran before the exit', existsSync(out) && readFileSync(out, 'utf8') === 'cleaned')
  t('§2 …promptly (well under the cap + drains)', r.ms < 6_000, `${r.ms}ms`)
}

{
  const out2 = join(SCRATCH, 'cleaned2.txt')
  const child = `
    import { registerCleanup } from '${ROOT}/src/utils/cleanupRegistry.ts'
    import { crashShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
    import { writeFileSync } from 'node:fs'
    registerCleanup(async () => { writeFileSync('${out2}', 'cleaned') })
    registerCleanup(() => new Promise(() => {}))
    await crashShutdown(7)
  `
  const r = runChild(child, 12_000)
  t('§3 a wedged cleanup still exits with the honest code', r.status === 7, `status=${r.status} ${r.err}`)
  t('§3 …at the cap, never a hang', r.ms >= 900 && r.ms < 8_000, `${r.ms}ms`)
}

{
  const home = join(SCRATCH, 'uncaught-home')
  const child = `
    import { setupGracefulShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
    setupGracefulShutdown()
    process.nextTick(() => { throw new Error('boom-forensics') })
    setTimeout(() => process.exit(0), 400)
  `
  const script = join(SCRATCH, 'child-uncaught.ts')
  writeFileSync(script, child)
  spawnSync(bunExe, ['run', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'production' },
    cwd: ROOT,
  })
  const { readdirSync } = await import('node:fs')
  let reports: string[] = []
  try {
    reports = readdirSync(join(home, 'crashes')).filter(f => f.includes('uncaught-exception'))
  } catch {
  }
  t('§4 the first ordinary uncaught persists an archive report (session survives)', reports.length === 1, `${reports.length} report(s)`)
  if (reports[0] !== undefined) {
    const body = readFileSync(join(home, 'crashes', reports[0]), 'utf8')
    t('§4 …carrying the real error', body.includes('boom-forensics'))
  }
}

{
  const daemonMain = readFileSync(join(ROOT, 'src/daemon/main.ts'), 'utf8')
  const at = daemonMain.indexOf('const crashShutdown')
  const body = daemonMain.slice(at, at + 1200)
  t('§5 the daemon crashShutdown persists to the unified archive', body.includes('persistCrashReport'))
}

{
  const cardChild = `
    import { failLoud } from '${ROOT}/src/utils/gracefulShutdown.ts'
    failLoud(new Error('EPERM: operation not permitted, open .mercury.json'), 'boot')
    setTimeout(() => process.exit(9), 8000)
  `
  const drive = (home: string): { status: number | null; stderr: string } => {
    const script = join(SCRATCH, `child-card-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(script, cardChild)
    const r = spawnSync(bunExe, ['run', script], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'production' },
      cwd: ROOT,
    })
    return { status: r.status, stderr: r.stderr ?? '' }
  }
  const blocker = join(SCRATCH, 'blocker')
  writeFileSync(blocker, 'a file where a directory was expected')
  const refusing = drive(join(blocker, 'home'))
  t('§6 the refusing home still paints the card and exits 1', refusing.status === 1 && refusing.stderr.includes('MERCURY COULD NOT START'), `status=${refusing.status} ${refusing.stderr.slice(0, 300)}`)
  t('§6 …with no report: line (nothing landed)', !/^report:/m.test(refusing.stderr), refusing.stderr.slice(0, 600))
  t('§6 …and a next: line that never promises the report below', !refusing.stderr.includes('the report below carries it'), refusing.stderr.slice(0, 600))
  t('§6 …but says the report could not be written and points at the console trace', /no crash report could be written/.test(refusing.stderr) && refusing.stderr.includes('--debug-to-stderr'), refusing.stderr.slice(0, 600))
  const landed = drive(join(SCRATCH, 'card-home'))
  t('§6 control: a writable home prints the report: line', /^report:\s+\S*crash-\d+-boot\.json/m.test(landed.stderr), landed.stderr.slice(0, 600))
  t('§6 control: …and the next: line keeps its promise', landed.stderr.includes('the report below carries it'), landed.stderr.slice(0, 600))
}

{
  const gs = readFileSync(join(ROOT, 'src/utils/gracefulShutdown.ts'), 'utf8')
  const armAt = gs.indexOf('if (tripped) {')
  const armEnd = gs.indexOf("process.on('unhandledRejection'", armAt)
  const arm = armAt >= 0 && armEnd > armAt ? gs.slice(armAt, armEnd) : ''
  t('§7 the tripped arm takes the bounded road (structural)', /void crashShutdown\(1\)/.test(arm), arm.slice(-300))
  t('§7 …and a bare forceExit remains only for a shutdown already in progress', /isShuttingDown\(\)\) forceExit\(1\)/.test(arm) && (arm.match(/forceExit\(1\)/g) ?? []).length === 1)

  const out = join(SCRATCH, 'breaker-cleaned.txt')
  const child = `
    import { registerCleanup } from '${ROOT}/src/utils/cleanupRegistry.ts'
    import { setupGracefulShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
    import { writeFileSync } from 'node:fs'
    setupGracefulShutdown()
    registerCleanup(async () => { writeFileSync('${out}', 'cleaned') })
    // The repeating fault the breaker exists to stop: a throw from a timer
    // on every tick, well inside the sliding window.
    for (let i = 0; i < 14; i++) setTimeout(() => { throw new Error('loop-' + i) }, 5 + i * 5)
    setTimeout(() => process.exit(9), 8000)
  `
  const r = runChild(child, 15_000)
  t('§7 the breaker trips and the child exits 1', r.status === 1 && /Crash loop detected/.test(r.err), `status=${r.status} ${r.err.slice(0, 200)}`)
  t('§7 the cleanup registry ran before the exit (the in-flight drains land)', existsSync(out) && readFileSync(out, 'utf8') === 'cleaned')
  t('§7 …under the cap, never a lingering loop', r.ms < 8_000, `${r.ms}ms`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'CRASH SHUTDOWN: ALL PASS' : 'CRASH SHUTDOWN: RED')
process.exit(failures)
