#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-mdm-probe-memo.ts — FN-020 row 4: an unmanaged
//  Windows boot no longer awaits four reg.exe spawns before the first paint.
//
//  The class: readWindowsRegistry spawns `reg query` four times (Mercury +
//  legacy key, HKLM + HKCU, 5 s timeout each) at module evaluation, and the
//  commander preAction awaited the result before the settings merge — on an
//  unmanaged machine four process creations per boot, forever, for an
//  always-empty answer (macOS skips spawning when no plist exists; the
//  registry has no spawn-free probe). The memo IS the probe: the last
//  completed read's outcome persists in the config home; "absent" lets the
//  barrier proceed while the read still fires in the background.
//
//    M1  no record ⇒ the barrier awaits, on every platform (byte-for-byte)
//    M2  a record saying absent ⇒ win32 skips the await; darwin and linux
//        never consult the memo
//    M3  present, malformed, partial, torn ⇒ awaits (a speed hint, never a
//        policy input)
//    M4  the completed read writes the record — win32 only; a value in
//        either hive records present (the skip clears for the next boot)
//    M5  the barrier shape, operation-shaped: with a raw read that never
//        resolves, the skip arm completes at once (0 awaited spawns) while
//        the await arm — the control — waits on it (4 awaited spawns)
//    M6  wiring — main.tsx branches on the predicate from the tier module,
//        the await arm is the pre-row text, the skip arm fires the load
//        un-awaited and applies a landed value the way the MDM poll does
//        (notifyChange 'policySettings'; an empty outcome changes nothing),
//        the load records the outcome, and the four spawns still fire at
//        module evaluation
// ============================================================================
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mdm-probe-memo-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const memo = await import('../../src/utils/settings/mdm/probeMemo.ts')
const raw = await import('../../src/utils/settings/mdm/rawRead.ts')
const mdm = await import('../../src/utils/settings/mdm/settings.ts')

