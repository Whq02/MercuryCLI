#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }
const BUN = process.execPath

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const SEAM = 'MERCURY_WINDOWS_SHELL_ROAD'
const PIN = 'MERCURY_GIT_BASH_PATH'

function roadSubprocess(body: string, env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
  const road = join(ROOT, 'src/utils/shell/windowsShellRoad.ts').replace(/\\/g, '\\\\')
  const utils = join(ROOT, 'src/utils/shell/shellToolUtils.ts').replace(/\\/g, '\\\\')
  const paths = join(ROOT, 'src/utils/windowsPaths.ts').replace(/\\/g, '\\\\')
  const script = `
    ;(globalThis).MACRO = { VERSION: '0.0.0' }
    const road = await import('${road}')
    const utils = await import('${utils}')
    const paths = await import('${paths}')
    ${body}
  `
  const r = spawnSync(BUN, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, [SEAM]: undefined, [PIN]: undefined, MERCURY_USE_POWERSHELL_TOOL: undefined, ...env },
    timeout: 60_000,
  })
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

const { composeWindowsBashRoad, WINDOWS_BASH_NOTICE } = await import('../../src/utils/shell/windowsShellRoad.ts')
const { GIT_BASH_REMEDY, findGitBashPath, locateGitBash } = await import('../../src/utils/windowsPaths.ts')

console.log('── §1 the composer is pure ──')
{
  const engine = composeWindowsBashRoad({ path: 'C:\\Git\\bin\\bash.exe' }, { path: 'C:\\m\\vendor\\brush\\win32-x64\\brush.exe' })
  check('an armed engine wins over a found git-bash', engine.kind === 'engine' && engine.path.endsWith('brush.exe'))
  const gitBash = composeWindowsBashRoad({ path: 'C:\\Git\\bin\\bash.exe' }, null)
  check('no engine ⇒ git-bash with the located path', gitBash.kind === 'git-bash' && gitBash.path === 'C:\\Git\\bin\\bash.exe')
  const absent = composeWindowsBashRoad({ absent: true }, null)
  check('neither ⇒ a typed absence', absent.kind === 'absent')
  const remedy = absent.kind === 'absent' ? absent.remedy : ''
  check('the remedy names Git for Windows', /git-scm\.com\/downloads\/win/.test(remedy))
  check('the remedy names the MERCURY_GIT_BASH_PATH= pin', remedy.includes(`${PIN}=`))
  check('the remedy names the shell engine', /shell engine/.test(remedy))
  check('the remedy is the ONE owner (the locator\'s words)', remedy === GIT_BASH_REMEDY)
  check('the notice is one line naming the same three fixes', !WINDOWS_BASH_NOTICE.includes('\n') && /Git for Windows/.test(WINDOWS_BASH_NOTICE) && WINDOWS_BASH_NOTICE.includes(`${PIN}=`) && /shell engine/.test(WINDOWS_BASH_NOTICE))
  const enginePresentAbsentBash = composeWindowsBashRoad({ absent: true }, { path: 'brush.exe' })
  check('an engine with no git at all is the engine road (no Git dependency)', enginePresentAbsentBash.kind === 'engine')
}

