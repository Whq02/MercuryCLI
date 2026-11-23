#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'crash-identity-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9-proof' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + 'fix the crash report writer or readers in src/platform/logs/crashReport.ts (persistCrashReport, failingComponentOf, listCrashReports, unnoticedCrashReports, markCrashReportsNoticed); for the health row or resume offer checks, fix the crash-reports row of the health runtime section or the crash-resume dialog it feeds' : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const crash = await import('../../src/platform/logs/crashReport.ts')

section('§1 identity fields ride every record')
{
  const stack = 'at BrokenCard (src/components/BrokenCard.tsx:12:3)\nat Messages (src/screen/messages/Messages.tsx:1:1)'
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
  await new Promise(resolve => setTimeout(resolve, 20))
  crash.persistCrashReport(new Error('after the mark'), undefined, 'unhandled-rejection')
  const fresh = crash.unnoticedCrashReports()
  check('a NEW report is exactly the unnoticed set', fresh.length === 1 && fresh[0]!.message === 'after the mark', JSON.stringify(fresh.map(r => r.message)))
}

section('§5 the wiring (structural)')
{
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const crashOwner = await import('../../src/platform/logs/crashReport.ts')
  const crashSays = await runtimeChecks().find(row => row.id === 'crash-reports')?.run()
  const recent = crashOwner.listCrashReports(3)
  check("health's RUNTIME section carries the crash-reports row", crashSays !== undefined && (recent.length === 0 ? crashSays.status === 'ok' && crashSays.evidence === 'none recorded' : crashSays.status === 'info' && crashSays.evidence.startsWith(`${recent.length} recent · newest: ${recent[0]!.at} ${recent[0]!.origin}`) && crashSays.evidence.endsWith(crashOwner.crashReportDirDisplay())), crashSays?.evidence)
}

section('§6 session + project ride the read boundary (FN-013 CRASH-03)')
{
  crash.persistCrashReport(new Error('locatable fixture'), { componentStack: 'at LostCard (l.tsx:1:1)' }, 'surface')
  const record = JSON.parse(readFileSync(crash.lastCrashReportPath()!, 'utf8')) as Record<string, unknown>
  check('the record carries the working directory', typeof record.cwd === 'string' && (record.cwd as string).length > 0, String(record.cwd))
  const summarized = crash.listCrashReports().find(r => r.message === 'locatable fixture')
  check('the summary returns the cwd (identity no longer dropped at the read boundary)', summarized !== undefined && summarized.cwd === record.cwd, JSON.stringify(summarized))

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

  const legacy = join(crash.crashReportDir(), `crash-${Date.now() + 60}-boot.json`)
  writeFileSync(legacy, JSON.stringify({ origin: 'boot', at: '2026-01-01T00:00:00.000Z', message: 'legacy fixture', component: null }))
  const legacyRow = crash.listCrashReports().find(r => r.message === 'legacy fixture')
  check('a legacy record lists with sessionId/cwd null, never a throw', legacyRow !== undefined && legacyRow.sessionId === null && legacyRow.cwd === null, JSON.stringify(legacyRow))
}

section('§7 the re-entry offer and the display latch (structural)')
{
  const { runtimeChecks: runtimeRows } = await import('../../src/platform/health/sections/runtime.ts')
  writeFileSync(
    join(crash.crashReportDir(), `crash-${Date.now() + 500}-app-root.json`),
    JSON.stringify({ origin: 'app-root', at: '2026-09-02T05:00:00.000Z', message: 'located fixture', component: 'LocatedCard', sessionId: '00000000-cccc-dddd-eeee-000000000c04', cwd: '/tmp/project-q' }),
  )
  const locatedSays = await runtimeRows().find(row => row.id === 'crash-reports')?.run()
  check('the /health row locates the crash (session + project)', locatedSays?.status === 'info' && locatedSays.evidence.includes('newest: 2026-09-02T05:00:00.000Z app-root in LocatedCard — located fixture · session 00000000 in /tmp/project-q · '), locatedSays?.evidence)
  const { openDialogsPart } = await import('../ui/chatScenarios.ts')
  const dialogs = await openDialogsPart('crash-identity-dialogs', { keepHome: true })
  const staged = { origin: 'app-root', component: null, message: 'the staged fixture', sessionId: '00000000-cccc-dddd-eeee-000000000c05', cwd: '/tmp/project-r', transcriptPath: '/tmp/project-r/00000000-cccc-dddd-eeee-000000000c05.jsonl', moreCount: 0 }
  await dialogs.plant({ focusedInputDialog: 'crash-resume', crashResumeStaged: staged })
  const until = async (ready: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 75 && !ready(); turn++) await new Promise(resolve => setTimeout(resolve, 40))
  }
  await until(() => dialogs.frame().includes('Resume that session'))
  const offered = dialogs.frame()
  dialogs.part.view.push('\r')
  await until(() => dialogs.hops.length === 1)
  const hop = dialogs.hops[0] ?? []
  await dialogs.close()
  check('the screen draws the re-entry offer it is handed', offered.includes('previous session crashed') && offered.includes('session 00000000') && offered.includes('Resume that session'), offered)
  check('the offer resumes through the ONE resume path', hop[0] === staged.sessionId && hop[1] === staged.transcriptPath && dialogs.staged[0] === null, JSON.stringify(hop))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-crash-report-identity — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-crash-report-identity — all checks pass')
process.exit(0)
