#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-headless-activity-deferred.ts — a headless boot's
//  activity note is a deferred config merge, published once at exit.
//
//  THE DEFECT: runHeadless stamps the activity ledger at entry (print/sdk)
//  and every verb's preAction stamps its verb — and the ledger published
//  through the synchronous saver: a locked, backed-up, fsync'd rewrite of
//  the global config file in front of every headless boot's first turn.
//  Every concourse worker is a `-p` boot, so a batch of worker boots had N
//  processes contending for one config lock (a blocking backoff ladder)
//  before any of them worked. The ledger's own header claimed the deferred road; the code
//  took the synchronous one.
//
//  THE LAW: the note merges into the config CACHE now (readers see it at
//  once) and reaches the disk through the deferred road — folded into the
//  next save of any kind, or at process exit through the deferred writer's
//  own exit flush (the one seam every headless road crosses: forceExit, a
//  verb's process.exit and a drained loop all raise 'exit').
//
//   §1 the module drive on a scratch config home: the note performs ZERO
//      durable writes (the defect pin — the old shape wrote here), the
//      cache carries it, the flush publishes it once, and a foreign save in
//      between folds it (one write, both facts on disk);
//   §2 the exit seam: the first deferral arms exactly one 'exit' listener,
//      a later deferral arms no second, and driving that listener publishes
//      the pending note;
//   §3 the built artifact against the fixture API: a `-p` run's note is on
//      disk after the process exits; a second run counts two;
//   §4 source pins: the ledger takes the deferred road and never the
//      synchronous saver; the deferred writer arms the exit flush; the
//      headless entry still stamps at entry.
//
//  Run: ~/.bun/bin/bun run scripts/headless/prove-headless-activity-deferred.ts
//  (§3 drives dist/mercury.mjs — the headless suite prebuilds it)
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
// The scratch home BEFORE the module chain loads — the config path memoizes.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'activity-deferred-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

type Activity = { print?: number; sdk?: number; verbs?: Record<string, number>; lastKind?: string }

const config = await import('../../src/utils/config/globalConfig.ts')
const { getGlobalMercuryFile } = await import('../../src/utils/env.ts')
const ledger = await import('../../src/utils/activityLedger.ts')
config.enableConfigs()
const FILE = getGlobalMercuryFile()
const onDisk = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
const activityOnDisk = (): Activity | undefined => onDisk().headlessActivity as Activity | undefined
// The 'exit' listeners standing before any deferral — the arm is the delta.
const exitListenersAtBoot = process.listeners('exit')

section('§1 the note is a deferred merge: zero durable writes, the cache now, one publish')
{
  const writes0 = config.getGlobalConfigWriteCount()
  ledger.noteHeadlessActivity('print')
  check('THE DEFECT PIN: the note performed no durable write', config.getGlobalConfigWriteCount() === writes0, `writes=${config.getGlobalConfigWriteCount() - writes0}`)
  check('the note is pending on the deferred road', config.hasPendingDeferredGlobalConfigSaves())
  const cached = ledger.getHeadlessActivity()
  check('the cache carries it at once (print = 1, last kind print)', cached.print === 1 && cached.lastKind === 'print', j(cached))
  check('the disk does not yet', activityOnDisk() === undefined, j(activityOnDisk()))
  config.flushDeferredGlobalConfigSaves()
  check('the flush publishes it in ONE write', config.getGlobalConfigWriteCount() === writes0 + 1, `writes=${config.getGlobalConfigWriteCount() - writes0}`)
  check('…and the disk carries it', activityOnDisk()?.print === 1, j(activityOnDisk()))
  check('nothing stays pending after the flush', !config.hasPendingDeferredGlobalConfigSaves())
  const writes1 = config.getGlobalConfigWriteCount()
  ledger.noteHeadlessActivity('sdk')
  ledger.noteHeadlessActivity('verb:doctor')
  check('two more notes: still no durable write', config.getGlobalConfigWriteCount() === writes1, `writes=${config.getGlobalConfigWriteCount() - writes1}`)
  config.saveGlobalConfig(current => ({ ...current, theme: 'light' }))
  check('a foreign save folds the pending notes into its own ONE write', config.getGlobalConfigWriteCount() === writes1 + 1, `writes=${config.getGlobalConfigWriteCount() - writes1}`)
  const disk = activityOnDisk()
  check(
    '…both facts on disk: the notes and the foreign field',
    disk?.print === 1 && disk?.sdk === 1 && disk?.verbs?.['doctor'] === 1 && disk?.lastKind === 'verb:doctor' && onDisk().theme === 'light',
    j({ disk, theme: onDisk().theme }),
  )
  check('nothing pending after the fold', !config.hasPendingDeferredGlobalConfigSaves())
}