const scratch = (): string => mkdtempSync(join(tmpdir(), 'mdm-probe-home-'))
const absentRead = { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
const hklmRead = { plistStdouts: null, hklmStdout: '    Settings    REG_SZ    {"permissions":{"deny":["Bash(rm:*)"]}}', hkcuStdout: null }
const hkcuRead = { plistStdouts: null, hklmStdout: null, hkcuStdout: '    Settings    REG_SZ    {}' }

section('M1 no record ⇒ the barrier awaits, on every platform')
{
  const h = scratch()
  for (const platform of ['win32', 'darwin', 'linux']) {
    check(`${platform}: no record ⇒ awaits`, memo.mdmBootAwaitsRawRead(platform, h) === true)
  }
  check('the predicate defaults to this process platform and the config home (no record here ⇒ awaits)', memo.mdmBootAwaitsRawRead() === true)
}

section('M2 a record saying absent ⇒ win32 skips; darwin and linux never consult the memo')
{
  const h = scratch()
  memo.writeMdmProbeMemo(false, h)
  check('the record lands in the config home as schema 1', memo.readMdmProbeMemo(h)?.schema === 1 && memo.readMdmProbeMemo(h)?.present === false)
  check('win32: absent ⇒ the barrier does NOT await', memo.mdmBootAwaitsRawRead('win32', h) === false)
  check('darwin: the memo is not consulted (awaits)', memo.mdmBootAwaitsRawRead('darwin', h) === true)
  check('linux: the memo is not consulted (awaits)', memo.mdmBootAwaitsRawRead('linux', h) === true)
}

section('M3 present, malformed, partial, torn ⇒ awaits')
{
  const h = scratch()
  memo.writeMdmProbeMemo(true, h)
  check('present ⇒ awaits (today\'s boot, byte-for-byte)', memo.mdmBootAwaitsRawRead('win32', h) === true)
  writeFileSync(memo.mdmProbeMemoPath(h), '{"schema":1,"present":"no","checkedAt":1}\n')
  check('a non-boolean present ⇒ awaits', memo.mdmBootAwaitsRawRead('win32', h) === true && memo.readMdmProbeMemo(h) === null)
  writeFileSync(memo.mdmProbeMemoPath(h), '{"schema":2,"present":false,"checkedAt":1}\n')
  check('an unknown schema ⇒ awaits', memo.mdmBootAwaitsRawRead('win32', h) === true)
  writeFileSync(memo.mdmProbeMemoPath(h), '{"schema":1,"present":false}\n')
  check('a partial record (no checkedAt) ⇒ awaits', memo.mdmBootAwaitsRawRead('win32', h) === true)
  writeFileSync(memo.mdmProbeMemoPath(h), '{"schema":1,"present":fal')
  check('a torn record ⇒ awaits', memo.mdmBootAwaitsRawRead('win32', h) === true)
}

section('M4 the completed read writes the record — win32 only; either hive counts as present')
{
  const h = scratch()
  memo.recordMdmProbeOutcome(absentRead, 'darwin', h)
  check('darwin: nothing is written', !existsSync(memo.mdmProbeMemoPath(h)))
  memo.recordMdmProbeOutcome(absentRead, 'linux', h)
  check('linux: nothing is written', !existsSync(memo.mdmProbeMemoPath(h)))
  memo.recordMdmProbeOutcome(absentRead, 'win32', h)
  check('win32, both hives empty ⇒ absent recorded (the next boot skips the await)', memo.readMdmProbeMemo(h)?.present === false && memo.mdmBootAwaitsRawRead('win32', h) === false)
  memo.recordMdmProbeOutcome(hklmRead, 'win32', h)
  check('win32, an HKLM value ⇒ present recorded (the skip clears; the next boot awaits)', memo.readMdmProbeMemo(h)?.present === true && memo.mdmBootAwaitsRawRead('win32', h) === true)
  memo.recordMdmProbeOutcome(absentRead, 'win32', h)
  memo.recordMdmProbeOutcome(hkcuRead, 'win32', h)
  check('win32, an HKCU value (even an empty payload) ⇒ present (conservative: a successful reg exit is a value)', memo.readMdmProbeMemo(h)?.present === true)
  const t0 = memo.readMdmProbeMemo(h)?.checkedAt ?? 0
  check('checkedAt is a recent timestamp', Math.abs(Date.now() - t0) < 60_000)
}

section('M5 the barrier shape — the skip arm never waits on the spawns; the await arm (the control) does')
{
  // The startup raw read stood in by a promise that NEVER resolves: exactly
  // what four reg.exe spawns look like to the barrier until they answer.
  raw._setMdmRawReadForProofs(new Promise<never>(() => {}))
  mdm.clearMdmSettingsCache()
  const hAbsent = scratch()
  memo.writeMdmProbeMemo(false, hAbsent)
  const hNone = scratch()
  const barrier = async (awaits: boolean): Promise<'proceeded' | 'waited'> => {
    // The two arms exactly as main.tsx spells them.
    if (awaits) {
      await mdm.ensureMdmSettingsLoaded().catch(() => {})
      return 'proceeded'
    }
    void mdm.ensureMdmSettingsLoaded().then(() => {}).catch(() => {})
    return 'proceeded'
  }
  const race = (p: Promise<string>): Promise<string> => Promise.race([p, new Promise<string>(resolve => setTimeout(() => resolve('waited'), 150))])
  check('win32 + absent memo: the skip arm proceeds at once (0 awaited spawns)', (await race(barrier(memo.mdmBootAwaitsRawRead('win32', hAbsent)))) === 'proceeded')
  check('win32 + no memo (the control): the await arm waits on the read (4 awaited spawns — the cost the row removes)', (await race(barrier(memo.mdmBootAwaitsRawRead('win32', hNone)))) === 'waited')
  console.log('  BEFORE: 4 awaited reg.exe spawns (5 s timeout each) before the settings merge on every win32 boot · AFTER (memo says absent): 0 awaited; the 4 still fire in the background')
}

section('M6 wiring')
{
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  // Anchored on the tier import itself: main.tsx registers TWO preAction
  // hooks and the MDM barrier lives under the second, well past a slice
  // taken from the first.
  const at = main.indexOf('const { ensureMdmSettingsLoaded, mdmBootAwaitsRawRead')
  const hook = at >= 0 ? main.slice(Math.max(0, at - 400), at + 3000) : ''
  check('the barrier sits inside a preAction hook', at >= 0 && main.lastIndexOf("program.hook('preAction'", at) >= 0)
  check('preAction branches on the predicate from the tier module (one dynamic import; the detector import is the standing static one)', /const \{ ensureMdmSettingsLoaded, mdmBootAwaitsRawRead, getMdmSettings, getHkcuSettings \} = await import\('\.\/utils\/settings\/mdm\/settings\.js'\)\n\s*if \(mdmBootAwaitsRawRead\(\)\) \{/.test(hook) && main.includes("import { settingsChangeDetector } from './utils/settings/changeDetector.js'"))
  check('the await arm is the pre-row text (ensureMdmSettingsLoaded awaited, failure guarded, never stops the boot)', /if \(mdmBootAwaitsRawRead\(\)\) \{\n\s*await ensureMdmSettingsLoaded\(\)\.catch\(\(error: unknown\) => \{\n\s*logForDebugging\(`MDM settings load failed at boot; no policy tier applies: \$\{String\(error\)\}`, \{ level: 'error' \}\)\n\s*\}\)\n\s*\} else \{/.test(hook))
  check("the skip arm fires the load un-awaited; a value that landed applies the way the MDM poll applies one (notifyChange 'policySettings'), an empty outcome changes nothing", /\} else \{[\s\S]{0,1200}?void ensureMdmSettingsLoaded\(\)\n\s*\.then\(\(\) => \{\n\s*if \(Object\.keys\(getMdmSettings\(\)\.settings\)\.length === 0 && Object\.keys\(getHkcuSettings\(\)\.settings\)\.length === 0\) return\n\s*settingsChangeDetector\.notifyChange\('policySettings'\)\n\s*\}\)\n\s*\.catch\(/.test(hook))
  const settingsSrc = readFileSync(join(ROOT, 'src/utils/settings/mdm/settings.ts'), 'utf8')
  check('the load records the completed read\'s outcome right after filling the tier caches', /hkcuCache = hkcu\n[\s\S]{0,200}?recordMdmProbeOutcome\(raw\)/.test(settingsSrc) && settingsSrc.includes("export { mdmBootAwaitsRawRead } from './probeMemo.js'"))
  const rawSrc = readFileSync(join(ROOT, 'src/utils/settings/mdm/rawRead.ts'), 'utf8')
  const spawns = rawSrc.match(/runSubprocess\('reg', \['query'/g) ?? []
  check('the four registry spawns still fire (the read is unchanged; only the await moved)', spawns.length === 4 && /startMdmRawRead\(\);/.test(main))
  const probeSrc = readFileSync(join(ROOT, 'src/utils/settings/mdm/probeMemo.ts'), 'utf8')
  check('the memo is win32-only at both ends (record and predicate)', (probeSrc.match(/if \(platform !== 'win32'\) return/g) ?? []).length === 2)
}

console.log(failures === 0 ? '\n✅ ALL MDM PROBE-MEMO PROOFS PASS' : `\n❌ ${failures} MDM PROBE-MEMO PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
