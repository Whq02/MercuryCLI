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
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const SEAM = 'MERCURY_WINDOWS_SHELL_ROAD'
const PIN = 'MERCURY_GIT_BASH_PATH'
const ENGINE_PIN = 'MERCURY_SHELL_ENGINE'
const SUB_HOME = mkdtempSync(join(tmpdir(), 'shell-road-sub-home-'))

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
    env: { ...process.env, MERCURY_CONFIG_DIR: SUB_HOME, MERCURY_CREDENTIAL_STORE: 'file', [SEAM]: undefined, [PIN]: undefined, [ENGINE_PIN]: undefined, MERCURY_USE_POWERSHELL_TOOL: undefined, ...env },
    timeout: 60_000,
  })
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

const road = await import('../../src/utils/shell/windowsShellRoad.ts')
const { composeWindowsBashRoad, WINDOWS_BASH_NOTICE, WINDOWS_BASH_NOTICE_NO_PACK } = road
const { shellEngineArmWords, shellEngineRequest } = await import('../../src/utils/shell/shellEngineArm.ts')
const { GIT_BASH_REMEDY, findGitBashPath, locateGitBash } = await import('../../src/utils/windowsPaths.ts')
const { resolveBrushPackDir } = await import('../../src/utils/shell/brushPack.ts')
const { resolveBashPackDir } = await import('../../src/utils/shell/bashPack.ts')
const PACK_PRESENT = resolveBrushPackDir().state === 'ok'
const shippedBash = resolveBashPackDir()
const SHIPPED_BASH = shippedBash.state === 'ok' ? shippedBash.binaryPath : null
const REAL_BASH = existsSync('/bin/bash') ? '/bin/bash' : null
console.log(`  (shell engine pack on this tree: ${PACK_PRESENT ? 'present — the road without bash arms the bundled engine' : 'absent — the road without bash is the typed absence'})`)

