#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJobControlHost, journeyTail, mark, type HostReport } from './jobcontrolHost.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist')
if (!existsSync(join(DIST, 'mercury.mjs'))) { console.error('FAIL prove-launcher-job-control: dist/mercury.mjs is missing — run bun run build.ts'); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

const { posixLauncher, parseEnginesNode } = await import('../release/launcherTemplates.mjs') as {
  posixLauncher: (p: unknown) => string
  parseEnginesNode: (engines: string) => unknown
}
const policy = parseEnginesNode(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines.node)

const work = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-job-')))
const install = join(work, 'install')
mkdirSync(install, { recursive: true })
cpSync(DIST, install, { recursive: true })
writeFileSync(join(install, 'mercury'), posixLauncher(policy))
chmodSync(join(install, 'mercury'), 0o755)

const home = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-job-home-')))
const cwd = join(home, 'project')
mkdirSync(cwd)
seedFirstRun(home, [cwd])

try {
  const pyteSite = spawnSync('/usr/bin/python3', ['-c', 'import pyte, os; print(os.path.dirname(os.path.dirname(pyte.__file__)))'], { encoding: 'utf8' }).stdout?.trim() ?? ''
  const run = runJobControlHost({
    tag: 'launcher-job-control',
    argv: [join(install, 'mercury')],
    cwd,
    cols: 100,
    rows: 30,
    bundleMarker: 'install/mercury',
    budgetSeconds: 150,
    env: {
      ...process.env,
      HOME: home,
      ...(pyteSite !== '' ? { PYTHONPATH: pyteSite } : {}),
      MERCURY_CONFIG_DIR: home,
      MERCURY_HOME: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_NO_BANNER: '1',
      MERCURY_SPLASH: 'off',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      BROWSER: '/usr/bin/true',
      ANTHROPIC_API_KEY: 'fixture-key-000',
    },
    steps: [
      { wait: 'host$', timeout: 20 },
      { launch: true },
      { wait: ['New Session', 'Session Concourse'], timeout: 60, label: 'home' },
      { observe: 'before-stop' },
      { send: '\x1a', label: 'ctrl-z' },
      { wait: 'host$', timeout: 10, label: 'prompt-back' },
      { mark: 'after-stop' },
      { observe: 'stopped' },
      { typeline: 'fg', label: 'fg' },
      { wait: ['New Session', 'Session Concourse'], timeout: 30, label: 'resumed' },
      { observe: 'resumed' },
      { send: '\x03', label: 'ctrl-c-1' },
      { sleep: 1 },
      { send: '\x03', label: 'ctrl-c-2' },
      { wait: 'host$', timeout: 15, label: 'exited' },
      { typeline: 'exit', label: 'shell-exit' },
      { sleep: 1 },
    ],
  })
  const report: HostReport | null = run.report
  if (report === null) {
    check('the host produced a report', false, journeyTail(run))
  } else {
    const gridAt = (label: string): string => mark(report, label)?.grid ?? ''
    const afterStop = gridAt('after-stop')
    const suspendedSpoken = [...afterStop.split('\n'), ...report.shellLines].some(l => /suspended|Stopped/i.test(l))
    check('the shell reports the suspended job (job control reached it)', suspendedSpoken, `shellLines=${JSON.stringify(report.shellLines)} tail=${journeyTail(run)}`)
    check('the shell prompt returns after ctrl+z (the terminal is the shell\'s again)', afterStop.includes('host$'), JSON.stringify(afterStop.split('\n').filter(r => r.trim() !== '').slice(-3)))
    const stoppedSample = report.samples.filter(s => s.label === 'stopped').at(-1)
    check('the runtime is stopped (T state), not running on behind the shell', stoppedSample !== undefined && stoppedSample.stat !== null && stoppedSample.stat.startsWith('T'), JSON.stringify(stoppedSample))
    const resumedSample = report.samples.filter(s => s.label === 'resumed').at(-1)
    check('fg brings the cockpit back to the foreground', resumedSample !== undefined && resumedSample.foreground === true, JSON.stringify(resumedSample))
    check('the resumed cockpit is alive (not stopped)', resumedSample !== undefined && resumedSample.stat !== null && !resumedSample.stat.startsWith('T'), JSON.stringify(resumedSample))
    check('the journey ends back at the shell prompt (a clean exit)', report.endReason === 'done' || (report.finalGrid ?? '').includes('host$'), journeyTail(run))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