console.log('── §2 the locator: typed answers, one loud refusal ──')
{
  const location = locateGitBash()
  const found = 'path' in location
  check(`discovery on this host is a typed answer (${found ? `found ${location.path}` : 'absent'})`, found || ('absent' in location && location.absent === true))
  let threw: string | null = null
  let returned: string | null = null
  try {
    returned = findGitBashPath()
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check('findGitBashPath agrees: the path when found, the remedy THROWN when absent (never an exit)', found ? returned === location.path : threw === GIT_BASH_REMEDY)

  const nowhere = join(tmpdir(), 'shell-road-nowhere', 'bash.exe')
  const pinNowhere = roadSubprocess('console.log(JSON.stringify(paths.locateGitBash()))', { [PIN]: nowhere })
  check('a pin that is SET and points nowhere exits 1', pinNowhere.status === 1, `status ${pinNowhere.status}`)
  check('…and says so on stderr, naming the pin', pinNowhere.stderr.includes(`unable to find ${PIN} at ${nowhere}`), pinNowhere.stderr.slice(0, 160))
  const existing = import.meta.path
  const pinExists = roadSubprocess('console.log(JSON.stringify(paths.locateGitBash()))', { [PIN]: existing })
  check('a pin that exists resolves to it', pinExists.status === 0 && pinExists.stdout === JSON.stringify({ path: existing }), pinExists.stdout.slice(0, 160) || pinExists.stderr.slice(0, 160))
}

console.log('── §3 the roster follows the road ──')
{
  const probe = 'console.log(JSON.stringify({ active: road.windowsShellRoadActive(), bash: road.bashToolAvailable(), ps: utils.isPowerShellToolEnabled(), notice: road.windowsShellRoadNotice() }))'
  const noBash = roadSubprocess(probe, { [SEAM]: 'no-bash' })
  check('the seam walks the road', noBash.status === 0, noBash.stderr.slice(0, 200))
  const nb = noBash.status === 0 ? (JSON.parse(noBash.stdout) as { active: boolean; bash: boolean; ps: boolean; notice: string | null }) : null
  check('on the road without bash: the Bash tool is OFF the roster', nb?.active === true && nb.bash === false)
  check('…and the PowerShell tool is ON it without the opt-in', nb?.ps === true)
  check('…and the boot notice is the one line', nb?.notice === WINDOWS_BASH_NOTICE)

  const withBash = roadSubprocess(probe, { [SEAM]: 'locate', [PIN]: import.meta.path })
  const wb = withBash.status === 0 ? (JSON.parse(withBash.stdout) as { active: boolean; bash: boolean; ps: boolean; notice: string | null }) : null
  check('on the road WITH a bash: the Bash tool stands, PowerShell keeps its opt-in, no notice', wb?.active === true && wb.bash === true && wb.ps === false && wb.notice === null, withBash.stderr.slice(0, 200))
  const withBashOptIn = roadSubprocess(probe, { [SEAM]: 'locate', [PIN]: import.meta.path, MERCURY_USE_POWERSHELL_TOOL: '1' })
  const wo = withBashOptIn.status === 0 ? (JSON.parse(withBashOptIn.stdout) as { bash: boolean; ps: boolean }) : null
  check('…and the opt-in still turns PowerShell on beside Bash', wo?.bash === true && wo.ps === true)

  const offRoad = roadSubprocess(probe, {})
  const off = offRoad.status === 0 ? (JSON.parse(offRoad.stdout) as { active: boolean; bash: boolean; ps: boolean; notice: string | null }) : null
  const hostIsWindows = process.platform === 'win32'
  check(
    hostIsWindows ? 'this host IS the road: a bash was located (the roster stands)' : 'off the road (this host): the Bash tool stands, PowerShell is off, no notice',
    hostIsWindows ? off?.active === true : off?.active === false && off.bash === true && off.ps === false && off.notice === null,
    offRoad.stderr.slice(0, 200),
  )
}

console.log('── §4 a bash-lane hook refuses typed ──')
{
  const hook = roadSubprocess(
    "try { road.hookBashShell('echo hi'); console.log('RETURNED') } catch (e) { console.log('THREW ' + (e instanceof Error ? e.message : String(e))) }",
    { [SEAM]: 'no-bash' },
  )
  check('the hook lane throws (never exits) on the road without bash', hook.status === 0 && hook.stdout.startsWith('THREW '), hook.stdout.slice(0, 120) || hook.stderr.slice(0, 200))
  check('…naming the hook command and the remedy', hook.stdout.includes('Hook "echo hi"') && hook.stdout.includes(GIT_BASH_REMEDY))
  const hookWithBash = roadSubprocess("console.log(road.hookBashShell('echo hi'))", { [SEAM]: 'locate', [PIN]: import.meta.path })
  check('with a bash the hook spawns under it', hookWithBash.status === 0 && hookWithBash.stdout === import.meta.path)
}

console.log('── §5 the built bundle boots headless through the seam ──')
{
  const bundle = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(bundle)) {
    check('dist/mercury.mjs is present (build first: bun run build.ts)', false)
  } else {
    const home = mkdtempSync(join(tmpdir(), 'shell-road-home-'))
    const hermetic = {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      [SEAM]: undefined,
      [PIN]: undefined,
      MERCURY_USE_POWERSHELL_TOOL: undefined,
    }
    const doctor = (extra: Record<string, string>) =>
      spawnSync('node', [bundle, 'doctor', '--json'], { encoding: 'utf8', env: { ...hermetic, ...extra }, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
    type Check = { id: string; status: string; evidence: string; fix?: string }
    type Row = { id: string; state: string; detail: string; remedy?: string }
    type Cert = { verdict?: string; sections?: Array<{ checks: Check[] }>; readiness?: Row[] }
    const parse = (text: string): Cert | null => {
      try {
        return JSON.parse(text) as Cert
      } catch {
        return null
      }
    }
    const shellCheck = (c: Cert | null): Check | undefined => c?.sections?.flatMap(s => s.checks).find(x => x.id === 'shell')
    const shellRow = (c: Cert | null): Row | undefined => c?.readiness?.find(r => r.id === 'tool:shell')

    const faults = (c: Cert | null): string[] => c?.sections?.flatMap(s => s.checks).filter(x => x.status === 'fail').map(x => x.id) ?? []

    const control = doctor({})
    const controlCert = parse(control.stdout)
    check('control: doctor --json produced a certificate', controlCert !== null && typeof controlCert.verdict === 'string', `status ${control.status}; ${control.stderr.slice(0, 200)}`)
    console.log(`  (control: verdict ${controlCert?.verdict ?? '?'}, exit ${control.status}; failing checks on this host: ${faults(controlCert).join(', ') || 'none'} — the seam run must match them exactly)`)
    const controlShell = shellCheck(controlCert)
    check('control: the shell check is ok on this host', controlShell?.status === 'ok', JSON.stringify(controlShell)?.slice(0, 200))

    const seamRun = doctor({ [SEAM]: 'no-bash' })
    const seamCert = parse(seamRun.stdout)
    check('seam: the bundle BOOTS and produces a certificate with bash.exe absent', seamCert !== null && typeof seamCert.verdict === 'string', `status ${seamRun.status}; ${seamRun.stderr.slice(0, 200)}`)
    check('seam: the exit code equals the control run\'s (the road never worsens the verdict)', seamRun.status === control.status, `seam ${seamRun.status} vs control ${control.status}`)
    check('seam: the failing checks are exactly the control run\'s (the road adds no fault)', JSON.stringify(faults(seamCert)) === JSON.stringify(faults(controlCert)), `seam [${faults(seamCert).join(', ')}] vs control [${faults(controlCert).join(', ')}]`)
    const seamShell = shellCheck(seamCert)
    check('seam: the shell check WARNS (a warning, never a fault)', seamShell?.status === 'warn', JSON.stringify(seamShell)?.slice(0, 240))
    check('seam: its evidence says the Bash tool is absent and PowerShell present', /Bash tool is absent/.test(seamShell?.evidence ?? '') && /PowerShell tool is present/.test(seamShell?.evidence ?? ''))
    check('seam: its fix is the notice', seamShell?.fix === WINDOWS_BASH_NOTICE)
    const seamRow = shellRow(seamCert)
    check('seam: the tool:shell readiness row reads unavailable with the remedy', seamRow?.state === 'unavailable' && seamRow.remedy === WINDOWS_BASH_NOTICE, JSON.stringify(seamRow)?.slice(0, 240))
    const controlRow = shellRow(controlCert)
    check('control: the tool:shell row is a probed or configured shell', controlRow !== undefined && (controlRow.state === 'ready' || controlRow.state === 'configured'), JSON.stringify(controlRow)?.slice(0, 200))

    const nowhere = join(home, 'nowhere', 'bash.exe')
    const pin = doctor({ [SEAM]: 'locate', [PIN]: nowhere })
    check('the pin-that-points-nowhere arm exits 1 on the doctor route (the boot step runs for every verb)', pin.status === 1, `status ${pin.status}`)
    check('…with its message on stderr', pin.stderr.includes(`unable to find ${PIN} at ${nowhere}`), pin.stderr.slice(0, 200))
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('── §6 the consumers are wired (source) ──')
{
  const bashTool = read('src/tools/BashTool/BashTool.tsx')
  check('the Bash tool enables by the road', bashTool.includes('isEnabled: () => bashToolAvailable()'))
  const bang = read('src/utils/processUserInput/processBashCommand.tsx')
  check('the `!` road refuses by the road with the notice words', bang.includes('!usePowerShell && !bashToolAvailable()') && bang.includes('WINDOWS_BASH_NOTICE'))
  const hooks = read('src/utils/hooks/execution.ts')
  check('the bash-lane hook spawns under the road, not an exiting locator', hooks.includes('hookBashShell(hook.command)') && !hooks.includes('findGitBashPath'))
  const init = read('src/entrypoints/init.ts')
  check('the boot step arms the road', init.includes('armWindowsShellRoad()') && !init.includes('setShellIfWindows'))
  const repl = read('src/screens/REPL.tsx')
  check('the interactive boot notice rides the REPL notification', repl.includes("key: 'shell-road'") && repl.includes('windowsShellRoadNotice()'))
  const print = read('src/cli/print.ts')
  check('the headless boot notice is one stderr line', print.includes('windowsShellRoadNotice()') && print.includes('process.stderr.write(`${shellRoadNotice}\\n`)'))
  const readiness = read('src/utils/readiness.ts')
  check('the readiness row exists', readiness.includes("id: 'tool:shell'") && readiness.includes('describeWindowsShellRoad()'))
  const health = read('src/utils/healthReport.ts')
  check('the certificate check exists', health.includes("id: 'shell',") && health.includes('describeWindowsShellRoad'))
  const wp = read('src/utils/windowsPaths.ts')
  const missingArm = wp.slice(wp.indexOf('for (const candidate of gitBashCandidatePaths'))
  check('the locator\'s discovery arm never exits', missingArm.includes('return { absent: true }') && !/process\.exit\(/.test(missingArm))
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  check('the seam is registered', FLAG_REGISTRY.some(s => s.env === SEAM))
  const utils = read('src/utils/shell/shellToolUtils.ts')
  check('the PowerShell predicate reads the road and keeps its literal opt-in read', utils.includes("windowsBashRoad().kind === 'absent'") && utils.includes('process.env.MERCURY_USE_POWERSHELL_TOOL'))
}

console.log(failures === 0 ? '\n✅ WINDOWS SHELL ROAD PROOF PASS' : `\n❌ WINDOWS SHELL ROAD PROOF RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
