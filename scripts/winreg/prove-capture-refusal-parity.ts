#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver } from '../lib/captureDriver.ts'
import { CAPTURE_PREFLIGHT_MISSING_EXIT } from '../lib/capturePreflight.ts'

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
const scratch = mkdtempSync(join(tmpdir(), 'capture-refusal-'))
const absentEnv = { ...process.env, MERCURY_VSHOT_EMULATOR: 'none' }

section('§1 a capture with no emulator ends on the refusal, before its configuration is read')
const cfgPath = join(scratch, 'never-written.json')
const capture = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { encoding: 'utf8', env: absentEnv })
const err = capture.stderr ?? ''
check(`the POSIX engine exits ${CAPTURE_PREFLIGHT_MISSING_EXIT}`, capture.status === CAPTURE_PREFLIGHT_MISSING_EXIT, `rc=${capture.status}`)
check('…with the remedy (the PYTHONPATH line and the pip line)', err.includes('run it as: PYTHONPATH=') && err.includes('-m pip install --user pyte'), err.slice(0, 200))
check('…and no traceback, no mention of the configuration it never read', !err.includes('Traceback') && !err.includes(cfgPath))
const posixText = readFileSync(captureEngineEntry(driver, ROOT), 'utf8')
const winText = readFileSync(join(ROOT, 'scripts', 'winreg', 'vshot-win.py'), 'utf8')
check('both engines refuse a missing module on the same exit code', posixText.includes('EMULATOR_MISSING_EXIT = 78') && winText.includes('EMULATOR_MISSING_EXIT = 78'))
check('both engines name the interpreter and its pip line in the refusal', /pip install --user pyte/.test(posixText) && /pip install --user pyte/.test(winText) && /pip install --user pywinpty/.test(winText))
const posixPreflightAt = posixText.indexOf('"--preflight"')
const posixCfgAt = posixText.indexOf('cfg = json.load(')
const winPreflightAt = winText.indexOf('"--preflight"')
const winCfgAt = winText.indexOf('cfg = json.load(')
check(
  'both engines answer --preflight before any capture code',
  posixPreflightAt !== -1 && posixCfgAt !== -1 && posixPreflightAt < posixCfgAt && winPreflightAt !== -1 && winCfgAt !== -1 && winPreflightAt < winCfgAt,
  `posix ${posixPreflightAt}/${posixCfgAt} · windows ${winPreflightAt}/${winCfgAt}`,
)

section('§2 the render entrypoint refuses before it stages a scenario')
const renderHome = join(scratch, 'render-home')
mkdirSync(renderHome)
const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
const render = spawnSync(
  bun,
  ['run', join(ROOT, 'scripts', 'ui', 'render-tui.ts'), '--scenario', 'resume-2turn', '--cols', '80', '--rows', '24', '--out', join(scratch, 'never.png'), '--grid', join(scratch, 'never.json')],
  { encoding: 'utf8', cwd: ROOT, env: { ...absentEnv, MERCURY_CONFIG_DIR: renderHome }, timeout: 60_000 },
)
const stagedProjects = existsSync(join(renderHome, 'projects')) ? readdirSync(join(renderHome, 'projects')) : []
check('render-tui exits 2 naming the missing engine and the remedy', render.status === 2 && (render.stderr ?? '').includes('no capture engine') && (render.stderr ?? '').includes('PYTHONPATH='), `rc=${render.status} ${(render.stderr ?? '').slice(0, 200)}`)
check('…before any scenario is staged or a frame written', stagedProjects.length === 0 && !existsSync(join(scratch, 'never.json')) && !existsSync(join(scratch, 'never.png')), `projects=${stagedProjects.join(',')}`)

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