console.log('── §1 the composer and the arm ladder are pure ──')
{
  const packed = { path: 'C:\\m\\vendor\\bash\\win-x64\\usr\\bin\\bash.exe', programsDir: 'C:\\m\\vendor\\bash\\win-x64\\usr\\bin' }
  const engine = composeWindowsBashRoad({ path: 'C:\\Git\\bin\\bash.exe' }, packed, { path: 'C:\\m\\vendor\\brush\\win-x64\\brush.exe', arm: 'setting' })
  check('an engine armed by the setting or the pin wins over a found git-bash and over the shipped bash, carrying its arm', engine.kind === 'engine' && engine.path.endsWith('brush.exe') && engine.arm === 'setting')
  const gitBash = composeWindowsBashRoad({ path: 'C:\\Git\\bin\\bash.exe' }, packed, null)
  check('no engine armed ⇒ git-bash with the located path, before the shipped bash', gitBash.kind === 'git-bash' && gitBash.path === 'C:\\Git\\bin\\bash.exe')
  const shippedRoad = composeWindowsBashRoad({ absent: true }, packed, null)
  check('no bash found ⇒ the bash Mercury ships', shippedRoad.kind === 'shipped' && shippedRoad.path === packed.path)
  const absent = composeWindowsBashRoad({ absent: true }, null, null)
  check('neither ⇒ a typed absence', absent.kind === 'absent')
  const shellFor = (road as { shellEnvForRoad?: (r: unknown, g: unknown) => string | null }).shellEnvForRoad
  check('RED ON THE BASE (F39W-7L-01/02): on the engine road with a git-bash located, SHELL still points at that bash — a streamed, background or env-inheriting command does not ride the engine and must find one', typeof shellFor === 'function' && shellFor(engine, { path: 'C:\\Git\\bin\\bash.exe' }) === 'C:\\Git\\bin\\bash.exe')
  check('on the git-bash road SHELL is that bash, on the shipped road the shipped bash; on the engine road with no bash at all, and on the absence, nothing is exported', typeof shellFor === 'function' && shellFor(gitBash, { path: 'C:\\Git\\bin\\bash.exe' }) === 'C:\\Git\\bin\\bash.exe' && shellFor(shippedRoad, { absent: true }) === packed.path && shellFor(composeWindowsBashRoad({ absent: true }, null, { path: 'brush.exe', arm: 'no-bash' }), { absent: true }) === null && shellFor(absent, { absent: true }) === null)
  const remedy = absent.kind === 'absent' ? absent.remedy : ''
  check('the remedy names Git for Windows', /git-scm\.com\/downloads\/win/.test(remedy))
  check('the remedy names the MERCURY_GIT_BASH_PATH= pin', remedy.includes(`${PIN}=`))
  check('the remedy names the shell engine', /shell engine/.test(remedy))
  check('the remedy is the ONE owner (the locator\'s words)', remedy === GIT_BASH_REMEDY)
  check('the notice is one line naming the same three fixes', !WINDOWS_BASH_NOTICE.includes('\n') && /Git for Windows/.test(WINDOWS_BASH_NOTICE) && WINDOWS_BASH_NOTICE.includes(`${PIN}=`) && /shell engine/.test(WINDOWS_BASH_NOTICE))
  check('the no-pack fix is one line naming the pack as the third way', typeof WINDOWS_BASH_NOTICE_NO_PACK === 'string' && !WINDOWS_BASH_NOTICE_NO_PACK.includes('\n') && /Git for Windows/.test(WINDOWS_BASH_NOTICE_NO_PACK) && WINDOWS_BASH_NOTICE_NO_PACK.includes(`${PIN}=`) && /shell engine pack/.test(WINDOWS_BASH_NOTICE_NO_PACK))
  const enginePresentAbsentBash = composeWindowsBashRoad({ absent: true }, null, { path: 'brush.exe', arm: 'no-bash' })
  check('an engine with no git and no shipped bash is the engine road (no Git dependency), its arm kept', enginePresentAbsentBash.kind === 'engine' && enginePresentAbsentBash.arm === 'no-bash')

  const ladder = (pin: string | undefined, setting: 'system' | 'brush' | undefined, bashAbsent: boolean): string => JSON.stringify(shellEngineRequest(pin, setting, bashAbsent))
  const want = (requested: string, arm: string): string => JSON.stringify({ requested, arm })
  check('nothing set, a bash found ⇒ the system shell by default', ladder(undefined, undefined, false) === want('system', 'default'))
  check('nothing set, no bash found ⇒ the engine arms itself (arm no-bash)', ladder(undefined, undefined, true) === want('brush', 'no-bash'))
  check('the brush pin arms the engine with a bash found', ladder('brush', undefined, false) === want('brush', 'pin'))
  check('the system pin forces the system shell even with no bash found', ladder('system', 'brush', true) === want('system', 'pin'))
  check('the brush setting arms the engine with a bash found', ladder(undefined, 'brush', false) === want('brush', 'setting'))
  check('the system setting forces the system shell even with no bash found', ladder(undefined, 'system', true) === want('system', 'setting'))
  check('the pin outranks the setting both ways', ladder('brush', 'system', false) === want('brush', 'pin') && ladder('system', 'brush', false) === want('system', 'pin'))
  check('a pin with another word is no pin: the setting, then the road, decide', ladder('nope', 'brush', false) === want('brush', 'setting') && ladder('nope', undefined, true) === want('brush', 'no-bash'))
  check('each arm has its words', shellEngineArmWords('pin').includes(ENGINE_PIN) && /Shell engine setting/.test(shellEngineArmWords('setting')) && /no bash\.exe/.test(shellEngineArmWords('no-bash')) && shellEngineArmWords('default') === 'the default')
  check('the ladder has no arm of its own for Windows: it takes the pin, the setting and whether a bash stands, and nothing else', shellEngineRequest.length === 3)
  check('the system pin and the system setting keep a bash and never arm the engine', ladder('system', undefined, false) === want('system', 'pin') && ladder(undefined, 'system', false) === want('system', 'setting'))
  check('the no-bash arm says both things it means: no bash.exe was found and the install carries none', /no bash\.exe was found/.test(shellEngineArmWords('no-bash')) && /no bash of its own/.test(shellEngineArmWords('no-bash')))
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
  const probe = 'const d = road.describeWindowsShellRoad(); console.log(JSON.stringify({ active: road.windowsShellRoadActive(), kind: road.windowsBashRoad().kind, bash: road.bashToolAvailable(), ps: utils.isPowerShellToolEnabled(), notice: road.windowsShellRoadNotice(), line: d.line, fix: d.fix ?? null }))'
  type Roster = { active: boolean; kind: string; bash: boolean; ps: boolean; notice: string | null; line: string; fix: string | null }
  const roster = (env: Record<string, string | undefined>): { r: Roster | null; err: string } => {
    const run = roadSubprocess(probe, env)
    return { r: run.status === 0 ? (JSON.parse(run.stdout) as Roster) : null, err: run.stderr.slice(0, 200) }
  }

  const noBash = roster({ [SEAM]: 'no-bash' })
  check('the seam walks the road', noBash.r !== null, noBash.err)
  const nb = noBash.r
  if (PACK_PRESENT) {
    check('on the road without bash, with the pack: the bundled engine arms itself — kind engine', nb?.active === true && nb.kind === 'engine', JSON.stringify(nb))
    check('…the Bash tool stands with no Git at all', nb?.bash === true)
    check('…PowerShell keeps its opt-in, and there is no notice', nb?.ps === false && nb?.notice === null)
    check("…and /health's line names the bundled engine and why", /bundled shell engine at .*brush/.test(nb?.line ?? '') && /no bash\.exe was found/.test(nb?.line ?? ''), nb?.line)
  } else {
    check('on the road without bash, with no pack: the Bash tool is OFF the roster', nb?.active === true && nb.kind === 'absent' && nb.bash === false, JSON.stringify(nb))
    check('…and the PowerShell tool is ON it without the opt-in', nb?.ps === true)
    check('…and the boot notice is the one line', nb?.notice === WINDOWS_BASH_NOTICE)
    check("…and /health's line says the engine is unavailable, its fix naming the pack", /shell engine is unavailable/.test(nb?.line ?? '') && nb?.fix === WINDOWS_BASH_NOTICE_NO_PACK, nb?.line)
  }

  const forcedOff = roster({ [SEAM]: 'no-bash', [ENGINE_PIN]: 'system' })
  const fo = forcedOff.r
  check('forced off (MERCURY_SHELL_ENGINE=system) on the road without bash: the Bash tool is OFF the roster', fo?.active === true && fo.kind === 'absent' && fo.bash === false, JSON.stringify(fo) || forcedOff.err)
  check('…the PowerShell tool is ON it without the opt-in', fo?.ps === true)
  check('…the boot notice is the one line, and the fix is the notice', fo?.notice === WINDOWS_BASH_NOTICE && fo?.fix === WINDOWS_BASH_NOTICE)
  check("…and /health's line says the engine is turned off by the pin", /turned off/.test(fo?.line ?? '') && (fo?.line ?? '').includes(ENGINE_PIN) && /Bash tool is absent/.test(fo?.line ?? '') && /PowerShell tool is present/.test(fo?.line ?? ''), fo?.line)

  const withBash = roster({ [SEAM]: 'locate', [PIN]: import.meta.path })
  const wb = withBash.r
  check('on the road WITH a bash, whatever packs stand: the found bash is the road and nothing arms the engine — the Bash tool stands, PowerShell keeps its opt-in, no notice', wb?.active === true && wb.kind === 'git-bash' && wb.bash === true && wb.ps === false && wb.notice === null, JSON.stringify(wb) || withBash.err)
  check("…and /health's line names that bash and who named it", /bash at .*named by MERCURY_GIT_BASH_PATH/.test(wb?.line ?? ''), wb?.line)
  const withPack = roster({ [SEAM]: 'pack' })
  const wp = withPack.r
  if (SHIPPED_BASH === null) {
    console.log('  [SKIP] this checkout holds no bash pack for this host (bun run scripts/vendor/build-bash.ts): the shipped road is read where the pack is')
  } else {
    check('on the road with no bash installed and the pack present: the shipped bash is the road — the Bash tool stands, PowerShell keeps its opt-in, no notice', wp?.active === true && wp.kind === 'shipped' && wp.bash === true && wp.ps === false && wp.notice === null, JSON.stringify(wp) || withPack.err)
    check("…and /health's line names the bash Mercury ships, at its path", (wp?.line ?? '').includes(SHIPPED_BASH) && /the bash Mercury ships/.test(wp?.line ?? ''), wp?.line)
  }
  const withBashKept = roster({ [SEAM]: 'locate', [PIN]: import.meta.path, [ENGINE_PIN]: 'system' })
  const wk = withBashKept.r
  check('on the road WITH a bash, MERCURY_SHELL_ENGINE=system keeps bash.exe whatever the pack: git-bash is the road, no notice', wk?.active === true && wk.kind === 'git-bash' && wk.bash === true && wk.ps === false && wk.notice === null, JSON.stringify(wk) || withBashKept.err)
  check("…and /health's line names that bash and who named it", /bash at .*named by MERCURY_GIT_BASH_PATH/.test(wk?.line ?? ''), wk?.line)
  const withBashOptIn = roster({ [SEAM]: 'locate', [PIN]: import.meta.path, MERCURY_USE_POWERSHELL_TOOL: '1' })
  check('…and the opt-in still turns PowerShell on beside Bash', withBashOptIn.r?.bash === true && withBashOptIn.r?.ps === true)

  const pinnedProbe = "const engine = await import('" + join(ROOT, 'src/utils/shell/engineSession.ts').replace(/\\/g, '\\\\') + "'); const r = engine.resolveShellEngine(); console.log(JSON.stringify({ armed: r.engine, arm: r.arm, kind: road.windowsBashRoad().kind, bash: road.bashToolAvailable(), ps: utils.isPowerShellToolEnabled(), notice: road.windowsShellRoadNotice(), line: road.describeWindowsShellRoad().line }))"
  type Armed = { armed: string; arm: string; kind: string; bash: boolean; ps: boolean; notice: string | null; line: string }
  const unarmed = roadSubprocess(pinnedProbe, { [SEAM]: 'locate', [PIN]: import.meta.path })
  const un = unarmed.status === 0 ? (JSON.parse(unarmed.stdout) as Armed) : null
  check('the engine owner walks the one ladder with what the road says: a bash found and nothing set, the system shell by default', un?.armed === 'system' && un.arm === 'default' && un.kind === 'git-bash', JSON.stringify(un) || unarmed.stderr.slice(0, 200))
  const pinned = roadSubprocess(pinnedProbe, { [SEAM]: 'locate', [PIN]: import.meta.path, [ENGINE_PIN]: 'brush' })
  const pn = pinned.status === 0 ? (JSON.parse(pinned.stdout) as Armed) : null
  check('the brush pin leg walks the road', pn !== null, pinned.stderr.slice(0, 200))
  if (pn !== null && pn.armed !== 'brush') {
    console.log('  [SKIP] no shell engine pack resolves on this host (bun run scripts/vendor/fetch-brush.ts, or the Windows build) — the pinned arm is proven where the pack is')
  } else {
    check('the brush pin arms the engine over a found bash: kind engine, arm pin', pn?.kind === 'engine' && pn?.arm === 'pin', JSON.stringify(pn))
    check('…the Bash tool stands, PowerShell keeps its opt-in, no notice', pn?.bash === true && pn?.ps === false && pn?.notice === null)
    check("…and /health's line names the engine and the pin", /shell engine at .*brush/.test(pn?.line ?? '') && (pn?.line ?? '').includes(ENGINE_PIN), pn?.line)
  }

  const offRoad = roster({})
  const off = offRoad.r
  const hostIsWindows = process.platform === 'win32'
  check(
    hostIsWindows ? 'this host IS the road: a bash was located (the roster stands)' : 'off the road (this host): the Bash tool stands, PowerShell is off, no notice',
    hostIsWindows ? off?.active === true : off?.active === false && off.bash === true && off.ps === false && off.notice === null,
    offRoad.err,
  )
}

