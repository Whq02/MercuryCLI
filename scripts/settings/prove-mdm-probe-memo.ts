#!/usr/bin/env bun
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mdm-probe-memo-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const MDM_MEMO_FIX_HINT = 'fix mdmBootAwaitsRawRead, readMdmProbeMemo, writeMdmProbeMemo and recordMdmProbeOutcome in src/platform/settings/mdm/probeMemo.ts, or the boot barrier ensureMdmSettingsLoaded in src/platform/settings/mdm/settings.ts'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${MDM_MEMO_FIX_HINT}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const memo = await import('../../src/platform/settings/mdm/probeMemo.ts')
const raw = await import('../../src/platform/settings/mdm/rawRead.ts')
const mdm = await import('../../src/platform/settings/mdm/settings.ts')

const scratch = (): string => mkdtempSync(join(tmpdir(), 'mdm-probe-home-'))
const absentRead = { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
const hklmRead = { plistStdouts: null, hklmStdout: '    Settings    REG_SZ    {"permissions":{"deny":["Bash(rm *)"]}}', hkcuStdout: null }
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
  const steady = readFileSync(memo.mdmProbeMemoPath(h), 'utf8')
  const settle = Date.now() + 5
  while (Date.now() < settle) { void settle }
  memo.recordMdmProbeOutcome(hkcuRead, 'win32', h)
  check('win32, the same outcome again leaves the record untouched (a steady-state boot or health run writes nothing under the home)', readFileSync(memo.mdmProbeMemoPath(h), 'utf8') === steady)
}

section('M5 the barrier shape — the skip arm never waits on the spawns; the await arm (the control) does')
{
  raw._setMdmRawReadForProofs(new Promise<never>(() => {}))
  mdm.clearMdmSettingsCache()
  const hAbsent = scratch()
  memo.writeMdmProbeMemo(false, hAbsent)
  const hNone = scratch()
  const barrier = async (awaits: boolean): Promise<'proceeded' | 'waited'> => {
    if (awaits) {
      await mdm.ensureMdmSettingsLoaded().catch(() => {})
      return 'proceeded'
    }
    void mdm.ensureMdmSettingsLoaded().then(() => {}).catch(() => {})
    return 'proceeded'
  }
  const race = (p: Promise<string>): Promise<string> => Promise.race([p, new Promise<string>(resolve => setTimeout(() => resolve('waited'), 150))])
  check('win32 + absent memo: the skip arm proceeds at once (0 awaited spawns)', (await race(barrier(memo.mdmBootAwaitsRawRead('win32', hAbsent)))) === 'proceeded')
  check('win32 + no memo (the control): the await arm waits on the read (2 awaited spawns — the cost the row removes)', (await race(barrier(memo.mdmBootAwaitsRawRead('win32', hNone)))) === 'waited')
  console.log('  BEFORE: 2 awaited reg.exe spawns (5 s timeout each) before the settings merge on every win32 boot · AFTER (memo says absent): 0 awaited; the 2 still fire in the background')
}


console.log(failures === 0 ? '\n✅ ALL MDM PROBE-MEMO PROOFS PASS' : `\n❌ ${failures} MDM PROBE-MEMO PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
