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
    import { registerCleanup } from '${ROOT}/src/platform/processes/cleanupRegistry.ts'
    import { crashShutdown } from '${ROOT}/src/platform/processes/gracefulShutdown.ts'
    import { writeFileSync } from 'node:fs'
    registerCleanup(async () => { writeFileSync('${out}', 'cleaned') })
    await crashShutdown(7)
  `
  const r = runChild(child, 10_000)
  t('§2 the child exits with the honest code', r.status === 7, `status=${r.status} ${r.err} — crashShutdown in src/platform/processes/gracefulShutdown.ts must exit with the code it is given`)
  t('§2 the cleanup registry ran before the exit', existsSync(out) && readFileSync(out, 'utf8') === 'cleaned', 'crashShutdown in src/platform/processes/gracefulShutdown.ts must run the cleanups registered through registerCleanup (src/platform/processes/cleanupRegistry.ts) before it exits')
  t('§2 …promptly (well under the cap + drains)', r.ms < 6_000, `${r.ms}ms — crashShutdown in src/platform/processes/gracefulShutdown.ts must finish its cleanup and drains well inside the cap`)
}

{
  const out2 = join(SCRATCH, 'cleaned2.txt')
  const child = `
    import { registerCleanup } from '${ROOT}/src/platform/processes/cleanupRegistry.ts'
    import { crashShutdown } from '${ROOT}/src/platform/processes/gracefulShutdown.ts'
    import { writeFileSync } from 'node:fs'
    registerCleanup(async () => { writeFileSync('${out2}', 'cleaned') })
    registerCleanup(() => new Promise(() => {}))
    await crashShutdown(7)
  `
  const r = runChild(child, 12_000)
  t('§3 a wedged cleanup still exits with the honest code', r.status === 7, `status=${r.status} ${r.err} — crashShutdown in src/platform/processes/gracefulShutdown.ts must stop waiting on a cleanup that never settles and exit with its code`)
  t('§3 …at the cap, never a hang', r.ms >= 900 && r.ms < 8_000, `${r.ms}ms — crashShutdown in src/platform/processes/gracefulShutdown.ts must give up on a wedged cleanup at its cap, neither at once nor never`)
}

{
  const home = join(SCRATCH, 'uncaught-home')
  const child = `
    import { setupGracefulShutdown } from '${ROOT}/src/platform/processes/gracefulShutdown.ts'
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
  t('§4 the first ordinary uncaught persists an archive report (session survives)', reports.length === 1, `${reports.length} report(s) — the uncaught-exception handler installed by setupGracefulShutdown in src/platform/processes/gracefulShutdown.ts must persist one report under the config home crashes folder for the first ordinary uncaught error`)
  if (reports[0] !== undefined) {
    const body = readFileSync(join(home, 'crashes', reports[0]), 'utf8')
    t('§4 …carrying the real error', body.includes('boom-forensics'), 'the crash report written by the uncaught-exception handler in src/platform/processes/gracefulShutdown.ts must carry the thrown error text')
  }
}

{
  const cardChild = `
    import { failLoud } from '${ROOT}/src/platform/processes/gracefulShutdown.ts'
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
  t('§6 the refusing home still paints the card and exits 1', refusing.status === 1 && refusing.stderr.includes('MERCURY COULD NOT START'), `status=${refusing.status} ${refusing.stderr.slice(0, 300)} — failLoud in src/platform/processes/gracefulShutdown.ts must still print the card and exit 1 when the config home cannot be written`)
  t('§6 …with no report: line (nothing landed)', !/^report:/m.test(refusing.stderr), refusing.stderr.slice(0, 600) + ' — failLoud in src/platform/processes/gracefulShutdown.ts must print a report: line only when the report landed')
  t('§6 …and a next: line that never promises the report below', !refusing.stderr.includes('the report below carries it'), refusing.stderr.slice(0, 600) + ' — failLoud in src/platform/processes/gracefulShutdown.ts must not promise a report below when none was written')
  t('§6 …but says the report could not be written and points at the console trace', /no crash report could be written/.test(refusing.stderr) && refusing.stderr.includes('--debug --log-stderr'), refusing.stderr.slice(0, 600) + ' — failLoud in src/platform/processes/gracefulShutdown.ts must say no crash report could be written and point at --debug --log-stderr')
  const landed = drive(join(SCRATCH, 'card-home'))
  t('§6 control: a writable home prints the report: line', /^report:\s+\S*crash-\d+-boot\.json/m.test(landed.stderr), landed.stderr.slice(0, 600) + ' — failLoud in src/platform/processes/gracefulShutdown.ts must print the report: line with the crash-<n>-boot.json path when the home is writable')
  t('§6 control: …and the next: line keeps its promise', landed.stderr.includes('the report below carries it'), landed.stderr.slice(0, 600) + ' — failLoud in src/platform/processes/gracefulShutdown.ts must keep the next: line that points at the report below when it was written')
}

{

  const out = join(SCRATCH, 'breaker-cleaned.txt')
  const child = `
    import { registerCleanup } from '${ROOT}/src/platform/processes/cleanupRegistry.ts'
    import { setupGracefulShutdown } from '${ROOT}/src/platform/processes/gracefulShutdown.ts'
    import { writeFileSync } from 'node:fs'
    setupGracefulShutdown()
    registerCleanup(async () => { writeFileSync('${out}', 'cleaned') })
    // The repeating fault the breaker exists to stop: a throw from a timer
    // on every tick, well inside the sliding window.
    for (let i = 0; i < 14; i++) setTimeout(() => { throw new Error('loop-' + i) }, 5 + i * 5)
    setTimeout(() => process.exit(9), 8000)
  `
  const r = runChild(child, 15_000)
  t('§7 the breaker trips and the child exits 1', r.status === 1 && /Crash loop detected/.test(r.err), `status=${r.status} ${r.err.slice(0, 200)} — the crash-loop breaker in the uncaught-exception handler of setupGracefulShutdown (src/platform/processes/gracefulShutdown.ts) must trip, print Crash loop detected and exit 1`)
  t('§7 the cleanup registry ran before the exit (the in-flight drains land)', existsSync(out) && readFileSync(out, 'utf8') === 'cleaned', 'the crash-loop breaker path in src/platform/processes/gracefulShutdown.ts must run the registerCleanup cleanups before it exits')
  t('§7 …under the cap, never a lingering loop', r.ms < 8_000, `${r.ms}ms — the crash-loop breaker path in src/platform/processes/gracefulShutdown.ts must exit within the cap`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'CRASH SHUTDOWN: ALL PASS' : 'CRASH SHUTDOWN: RED')
process.exit(failures)
