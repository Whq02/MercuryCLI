#!/usr/bin/env bun
// ============================================================================
//  prove-crash-report-identity — a crash report is SELF-SUFFICIENT (B20):
//  identity fields ride every record, the failing component's display name
//  is recorded (the app-root #300 hunt needed it and the report held only
//  raw stacks), and the archive is no longer write-only — doctor summarizes
//  it and the next interactive boot says one word.
//
//    §1 identity: version · platform · component · origin ride the record
//       (sessionId/surface answer honestly-absent in this headless world).
//    §2 failingComponentOf: the componentStack's top frame, both spellings;
//       garbage answers null.
//    §3 the readers: newest-first, capped, and an unreadable record still
//       APPEARS (the archive must never look empty because one file rotted).
//    §4 the boot-notice latch: unnoticed → mark → none; a NEW report after
//       the mark is exactly the unnoticed set.
//    §5 the wiring, structural: the app-root boundary hands errorInfo in;
//       the REPL boot effect speaks once through the channel; doctor's
//       RUNTIME section carries the crash-reports row.
//
//  Hermetic: MERCURY_CONFIG_DIR on a scratch home.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'crash-identity-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9-proof' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const crash = await import('../../src/utils/crashReport.ts')

section('§1 identity fields ride every record')
{
  const stack = 'at BrokenCard (src/components/BrokenCard.tsx:12:3)\nat Messages (src/components/Messages.tsx:1:1)'
  crash.persistCrashReport(new Error('the fixture detonation'), { componentStack: stack }, 'app-root')
  const path = crash.lastCrashReportPath()
  check('the report landed and latched', path !== null)
  const record = JSON.parse(readFileSync(path!, 'utf8')) as Record<string, unknown>
  check('version rides the record', record.version === '9.9.9-proof', String(record.version))
  check('platform names os · arch · node', typeof record.platform === 'string' && (record.platform as string).includes(process.platform) && (record.platform as string).includes(process.arch) && (record.platform as string).includes(process.versions.node), String(record.platform))
  check("the failing component's display name is recorded", record.component === 'BrokenCard', String(record.component))
  check('origin and timestamps stand as before', record.origin === 'app-root' && typeof record.at === 'string')
  check('sessionId/surface answer (string or honest null — this headless world has neither owner booted)', 'sessionId' in record && 'surface' in record)
}

section('§2 failingComponentOf — both stack spellings, garbage null')
{
  check("the 'at Name (file)' spelling parses", crash.failingComponentOf('at TopCard (x.tsx:1:1)\nat Under (y.tsx:2:2)') === 'TopCard')
  check("the 'in Name' spelling parses", crash.failingComponentOf('in FrameHost\nin App') === 'FrameHost')
  check('leading whitespace is tolerated', crash.failingComponentOf('    at PaddedCard (z.tsx:9:9)') === 'PaddedCard')
  check('garbage answers null', crash.failingComponentOf('completely unshaped words') === null)
  check('absence answers null', crash.failingComponentOf(null) === null && crash.failingComponentOf(undefined) === null)
}

section('§3 the readers — newest-first, capped, rot-tolerant')
{
  crash.persistCrashReport(new Error('second fixture'), { componentStack: 'at SecondCard (s.tsx:1:1)' }, 'surface')
  const reports = crash.listCrashReports()
  check('newest first', reports.length >= 2 && reports[0]!.message === 'second fixture', JSON.stringify(reports.map(r => r.message)))
  check('component summarized per record', reports[0]!.component === 'SecondCard')
  const rotten = join(crash.crashReportDir(), `crash-${Date.now() + 1}-boot.json`)
  writeFileSync(rotten, '{not json')
  const withRot = crash.listCrashReports()
  check('an unreadable record still APPEARS, named honestly', withRot.some(r => r.message === '(unreadable report)'), JSON.stringify(withRot.map(r => r.message)))
  check('the cap holds', crash.listCrashReports(1).length === 1)
}

section('§4 the boot-notice latch')
{
  const before = crash.unnoticedCrashReports()
  check('everything is unnoticed before the first mark', before.length >= 3, String(before.length))
  crash.markCrashReportsNoticed()
  check('the mark latches — nothing unnoticed', crash.unnoticedCrashReports().length === 0)
  // Latch precision needs the new report's mtime past the marker's.
  await new Promise(resolve => setTimeout(resolve, 20))
  crash.persistCrashReport(new Error('after the mark'), undefined, 'unhandled-rejection')
  const fresh = crash.unnoticedCrashReports()
  check('a NEW report is exactly the unnoticed set', fresh.length === 1 && fresh[0]!.message === 'after the mark', JSON.stringify(fresh.map(r => r.message)))
}

