#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { settingsEditors } from '../../src/screen/boot-face/settings/menuModel.ts'

const root = resolve(import.meta.dir, '..', '..')
const driver = resolveCaptureDriver()
if (!existsSync(join(root, 'dist', 'mercury.mjs'))) throw new Error('Build the product before running the profiles page drive')
if (driver.kind === 'unavailable') throw new Error(driver.reason + ': ' + driver.remedy)
if (driver.kind !== 'posix-pty') {
  console.log('The profiles page drive requires the POSIX capture driver.')
  process.exit(0)
}
const framesDir = process.argv[2]
const fixture = await startFixtureApi([])
const PAGE = 'src/screen/boot-face/BootProfilesScreen.tsx'
const DOWN = '\u001b[B'
let failures = 0
const check = (label: string, ok: boolean, fix: string): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ': ' + fix}`)
}
type Grid = Array<Array<{ c?: string }>>
const textOf = (grid: Grid | undefined): string => (grid ?? []).map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const rowOf = (frame: string, id: number): string | undefined => frame.split('\n').find(line => new RegExp(`^[│❯\\s]*${id} · `).test(line))

const sends = [
  { awaitText: 'New Session', requireAwait: true, awaitSettleTicks: 4, data: 's' },
  { awaitText: 'MCPs & Skills', requireAwait: true, awaitSettleTicks: 4, data: DOWN.repeat(settingsEditors.length - 1) + '\r', mark: 'menu' },
  { awaitText: '1 · Profile 1', requireAwait: true, awaitSettleTicks: 4, data: 'n', mark: 'one' },
  { awaitText: 'Profile 2 created', requireAwait: true, awaitSettleTicks: 4, data: DOWN + 'r', mark: 'two' },
  { awaitText: 'name: ▌', requireAwait: true, awaitSettleTicks: 4, data: 'Work' },
  { awaitText: 'name: Work▌', requireAwait: true, awaitSettleTicks: 4, data: '\r' },
  { awaitText: '2 · Work', requireAwait: true, awaitSettleTicks: 4, data: '\u007f', mark: 'renamed' },
  { awaitText: 'remove Work?', requireAwait: true, awaitSettleTicks: 4, data: 'y', mark: 'confirm' },
]

try {
  for (const cols of [120, 80]) {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), 'profiles-page-home-')))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'profiles-page-project-')))
    const install = stageInstall('source', userHome)
    seedFirstRun(install.home, [cwd])
    const output = join(userHome, 'capture.json')
    const config = join(userHome, 'capture-config.json')
    writeFileSync(config, JSON.stringify({ argv: [install.command], cwd, cols, rows: 40, out: output, total: 600, sends, readyText: 'Work removed' }))
    const env = {
      ...install.env,
      TERM: 'xterm-256color',
      MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()),
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: fixture.url,
    }
    const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
      const child = spawn(driver.python, [captureEngineEntry(driver, root), config], { cwd: root, env })
      let text = ''
      child.stdout.on('data', value => { text += value })
      child.stderr.on('data', value => { text += value })
      const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150000))
      child.on('close', code => { clearTimeout(deadline); resolveRun({ code, text }) })
    })
    spawnSync(install.command, ['daemon', 'stop'], { env, timeout: 10000, stdio: 'pipe' })
    check(`${cols}: the drive ran to its end`, result.code === 0 && existsSync(output), `an awaited text in the sends list of this drive never painted; compare the last awaited text with the output tail and the words in ${PAGE}. ${result.text.trim().slice(-700)}`)
    const capture = (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {}) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
    for (const dir of [userHome, cwd]) removeScratch(dir)
    const marks = new Map([...(capture.marks ?? []).map(mark => [mark.label, textOf(mark.grid)] as const), ['removed', textOf(capture.grid)] as const])
    const frame = (label: string): string => marks.get(label) ?? ''
    if (framesDir !== undefined) {
      mkdirSync(framesDir, { recursive: true })
      for (const [label, text] of marks) writeFileSync(join(framesDir, `${label}-${cols}.txt`), text + '\n')
    }
    check(`${cols}: every key reached its screen`, capture.sendReceipts?.length === sends.length, `only ${String(capture.sendReceipts?.length)} of ${sends.length} sends were delivered; the first send whose awaited text never painted names the screen that stopped`)
    const menu = frame('menu').split('\n')
    const agentsAt = menu.findIndex(line => /Agents\s+↵ open/.test(line))
    check(`${cols}: the Boot Menu shows Profiles (Beta) under Agents`, agentsAt >= 0 && /Profiles \(Beta\)\s+↵ open/.test(menu[agentsAt + 1] ?? ''), `put the profiles row after the agents row of settingsEditors in src/screen/boot-face/settings/menuModel.ts; the editor rows read: ${menu.filter(line => line.includes('↵ open')).map(line => line.trim()).join(' | ')}`)
    check(`${cols}: the page lists Profile 1 alone, marked as this one`, /mercury · this one/.test(rowOf(frame('one'), 1) ?? '') && rowOf(frame('one'), 2) === undefined, `the row of the profile this session runs in must read "1 · Profile 1" with "mercury · this one" (the entries of ${PAGE}); it reads: ${rowOf(frame('one'), 1)?.trim() ?? 'no row'}`)
    check(`${cols}: create adds Profile 2 with mercury2 and says which command starts it`, /Profile 2\s+mercury2/.test(rowOf(frame('two'), 2) ?? '') && frame('two').includes('Profile 2 created — mercury2 starts it'), `n must call createProfile and print its command (the n action of ${PAGE}); the row reads: ${rowOf(frame('two'), 2)?.trim() ?? 'no row'}`)
    check(`${cols}: a rename shows the new name`, /Work\s+mercury2/.test(rowOf(frame('renamed'), 2) ?? ''), `r, a typed name and ↵ must call renameProfile and re-read the list (the rename keys of ${PAGE}); the row reads: ${rowOf(frame('renamed'), 2)?.trim() ?? 'no row'}`)
    check(`${cols}: remove asks first`, frame('confirm').includes('remove Work?') && frame('confirm').includes('y / ↵ remove · n / esc cancel') && rowOf(frame('confirm'), 2) !== undefined, `⌫ on a profile that is neither Profile 1 nor this one must open the confirm and remove nothing yet (the remove keys of ${PAGE})`)
    check(`${cols}: after the remove the list is Profile 1 alone again`, rowOf(frame('removed'), 1) !== undefined && rowOf(frame('removed'), 2) === undefined, `y must await removeProfile and re-read the list (the remove keys of ${PAGE}); row 2 reads: ${rowOf(frame('removed'), 2)?.trim() ?? 'no row'}`)
  }
  check('the page made no model call', fixture.messageRequests().length === 0, `a key of the profiles page reached the model API; the page must stay on the door in src/platform/profiles/profiles.ts`)
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
