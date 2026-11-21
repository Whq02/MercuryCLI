#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver } from '../lib/captureDriver.ts'
import { CAPTURE_PREFLIGHT_MISSING_EXIT, describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const driver = resolveCaptureDriver()
if (process.platform === 'win32' || driver.kind !== 'posix-pty') {
  console.log(`  (skipped: the POSIX capture driver is not available here — ${driver.kind === 'unavailable' ? driver.reason : driver.kind})`)
  process.exit(0)
}
const python = driver.python
const scratch = mkdtempSync(join(tmpdir(), 'capture-preflight-'))
const account = join(scratch, 'account')
const isolatedSite = join(scratch, 'python-site')
const pinnedSite = join(scratch, 'pinned-site')
for (const path of [account, isolatedSite, join(pinnedSite, 'pyte')]) mkdirSync(path, { recursive: true })
writeFileSync(join(pinnedSite, 'pyte/__init__.py'), '# Import-only emulator fixture for preflight.\n')
writeFileSync(join(isolatedSite, 'sitecustomize.py'), `import pwd, types, sys\npwd.getpwuid = lambda uid: types.SimpleNamespace(pw_dir=${JSON.stringify(account)})\nsys.path[:] = [p for p in sys.path if not p.endswith(("site-packages", "dist-packages"))]\n`)
const baseEnv: Record<string, string | undefined> = { ...process.env, HOME: account, PYTHONPATH: isolatedSite, PYTHONNOUSERSITE: '1', MERCURY_VSHOT_EMULATOR: pinnedSite }
const preflight = (env: Record<string, string | undefined>, interpreterArgs: string[] = [], interpreter = python): { rc: number; out: string } => {
  const res = spawnSync(interpreter, [...interpreterArgs, captureEngineEntry(driver, ROOT), '--preflight'], { encoding: 'utf8', env: { ...baseEnv, ...env } })
  return { rc: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

section("§1 the engine's own preflight")
const ok = preflight({})
check('a pinned emulator imports without any installed pyte package', ok.rc === 0 && ok.out.startsWith('ok ') && ok.out.trim().endsWith(join(pinnedSite, 'pyte')), `rc=${ok.rc} ${ok.out} — fix the --preflight verb of scripts/ui/vshot.py so MERCURY_VSHOT_EMULATOR is searched first and the answer starts with ok and ends with the pyte directory`)
const absent = preflight({ MERCURY_VSHOT_EMULATOR: 'none' })
check(`an empty account is refused before anything boots with exit ${CAPTURE_PREFLIGHT_MISSING_EXIT}`, absent.rc === CAPTURE_PREFLIGHT_MISSING_EXIT, `rc=${absent.rc} — the --preflight verb of scripts/ui/vshot.py must exit with the missing-emulator code CAPTURE_PREFLIGHT_MISSING_EXIT from scripts/lib/capturePreflight.ts`)
check('absence names searched locations and the install/pin remedies without inventing a copy', absent.out.includes(account) && absent.out.includes('-m pip install --user pyte') && absent.out.includes('MERCURY_VSHOT_EMULATOR') && !absent.out.includes('PYTHONPATH='), absent.out + ' — fix the refusal text of the --preflight verb in scripts/ui/vshot.py: name the searched account, the pip install --user pyte remedy and MERCURY_VSHOT_EMULATOR, and no PYTHONPATH line when no copy exists')
check('absence is not a Python traceback', !absent.out.includes('Traceback'), 'the --preflight verb of scripts/ui/vshot.py must catch the missing pyte import and print the remedy instead of a traceback: ' + absent.out)
const version = spawnSync(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', env: baseEnv, timeout: 10000 }).stdout.trim()
const accountSite = join(account, '.local/lib', `python${version}`, 'site-packages')
mkdirSync(join(accountSite, 'pyte'), { recursive: true })
writeFileSync(join(accountSite, 'pyte/__init__.py'), '# Import-only emulator fixture for account discovery.\n')
mkdirSync(join(scratch, 'nohome'))
const hidden = preflight({ HOME: join(scratch, 'nohome'), MERCURY_VSHOT_EMULATOR: '' }, ['-s'])
check('account discovery survives a scratch HOME and disabled user-site imports', hidden.rc === 0 && hidden.out.trim().endsWith(join(accountSite, 'pyte')), `rc=${hidden.rc} ${hidden.out} — fix the account-copy discovery in the --preflight verb of scripts/ui/vshot.py: it must find the account site-packages without HOME and with python -s`)
const copyRemedy = preflight({ MERCURY_VSHOT_EMULATOR: 'none' })
check('an existing account copy gets its exact PYTHONPATH remedy', copyRemedy.rc === 78 && copyRemedy.out.includes(`PYTHONPATH=${accountSite}`) && copyRemedy.out.includes('-m pip install --user pyte'), copyRemedy.out + ' — fix the remedy text of the --preflight verb in scripts/ui/vshot.py: exit 78 with the exact PYTHONPATH line for an existing account copy')
const pinned = preflight({ MERCURY_VSHOT_EMULATOR: pinnedSite })
check('the explicit pin precedes the account copy', pinned.rc === 0 && pinned.out.trim().endsWith(join(pinnedSite, 'pyte')), pinned.out + ' — the --preflight verb of scripts/ui/vshot.py must try MERCURY_VSHOT_EMULATOR before the account copy')
rmSync(join(account, '.local'), { recursive: true, force: true })
const winText = readFileSync(join(ROOT, 'scripts', 'winreg', 'vshot-win.py'), 'utf8')
check('the Windows engine carries the same verb and exit code', winText.includes('sys.argv[1] == "--preflight"') && winText.includes('EMULATOR_MISSING_EXIT = 78'), 'scripts/winreg/vshot-win.py must handle sys.argv[1] == "--preflight" and define EMULATOR_MISSING_EXIT = 78')
const winHere = spawnSync(python, [join(ROOT, 'scripts', 'winreg', 'vshot-win.py'), '--preflight'], { encoding: 'utf8', env: { ...baseEnv, PYTHONPATH: `${isolatedSite}:${pinnedSite}` } })
check(
  'the Windows engine answers its preflight on this host (ok on Windows; the console backend named on exit 78 elsewhere)',
  process.platform === 'win32' ? winHere.status === 0 : winHere.status === CAPTURE_PREFLIGHT_MISSING_EXIT && (winHere.stderr ?? '').includes('pywinpty'),
  `rc=${winHere.status} ${(winHere.stderr ?? '').slice(0, 160)} — fix the --preflight verb of scripts/winreg/vshot-win.py: ok on Windows, exit 78 naming pywinpty elsewhere`,
)

section("§2 the pool's unit")
const unit = join(ROOT, 'scripts', 'gate', 'run-suite.sh')
const estate = join(scratch, 'estate')
mkdirSync(join(estate, 'pty-suite'), { recursive: true })
mkdirSync(join(estate, 'pure-suite'), { recursive: true })
writeFileSync(join(estate, 'pty-suite', 'run-all.sh'), '#!/usr/bin/env bash\n# gate-class: pty\necho PTY RAN\n')
writeFileSync(join(estate, 'pure-suite', 'run-all.sh'), '#!/usr/bin/env bash\n# gate-class: pure\necho PURE RAN\n')
const home = join(scratch, 'home')
mkdirSync(home)
const unitRun = (suite: string, env: Record<string, string | undefined>, budget = '30'): { rc: number; out: string; rcFile: string; secs: boolean; cpu: boolean } => {
  const outDir = mkdtempSync(join(scratch, `out-${suite}-`))
  const res = spawnSync('bash', [unit, join(estate, suite, 'run-all.sh'), budget, outDir], { encoding: 'utf8', env: { ...baseEnv, MERCURY_CONFIG_DIR: home, ...env }, detached: true, timeout: 60_000 })
  if (res.error) { try { process.kill(-res.pid, 'SIGKILL') } catch {} }
  const read = (name: string): string => (existsSync(join(outDir, name)) ? readFileSync(join(outDir, name), 'utf8') : '')
  return { rc: res.status ?? -1, out: read(`${suite}.out`), rcFile: read(`${suite}.rc`).trim(), secs: existsSync(join(outDir, `${suite}.secs`)), cpu: existsSync(join(outDir, `${suite}.cpu`)) }
}
const refused = unitRun('pty-suite', { MERCURY_VSHOT_EMULATOR: 'none' })
check(`a pty suite with no emulator is refused with rc ${CAPTURE_PREFLIGHT_MISSING_EXIT} before its runner runs`, refused.rc === CAPTURE_PREFLIGHT_MISSING_EXIT && refused.rcFile === String(CAPTURE_PREFLIGHT_MISSING_EXIT) && !refused.out.includes('PTY RAN'), `rc=${refused.rc} out=${refused.out.slice(0, 120)} — the preflight block of scripts/gate/run-suite.sh must refuse a gate-class pty suite with the missing-emulator code, write it to the .rc file and not run the suite`)
check('…its .out carries the applicable remedy line', refused.out.includes('pip install --user pyte'), 'the preflight block of scripts/gate/run-suite.sh must print the remedy line into the suite .out: ' + refused.out.slice(0, 200))
check('…and the secs and cpu artifacts landed for the parent', refused.secs && refused.cpu, 'scripts/gate/run-suite.sh must write the .secs and .cpu artifacts even when the preflight refuses the suite')
const noInterpreter = unitRun('pty-suite', { MERCURY_PYTHON: join(scratch, 'no-such-python') })
check('a missing interpreter pin is refused the same way, naming the pin', noInterpreter.rc === CAPTURE_PREFLIGHT_MISSING_EXIT && noInterpreter.out.includes(join(scratch, 'no-such-python')) && !noInterpreter.out.includes('PTY RAN'), `rc=${noInterpreter.rc} out=${noInterpreter.out.slice(0, 160)} — the preflight block of scripts/gate/run-suite.sh must refuse with the missing-emulator code and name the MERCURY_PYTHON pin`)
const stalledPython = join(scratch, 'stalled-python')
writeFileSync(stalledPython, '#!/bin/sh\nexec sleep 30\n')
chmodSync(stalledPython, 0o755)
const stalled = unitRun('pty-suite', { MERCURY_PYTHON: stalledPython }, '1')
check('preflight shares the suite watchdog and publishes a truthful timed-out result', stalled.rc === 137 && stalled.rcFile === '137' && stalled.out.includes('__SUITE_TIMEOUT') && stalled.secs && stalled.cpu && !stalled.out.includes('PTY RAN'), JSON.stringify(stalled) + ' — scripts/gate/run-suite.sh must run the preflight under the same watchdog as the suite and publish rc 137, __SUITE_TIMEOUT, .secs and .cpu')
const pure = unitRun('pure-suite', { MERCURY_VSHOT_EMULATOR: 'none' })
check('a pure suite is untouched by the preflight', pure.rc === 0 && pure.out.includes('PURE RAN'), `rc=${pure.rc} — scripts/gate/run-suite.sh must run the preflight only for a gate-class pty suite`)
const ran = unitRun('pty-suite', {})
check('a pty suite with the emulator present runs', ran.rc === 0 && ran.out.includes('PTY RAN'), `rc=${ran.rc} — scripts/gate/run-suite.sh must run a pty suite when its preflight answers ok`)

section("§3 the driver's helper")
const good = preflightCaptureDriver(driver, ROOT, baseEnv)
check("ok answers with the interpreter and the emulator's directory", good.ok && good.emulator.startsWith('ok ') && good.emulator.endsWith(join(pinnedSite, 'pyte')), JSON.stringify(good) + ' — fix preflightCaptureDriver in scripts/lib/capturePreflight.ts')
const bad = preflightCaptureDriver(driver, ROOT, { ...baseEnv, MERCURY_VSHOT_EMULATOR: 'none' })
check(`absent answers the reason (exit ${CAPTURE_PREFLIGHT_MISSING_EXIT}) and the remedy line`, !bad.ok && bad.reason.includes(`exit ${CAPTURE_PREFLIGHT_MISSING_EXIT}`) && bad.remedy.includes('pip install --user pyte'), JSON.stringify(bad) + ' — fix preflightCaptureDriver in scripts/lib/capturePreflight.ts: an absent emulator answers a reason with the exit code and the remedy line')
const again = preflightCaptureDriver(driver, ROOT, { ...baseEnv, MERCURY_VSHOT_EMULATOR: 'none' })
check('asked once per interpreter and environment (the same answer object)', again === bad, 'preflightCaptureDriver in scripts/lib/capturePreflight.ts must cache its answer per interpreter and environment and return the same object')
const viaPin = preflightCaptureDriver(driver, ROOT, { ...baseEnv, MERCURY_VSHOT_EMULATOR: pinnedSite })
check('a pinned directory is named in the answer', viaPin.ok && viaPin.emulator.endsWith(join(pinnedSite, 'pyte')), JSON.stringify(viaPin) + ' — fix preflightCaptureDriver in scripts/lib/capturePreflight.ts: the pinned directory must appear in the answer')
const described = describeCapturePreflight(bad)
check('the refusal describes itself as the reason and the indented remedy lines', !bad.ok && described.startsWith(bad.reason) && described.includes('\n  vshot:') && described.includes('install it:'), described + ' — fix describeCapturePreflight in scripts/lib/capturePreflight.ts')
const gone = preflightCaptureDriver({ ...driver, python: join(scratch, 'no-such-python') }, ROOT, baseEnv)
check('a driver whose interpreter is missing answers the reason and a remedy', !gone.ok && gone.reason.includes('did not run') && gone.remedy.length > 0, JSON.stringify(gone) + ' — fix preflightCaptureDriver in scripts/lib/capturePreflight.ts: a missing interpreter answers a did-not-run reason and a remedy')

section('the gate shape interpreter follows the host, independently of the capture pin')
{
  const unit = readFileSync(join(ROOT, 'scripts/gate/run-suite.sh'), 'utf8')
  const resolver = unit.match(/^shape_python\(\) \{[\s\S]*?^\}/m)?.[0] ?? ''
  check('the gate has one shape interpreter resolver', resolver !== '', 'scripts/gate/run-suite.sh must define one shape_python() { ... } function whose closing brace starts a line')
  for (const [host, python, python3, pin, expected, status] of [
    ['MINGW64_NT-10.0', 0, 0, '', 'python', 0],
    ['MSYS_NT-10.0', 0, 78, '', 'python', 0],
    ['CYGWIN_NT-10.0', 0, 78, '', 'python', 0],
    ['Darwin', 0, 0, '', 'python3', 0],
    ['Linux', 0, 78, '', 'python', 0],
    ['MINGW64_NT-10.0', 78, 0, '', 'python3', 0],
    ['Darwin', 0, 0, '/missing/capture-python', 'python3', 0],
    ['MINGW64_NT-10.0', 78, 78, '', '', 78],
  ] as const) {
    const code = `uname() { printf '%s' '${host}'; }\npython() { return ${python}; }\npython3() { return ${python3}; }\n${resolver}\nshape_python`
    const result = spawnSync('bash', ['-c', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MERCURY_PYTHON: pin }, timeout: 10_000 })
    check(`${host}: usable interpreter ${expected || '(none)'}; capture pin ${pin || '(unset)'}`, result.status === status && result.stdout === expected, `status ${result.status}, output ${JSON.stringify(result.stdout)} — fix shape_python in scripts/gate/run-suite.sh`)
  }
  check('both box-shape calls use the selected interpreter and a missing interpreter stops the gate', unit.includes('python=$(shape_python) || exit 78') && unit.includes('"$python" "$repo_root/scripts/lib/box_shape.py" --start') && unit.includes('budget=$("$python" "$repo_root/scripts/lib/box_shape.py" --budget'), 'scripts/gate/run-suite.sh must set python=$(shape_python) || exit 78 and call box_shape.py --start and --budget through "$python"')
}

section('the runner proof host keeps the Windows PATH and explicit overrides')
{
  const { mock } = await import('bun:test')
  const childProcess = await import('node:child_process')
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalPath = process.env.PATH
  const launches: Array<NodeJS.ProcessEnv> = []
  mock.module('node:child_process', () => ({ ...childProcess, spawn: (_file: string, _argv: string[], options: { env: NodeJS.ProcessEnv }) => {
    launches.push(options.env)
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  } }))
  try {
    const { hostRunner } = await import('../lib/runnerHost.ts')
    for (const [host, path, override, expected] of [
      ['win32', 'C:\\Windows\\System32;C:\\Tools', undefined, 'C:\\Windows\\System32;C:\\Tools'],
      ['win32', 'C:\\Windows', 'D:\\Pinned', 'D:\\Pinned'],
      ['darwin', '/usr/local/bin', undefined, '/usr/bin:/bin:/runtime/bin'],
    ] as const) {
      Object.defineProperty(process, 'platform', { value: host, configurable: true })
      process.env.PATH = path
      const runner = hostRunner({ node: '/runtime/bin/node', dist: 'unused', home: ROOT, cwd: ROOT, env: override === undefined ? {} : { PATH: override } })
      check(`${host}: the spawned runner receives its intended search path`, launches.at(-1)?.PATH === expected, String(launches.at(-1)?.PATH) + ' — fix the PATH given to the spawned runner in hostRunner in scripts/lib/runnerHost.ts')
      runner.peer.close('fixture finished')
      runner.child.emit('close', 0)
      await runner.exited
      runner.child.stdin?.destroy()
      runner.child.stdout?.destroy()
      runner.child.stderr?.destroy()
    }
  } finally {
    mock.restore()
    Object.defineProperty(process, 'platform', platform)
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