console.log('── §4 a bash-lane hook follows the road ──')
{
  const probeHook = "try { console.log('RETURNED ' + await road.hookBashShell('echo hi')) } catch (e) { console.log('THREW ' + (e instanceof Error ? e.message : String(e))) }\nprocess.exit(0)"
  const hook = roadSubprocess(probeHook, { [SEAM]: 'no-bash' })
  if (PACK_PRESENT) {
    check('with the pack, a hook on the road without bash spawns under the bundled engine', hook.status === 0 && /^RETURNED .*brush/.test(hook.stdout), hook.stdout.slice(0, 160) || hook.stderr.slice(0, 200))
  } else {
    check('with no pack, the hook lane throws (never exits) on the road without bash, naming the command and the remedy', hook.status === 0 && hook.stdout.startsWith('THREW ') && hook.stdout.includes('Hook "echo hi"') && hook.stdout.includes(GIT_BASH_REMEDY), hook.stdout.slice(0, 160) || hook.stderr.slice(0, 200))
  }
  const forced = roadSubprocess(probeHook, { [SEAM]: 'no-bash', [ENGINE_PIN]: 'system' })
  check('forced off, the hook lane throws (never exits) on the road without bash', forced.status === 0 && forced.stdout.startsWith('THREW '), forced.stdout.slice(0, 120) || forced.stderr.slice(0, 200))
  check('…naming the hook command and the remedy', forced.stdout.includes('Hook "echo hi"') && forced.stdout.includes(GIT_BASH_REMEDY))
  if (REAL_BASH === null) {
    console.log('  [SKIP] this host has no /bin/bash to stand in for a found bash: the hook legs with a bash are read where one is')
  } else {
    const hookWithBash = roadSubprocess(probeHook, { [SEAM]: 'locate', [PIN]: REAL_BASH })
    check('with a bash found the hook spawns under it, whatever packs stand: nothing arms the engine', hookWithBash.status === 0 && hookWithBash.stdout === `RETURNED ${REAL_BASH}`, hookWithBash.stdout.slice(0, 160) || hookWithBash.stderr.slice(0, 200))
    const hookWithBashKept = roadSubprocess(probeHook, { [SEAM]: 'locate', [PIN]: REAL_BASH, [ENGINE_PIN]: 'system' })
    check('with a bash and the engine kept off the hook spawns under bash.exe', hookWithBashKept.status === 0 && hookWithBashKept.stdout === `RETURNED ${REAL_BASH}`, hookWithBashKept.stdout.slice(0, 160) || hookWithBashKept.stderr.slice(0, 200))
  }
  if (SHIPPED_BASH !== null) {
    const hookOnPack = roadSubprocess(probeHook, { [SEAM]: 'pack' })
    check('with no bash installed the hook spawns under the bash Mercury ships', hookOnPack.status === 0 && hookOnPack.stdout === `RETURNED ${SHIPPED_BASH}`, hookOnPack.stdout.slice(0, 160) || hookOnPack.stderr.slice(0, 200))
    const hookNotBash = roadSubprocess(probeHook, { [SEAM]: 'locate', [PIN]: import.meta.path })
    check('a pinned program that does not answer as a bash is not what a hook spawns under: the shipped bash is', hookNotBash.status === 0 && hookNotBash.stdout === `RETURNED ${SHIPPED_BASH}`, hookNotBash.stdout.slice(0, 160) || hookNotBash.stderr.slice(0, 200))
  }
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
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_OPERATOR: 'sam',
      [SEAM]: undefined,
      [PIN]: undefined,
      [ENGINE_PIN]: undefined,
      MERCURY_USE_POWERSHELL_TOOL: undefined,
    }
    const health = (extra: Record<string, string>) =>
      spawnSync('node', [bundle, 'health', '--json'], { encoding: 'utf8', env: { ...hermetic, ...extra }, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
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
    const checkOf = (c: Cert | null, id: string): Check | undefined => c?.sections?.flatMap(s => s.checks).find(x => x.id === id)
    const shellCheck = (c: Cert | null): Check | undefined => checkOf(c, 'shell')
    const shellRow = (c: Cert | null): Row | undefined => c?.readiness?.find(r => r.id === 'tool:shell')

    const faults = (c: Cert | null): string[] => c?.sections?.flatMap(s => s.checks).filter(x => x.status === 'fail').map(x => x.id) ?? []

    const control = health({})
    const controlCert = parse(control.stdout)
    check('control: health --json produced a certificate', controlCert !== null && typeof controlCert.verdict === 'string', `status ${control.status}; ${control.stderr.slice(0, 200)}`)
    console.log(`  (control: verdict ${controlCert?.verdict ?? '?'}, exit ${control.status}; failing checks on this host: ${faults(controlCert).join(', ') || 'none'} — the seam runs must match them exactly)`)
    const controlShell = shellCheck(controlCert)
    check('control: the shell check is ok on this host, or warns that this build carries no bash pack and names the command that makes it', controlShell?.status === 'ok' || (controlShell?.status === 'warn' && /scripts\/vendor\/build-bash\.ts/.test(`${controlShell.evidence} ${controlShell.fix ?? ''}`)), JSON.stringify(controlShell)?.slice(0, 300))

    const seamRun = health({ [SEAM]: 'no-bash' })
    const seamCert = parse(seamRun.stdout)
    check('seam: the bundle BOOTS and produces a certificate with bash.exe absent', seamCert !== null && typeof seamCert.verdict === 'string', `status ${seamRun.status}; ${seamRun.stderr.slice(0, 200)}`)
    check('seam: the exit code equals the control run\'s (the road never worsens the verdict)', seamRun.status === control.status, `seam ${seamRun.status} vs control ${control.status}`)
    check('seam: the failing checks are exactly the control run\'s (the road adds no fault)', JSON.stringify(faults(seamCert)) === JSON.stringify(faults(controlCert)), `seam [${faults(seamCert).join(', ')}] vs control [${faults(controlCert).join(', ')}]`)
    const seamShell = shellCheck(seamCert)
    const seamRow = shellRow(seamCert)
    if (PACK_PRESENT) {
      check('seam: the shell check warns, as it does wherever the last road is the one that serves — the bundled engine armed itself', seamShell?.status === 'warn', JSON.stringify(seamShell)?.slice(0, 240))
      check('seam: its evidence names the bundled engine and why', /bundled shell engine at .*brush/.test(seamShell?.evidence ?? '') && /no bash\.exe was found/.test(seamShell?.evidence ?? ''), seamShell?.evidence)
      check('seam: the tool:shell readiness row reads ready on the bundled engine', seamRow?.state === 'ready' && /bundled shell engine/.test(seamRow.detail), JSON.stringify(seamRow)?.slice(0, 240))
      const engineCheck = checkOf(seamCert, 'iface-shell-engine')
      check('seam: the Shell engine row says brush armed itself because no bash.exe was found', engineCheck?.status === 'ok' && /armed by itself/.test(engineCheck.evidence) && /no bash\.exe was found/.test(engineCheck.evidence), JSON.stringify(engineCheck)?.slice(0, 240))
    } else {
      check('seam: the shell check WARNS (a warning, never a fault)', seamShell?.status === 'warn', JSON.stringify(seamShell)?.slice(0, 240))
      check('seam: its evidence says the Bash tool is absent and PowerShell present', /Bash tool is absent/.test(seamShell?.evidence ?? '') && /PowerShell tool is present/.test(seamShell?.evidence ?? ''))
      check('seam: its fix names the pack', seamShell?.fix === WINDOWS_BASH_NOTICE_NO_PACK)
      check('seam: the tool:shell readiness row reads unavailable with the remedy', seamRow?.state === 'unavailable' && seamRow.remedy === WINDOWS_BASH_NOTICE_NO_PACK, JSON.stringify(seamRow)?.slice(0, 240))
    }

    const packRun = health({ [SEAM]: 'pack' })
    const packCert = parse(packRun.stdout)
    const packShell = shellCheck(packCert)
    const packRow = shellRow(packCert)
    check('seam pack: the bundle boots with no bash installed, and the exit code and the failing checks are the control run\'s', packCert !== null && packRun.status === control.status && JSON.stringify(faults(packCert)) === JSON.stringify(faults(controlCert)), `status ${packRun.status}; ${packRun.stderr.slice(0, 200)}`)
    if (controlShell?.status === 'ok') {
      check('seam pack: the shell check is ok and its evidence names the bash Mercury ships with its version', packShell?.status === 'ok' && /^bash 5\.\d+\.\d+.* — the bash Mercury ships/.test(packShell.evidence), JSON.stringify(packShell)?.slice(0, 300))
      check('seam pack: the tool:shell readiness row reads ready', packRow?.state === 'ready' && /the bash Mercury ships/.test(packRow.detail), JSON.stringify(packRow)?.slice(0, 240))
    } else {
      console.log('  [SKIP] this build carries no bash pack: the shipped road\'s rows are read on a build that has it')
    }

    const forcedRun = health({ [SEAM]: 'no-bash', [ENGINE_PIN]: 'system' })
    const forcedCert = parse(forcedRun.stdout)
    check('forced off: the bundle BOOTS with bash.exe absent and the engine turned off', forcedCert !== null && typeof forcedCert.verdict === 'string', `status ${forcedRun.status}; ${forcedRun.stderr.slice(0, 200)}`)
    check('forced off: the exit code equals the control run\'s', forcedRun.status === control.status, `forced ${forcedRun.status} vs control ${control.status}`)
    check('forced off: the failing checks are exactly the control run\'s', JSON.stringify(faults(forcedCert)) === JSON.stringify(faults(controlCert)), `forced [${faults(forcedCert).join(', ')}] vs control [${faults(controlCert).join(', ')}]`)
    const forcedShell = shellCheck(forcedCert)
    const forcedEvidence = forcedShell?.evidence ?? ''
    check('forced off: the shell check WARNS (a warning, never a fault)', forcedShell?.status === 'warn', JSON.stringify(forcedShell)?.slice(0, 240))
    check('forced off: its evidence says the Bash tool is absent and PowerShell present, the engine turned off by the pin', /Bash tool is absent/.test(forcedEvidence) && /PowerShell tool is present/.test(forcedEvidence) && /turned off/.test(forcedEvidence) && forcedEvidence.includes(ENGINE_PIN), forcedEvidence)
    check('forced off: its fix is the notice', forcedShell?.fix === WINDOWS_BASH_NOTICE)
    const forcedRow = shellRow(forcedCert)
    check('forced off: the tool:shell readiness row reads unavailable with the remedy', forcedRow?.state === 'unavailable' && forcedRow.remedy === WINDOWS_BASH_NOTICE, JSON.stringify(forcedRow)?.slice(0, 240))
    const controlRow = shellRow(controlCert)
    check('control: the tool:shell row is a probed or configured shell', controlRow !== undefined && (controlRow.state === 'ready' || controlRow.state === 'configured'), JSON.stringify(controlRow)?.slice(0, 200))

    const nowhere = join(home, 'nowhere', 'bash.exe')
    const pin = health({ [SEAM]: 'locate', [PIN]: nowhere })
    check('the pin-that-points-nowhere arm exits 1 on /health route (the boot step runs for every verb)', pin.status === 1, `status ${pin.status}`)
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
  const init = read('src/entrypoints/init.ts')
  check('the boot step arms the road', init.includes('armWindowsShellRoad()') && !init.includes('setShellIfWindows'))
  const readiness = read('src/utils/readiness.ts')
  check('the readiness row exists', readiness.includes("id: 'tool:shell'") && readiness.includes('describeWindowsShellRoad()'))
  const { runtimeChecks } = await import('../../src/utils/health/sections/runtime.ts')
  const { interfaceChecks } = await import('../../src/utils/health/sections/interface.ts')
  const shellRow = await runtimeChecks().find(row => row.id === 'shell')?.run()
  const roadNow = (await import('../../src/utils/shell/windowsShellRoad.ts')).describeWindowsShellRoad()
  check('the certificate check exists and says what the road says', shellRow !== undefined && shellRow.evidence.startsWith(roadNow.line) && (shellRow.status === 'ok' || shellRow.status === 'warn'), JSON.stringify(shellRow))
  const engineSession = await import('../../src/utils/shell/engineSession.ts')
  const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
  const resolvedEngine = engineSession.resolveShellEngine(getInitialSettings().shell?.engine)
  const engineRow = await interfaceChecks().find(row => row.id === 'iface-shell-engine')?.run()
  check('the Shell engine row resolves from the setting as written, so an unset setting lets the road arm', engineRow !== undefined && (resolvedEngine.engine === 'brush' ? engineRow.evidence.startsWith(`brush ${resolvedEngine.version}`) : resolvedEngine.requested === 'brush' ? engineRow.evidence === resolvedEngine.reason : engineRow.evidence.includes(shellEngineArmWords(resolvedEngine.arm))), JSON.stringify(engineRow))
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  check('the seam is registered, and its words name the three values it takes', FLAG_REGISTRY.some(s => s.env === SEAM && ['`no-bash`', '`pack`', '`locate`'].every(value => s.summary.includes(value))))
}

rmSync(SUB_HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ WINDOWS SHELL ROAD PROOF PASS' : `\n❌ WINDOWS SHELL ROAD PROOF RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