section('§5 the wiring (structural)')
{
  const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8')
  const appRoot = src('ink/components/App.tsx')
  check('the app-root boundary hands errorInfo in (the component name derives from it)', appRoot.includes("persistCrashReport(error, errorInfo, 'app-root')"))
  const repl = src('screens/REPL.tsx')
  check('the REPL boot effect speaks once through the channel', repl.includes('unnoticedCrashReports()') && repl.includes('markCrashReportsNoticed()') && repl.includes("key: 'crash-reports'"))
  const doctor = src('utils/healthReport.ts')
  check("doctor's RUNTIME section carries the crash-reports row", doctor.includes("id: 'crash-reports'") && doctor.includes('listCrashReports(3)'))
}

section('§6 session + project ride the read boundary (FN-013 CRASH-03)')
{
  // The write half in THIS headless world: sessionId is honestly absent,
  // but the project identity resolves — the record must carry cwd.
  crash.persistCrashReport(new Error('locatable fixture'), { componentStack: 'at LostCard (l.tsx:1:1)' }, 'surface')
  const record = JSON.parse(readFileSync(crash.lastCrashReportPath()!, 'utf8')) as Record<string, unknown>
  check('the record carries the working directory', typeof record.cwd === 'string' && (record.cwd as string).length > 0, String(record.cwd))
  const summarized = crash.listCrashReports().find(r => r.message === 'locatable fixture')
  check('the summary returns the cwd (identity no longer dropped at the read boundary)', summarized !== undefined && summarized.cwd === record.cwd, JSON.stringify(summarized))

  // The full round trip, session included: a report written by session S in
  // project P returns S and P from listCrashReports().
  const full = join(crash.crashReportDir(), `crash-${Date.now() + 50}-app-root.json`)
  writeFileSync(
    full,
    JSON.stringify({
      origin: 'app-root',
      at: '2026-09-01T05:00:00.000Z',
      message: 'session-stamped fixture',
      component: 'StampedCard',
      sessionId: '00000000-cccc-dddd-eeee-000000000c03',
      cwd: '/tmp/project-p',
    }),
  )
  const round = crash.listCrashReports().find(r => r.message === 'session-stamped fixture')
  check(
    'a report written by session S in project P returns S and P',
    round !== undefined && round.sessionId === '00000000-cccc-dddd-eeee-000000000c03' && round.cwd === '/tmp/project-p',
    JSON.stringify(round),
  )

  // The legacy arm: a record predating the fields lists with them absent
  // and no throw.
  const legacy = join(crash.crashReportDir(), `crash-${Date.now() + 60}-boot.json`)
  writeFileSync(legacy, JSON.stringify({ origin: 'boot', at: '2026-01-01T00:00:00.000Z', message: 'legacy fixture', component: null }))
  const legacyRow = crash.listCrashReports().find(r => r.message === 'legacy fixture')
  check('a legacy record lists with sessionId/cwd null, never a throw', legacyRow !== undefined && legacyRow.sessionId === null && legacyRow.cwd === null, JSON.stringify(legacyRow))
}

section('§7 the re-entry offer and the display latch (structural)')
{
  const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8')
  const repl = src('screens/REPL.tsx')
  check('the boot effect stages the re-entry offer for a resolvable session', repl.includes('setCrashResumeStaged({') && repl.includes('CrashResumeDialog'))
  check('the offer resumes through the ONE resume path', repl.includes('focusResumedSession(staged.sessionId, staged.transcriptPath'))
  check(
    'the notice marker latches BEHIND display, never at stage time',
    repl.includes("focusedInputDialog === 'crash-resume' && !crashNoticeLatchedRef.current"),
  )
  check(
    'a gone transcript keeps the plain notice and says so (no failing action offered)',
    repl.includes('its transcript is gone, so no re-entry is offered'),
  )
  const doctor = src('utils/healthReport.ts')
  check('the /health row locates the crash (session + project)', doctor.includes('newest.sessionId.slice(0, 8)') && doctor.includes('newest.cwd'))
  const dialog = src('components/CrashResumeDialog.tsx')
  check('the dialog offers one-keypress resume and esc dismissal', dialog.includes("value: 'resume'") && dialog.includes("onClose={() => onDone('dismiss')}"))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-crash-report-identity — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-crash-report-identity — all checks pass')
process.exit(0)
