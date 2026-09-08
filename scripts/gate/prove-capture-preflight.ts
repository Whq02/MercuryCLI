#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const baseEnv: Record<string, string | undefined> = { ...process.env, MERCURY_VSHOT_EMULATOR: undefined }
const preflight = (env: Record<string, string | undefined>, interpreterArgs: string[] = [], interpreter = python): { rc: number; out: string } => {
  const res = spawnSync(interpreter, [...interpreterArgs, captureEngineEntry(driver, ROOT), '--preflight'], { encoding: 'utf8', env: { ...baseEnv, ...env } })
  return { rc: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

section("§1 the engine's own preflight")
const ok = preflight({})
check("--preflight answers ok with the interpreter and the emulator's directory", ok.rc === 0 && /^ok \S+ \S+pyte\s*$/.test(ok.out), `rc=${ok.rc} ${ok.out}`)
const emulatorDir = ok.out.trim().split(' ')[2] ?? ''
mkdirSync(join(scratch, 'nohome'))
const hidden = preflight({ HOME: join(scratch, 'nohome') }, ['-s'])
check("a scratch HOME with the user site disabled still resolves through the real account's site", hidden.rc === 0 && hidden.out.startsWith('ok '), `rc=${hidden.rc} ${hidden.out}`)
const pinnedSite = join(scratch, 'pinned-site')
mkdirSync(pinnedSite)
if (emulatorDir !== '' && existsSync(emulatorDir)) cpSync(emulatorDir, join(pinnedSite, 'pyte'), { recursive: true })
const pinned = preflight({ MERCURY_VSHOT_EMULATOR: pinnedSite })
check('a pinned directory is looked at first: the answer names the copy under it', pinned.rc === 0 && pinned.out.trim().endsWith(join(pinnedSite, 'pyte')), `rc=${pinned.rc} ${pinned.out}`)
const absent = preflight({ MERCURY_VSHOT_EMULATOR: 'none' })
check(`the emulator absent: exit ${CAPTURE_PREFLIGHT_MISSING_EXIT} before anything boots`, absent.rc === CAPTURE_PREFLIGHT_MISSING_EXIT, `rc=${absent.rc}`)
check('…naming the interpreter and every place it looked', /not importable by \/\S*python3?[^;]*; looked in: .*site-packages.*vendor\./.test(absent.out), absent.out)
check('…with the exact PYTHONPATH line to run it with', /run it as: PYTHONPATH=\/\S+ \/\S+ scripts\/ui\/vshot\.py <cfg>/.test(absent.out), absent.out)
check('…and the pip line', absent.out.includes('-m pip install --user pyte'))
check('…and no traceback', !absent.out.includes('Traceback'))
const otherInterpreters = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3.12', '/usr/bin/python3.13']
const lacking = otherInterpreters.find(p => p !== python && existsSync(p) && spawnSync(p, ['-c', 'import pyte'], { encoding: 'utf8', env: baseEnv }).status !== 0)
if (lacking === undefined) console.log('  (no second interpreter without the emulator on this box — the real absence is covered by the seam above)')
else {
  const real = preflight({}, [], lacking)
  check(`an interpreter that really lacks the emulator (${lacking}) is refused with the remedy`, real.rc === CAPTURE_PREFLIGHT_MISSING_EXIT && real.out.includes('pip install --user pyte'), `rc=${real.rc} ${real.out.slice(0, 200)}`)
}
const winText = readFileSync(join(ROOT, 'scripts', 'winreg', 'vshot-win.py'), 'utf8')
check('the Windows engine carries the same verb and exit code', winText.includes('sys.argv[1] == "--preflight"') && winText.includes('EMULATOR_MISSING_EXIT = 78'))
const winHere = spawnSync(python, [join(ROOT, 'scripts', 'winreg', 'vshot-win.py'), '--preflight'], { encoding: 'utf8', env: baseEnv })
check(
  'the Windows engine answers its preflight on this host (ok on Windows; the console backend named on exit 78 elsewhere)',
  process.platform === 'win32' ? winHere.status === 0 : winHere.status === CAPTURE_PREFLIGHT_MISSING_EXIT && (winHere.stderr ?? '').includes('pywinpty'),
  `rc=${winHere.status} ${(winHere.stderr ?? '').slice(0, 160)}`,
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
const unitRun = (suite: string, env: Record<string, string | undefined>): { rc: number; out: string; rcFile: string; secs: boolean; cpu: boolean } => {
  const outDir = mkdtempSync(join(scratch, `out-${suite}-`))
  const res = spawnSync('bash', [unit, join(estate, suite, 'run-all.sh'), '30', outDir], { encoding: 'utf8', env: { ...baseEnv, MERCURY_CONFIG_DIR: home, ...env } })
  const read = (name: string): string => (existsSync(join(outDir, name)) ? readFileSync(join(outDir, name), 'utf8') : '')
  return { rc: res.status ?? -1, out: read(`${suite}.out`), rcFile: read(`${suite}.rc`).trim(), secs: existsSync(join(outDir, `${suite}.secs`)), cpu: existsSync(join(outDir, `${suite}.cpu`)) }
}
const refused = unitRun('pty-suite', { MERCURY_VSHOT_EMULATOR: 'none' })
check(`a pty suite with no emulator is refused with rc ${CAPTURE_PREFLIGHT_MISSING_EXIT} before its runner runs`, refused.rc === CAPTURE_PREFLIGHT_MISSING_EXIT && refused.rcFile === String(CAPTURE_PREFLIGHT_MISSING_EXIT) && !refused.out.includes('PTY RAN'), `rc=${refused.rc} out=${refused.out.slice(0, 120)}`)
check('…its .out carries the remedy line', refused.out.includes('PYTHONPATH='))
check('…and the secs and cpu artifacts landed for the parent', refused.secs && refused.cpu)
const noInterpreter = unitRun('pty-suite', { MERCURY_PYTHON: join(scratch, 'no-such-python') })
check('a missing interpreter pin is refused the same way, naming the pin', noInterpreter.rc === CAPTURE_PREFLIGHT_MISSING_EXIT && noInterpreter.out.includes(join(scratch, 'no-such-python')) && !noInterpreter.out.includes('PTY RAN'), `rc=${noInterpreter.rc} out=${noInterpreter.out.slice(0, 160)}`)
const pure = unitRun('pure-suite', { MERCURY_VSHOT_EMULATOR: 'none' })
check('a pure suite is untouched by the preflight', pure.rc === 0 && pure.out.includes('PURE RAN'), `rc=${pure.rc}`)
const ran = unitRun('pty-suite', {})
check('a pty suite with the emulator present runs', ran.rc === 0 && ran.out.includes('PTY RAN'), `rc=${ran.rc}`)

section("§3 the driver's helper")
const good = preflightCaptureDriver(driver, ROOT, baseEnv)
check("ok answers with the interpreter and the emulator's directory", good.ok && /^ok \S+ \S+pyte$/.test(good.emulator), JSON.stringify(good))
const bad = preflightCaptureDriver(driver, ROOT, { ...baseEnv, MERCURY_VSHOT_EMULATOR: 'none' })
check(`absent answers the reason (exit ${CAPTURE_PREFLIGHT_MISSING_EXIT}) and the remedy line`, !bad.ok && bad.reason.includes(`exit ${CAPTURE_PREFLIGHT_MISSING_EXIT}`) && bad.remedy.includes('PYTHONPATH='), JSON.stringify(bad))
const again = preflightCaptureDriver(driver, ROOT, { ...baseEnv, MERCURY_VSHOT_EMULATOR: 'none' })
check('asked once per interpreter and environment (the same answer object)', again === bad)
const viaPin = preflightCaptureDriver(driver, ROOT, { ...baseEnv, MERCURY_VSHOT_EMULATOR: pinnedSite })
check('a pinned directory is named in the answer', viaPin.ok && viaPin.emulator.endsWith(join(pinnedSite, 'pyte')), JSON.stringify(viaPin))
const described = describeCapturePreflight(bad)
check('the refusal describes itself as the reason and the indented remedy lines', !bad.ok && described.startsWith(bad.reason) && described.includes('\n  vshot:') && described.includes('\n  or install it:'), described)
const gone = preflightCaptureDriver({ ...driver, python: join(scratch, 'no-such-python') }, ROOT, baseEnv)
check('a driver whose interpreter is missing answers the reason and a remedy', !gone.ok && gone.reason.includes('did not run') && gone.remedy.length > 0, JSON.stringify(gone))

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