section("§2 the exit seam: the first deferral armed ONE 'exit' listener that publishes")
{
  const armed = process.listeners('exit').filter(l => !exitListenersAtBoot.includes(l))
  check("exactly one 'exit' listener was armed by the deferrals above", armed.length === 1, `armed=${armed.length}`)
  const writes0 = config.getGlobalConfigWriteCount()
  ledger.noteHeadlessActivity('print')
  check('a later deferral arms no second listener', process.listeners('exit').filter(l => !exitListenersAtBoot.includes(l)).length === 1)
  check('the note is pending', config.hasPendingDeferredGlobalConfigSaves())
  // Drive the armed listener in place — what process.exit would do — without
  // leaving the process (and without running any other module's listener).
  const flushAtExit = armed[0] as ((code: number) => void) | undefined
  flushAtExit?.call(process, 0)
  check('the exit seam published the pending note in ONE write', config.getGlobalConfigWriteCount() === writes0 + 1, `writes=${config.getGlobalConfigWriteCount() - writes0}`)
  check('…and the disk carries it (print = 2)', activityOnDisk()?.print === 2, j(activityOnDisk()))
  check('nothing pending after the exit flush', !config.hasPendingDeferredGlobalConfigSaves())
  // A no-op when nothing is pending: the interactive quit after the
  // launch-graph node already published.
  const writes1 = config.getGlobalConfigWriteCount()
  flushAtExit?.call(process, 0)
  check('the exit flush with nothing pending writes nothing', config.getGlobalConfigWriteCount() === writes1)
}

section("§3 the built artifact: a -p run's note is on disk after the process exits")
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  const nodeBin = Bun.which('node')
  if (!existsSync(DIST) || !nodeBin) {
    check('dist/mercury.mjs and a node binary exist (build first — this leg drives the artifact)', false, `dist=${existsSync(DIST)} node=${String(nodeBin)}`)
  } else {
    const { startFixtureApi } = await import('../lib/fixtureApi.ts')
    const api = await startFixtureApi([
      { kind: 'text', text: 'First answered.' },
      { kind: 'text', text: 'Second answered.' },
    ])
    const API_KEY = 'fixture-key-000'
    const home = mkdtempSync(join(tmpdir(), 'activity-run-home-'))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'activity-run-cwd-')))
    const configDir = join(home, '.mercury')
    mkdirSync(configDir, { recursive: true })
    const file = join(configDir, '.config.json')
    // The first-boot stamps are seeded so the run's only config write is
    // the note's own publish — at exit, or folded into nothing else.
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        hasCompletedOnboarding: true,
        userID: 'a'.repeat(64),
        firstStartTime: new Date().toISOString(),
        customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
        projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      }),
    )
    const env = {
      HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: API_KEY,
    }
    const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
      new Promise(resolveRun => {
        const child = spawn(nodeBin, [DIST, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', d => (out += String(d)))
        child.stderr.on('data', d => (out += String(d)))
        child.stdin.end()
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('exit', code => {
          clearTimeout(killer)
          resolveRun({ code, out })
        })
      })
    const activity = (): Activity | undefined => {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { headlessActivity?: Activity }).headlessActivity
      } catch {
        return undefined
      }
    }
    const first = await run(['-p', 'hello'])
    check('the -p run completed (exit 0, the scripted text)', first.code === 0 && /First answered\./.test(first.out), `${first.code} · ${first.out.trim().slice(0, 160)}`)
    check('after the exit the note is on disk: print = 1, last kind print', activity()?.print === 1 && activity()?.lastKind === 'print', j(activity()))
    const second = await run(['-p', 'again'])
    check('a second run completed', second.code === 0 && /Second answered\./.test(second.out), `${second.code} · ${second.out.trim().slice(0, 160)}`)
    check('…and the ledger counts two', activity()?.print === 2, j(activity()))
    await api.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

section('§4 source pins')
{
  const ledgerSrc = readFileSync(join(ROOT, 'src/utils/activityLedger.ts'), 'utf8')
  check('the ledger merges through the deferred road', /saveGlobalConfigDeferred\(current => \{/.test(ledgerSrc))
  check('…and never the synchronous saver', !/\bsaveGlobalConfig\(/.test(ledgerSrc) && !/import \{[^}]*\bsaveGlobalConfig\b[^}]*\}/.test(ledgerSrc))
  const cfgSrc = readFileSync(join(ROOT, 'src/utils/config/globalConfig.ts'), 'utf8')
  check('the deferred writer arms the exit flush at the deferral', /pendingDeferredUpdaters\.push\(updater\)\s*\n\s*armDeferredExitFlush\(\)/.test(cfgSrc))
  check("…as a once-listener on the process 'exit' event that flushes", /process\.once\('exit', \(\) => \{\s*\n\s*try \{\s*\n\s*flushDeferredGlobalConfigSaves\(\)/.test(cfgSrc))
  check('…armed exactly once per process', /if \(deferredExitFlushArmed\) return\s*\n\s*deferredExitFlushArmed = true/.test(cfgSrc))
  const printSrc = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  check('the headless entry still stamps its activity at entry', /noteHeadlessActivity\(\s*\n?\s*options\.outputFormat === 'stream-json' && streamingInput \? 'sdk' : 'print',?\s*\n?\s*\)/.test(printSrc))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-headless-activity-deferred: ALL LAWS HOLD' : `\nprove-headless-activity-deferred: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
