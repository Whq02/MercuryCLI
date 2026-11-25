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
const python = driver.python
const engine = captureEngineEntry(driver, root)
const framesDir = process.argv[2]
const fixture = await startFixtureApi([])
const PAGE = 'src/screen/boot-face/BootProfilesScreen.tsx'
const DOWN = '\u001b[B'
const ESC = '\u001b'
const BACKSPACE = '\u007f'
const IN_THE_LIST = 'r rename · ⌫ remove · esc back'
let failures = 0
const check = (label: string, ok: boolean, fix: string): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ': ' + fix}`)
}
type Grid = Array<Array<{ c?: string }>>
const textOf = (grid: Grid | undefined): string => (grid ?? []).map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const rowOf = (frame: string, id: number): string | undefined => frame.split('\n').find(line => new RegExp(`^[│❯\\s]*${id} · `).test(line))
const squash = (text: string): string => text.replace(/\s+/g, '')
function wholeWhereThePaneWraps(frame: string, path: string): boolean {
  const rows = frame.split('\n')
  const head = rows.findIndex(row => row.includes('SETTING DETAIL'))
  if (head < 0) return true
  const right = rows[head]!.lastIndexOf('│')
  const left = rows[head]!.lastIndexOf('│', right - 1)
  return squash(rows.slice(head + 1).map(row => row.slice(left + 1, right)).join('')).includes(squash(path))
}

const key = (awaitText: string, data: string, mark?: string) => ({ awaitText, requireAwait: true, awaitSettleTicks: 4, data, ...(mark === undefined ? {} : { mark }) })
const toThePage = [key('New Session', 's'), key('MCPs & Skills', DOWN.repeat(settingsEditors.length - 1) + '\r', 'menu')]
const journey = [
  ...toThePage,
  key('1 · Profile 1', BACKSPACE + 'n', 'one'),
  key('Profile 2 created', DOWN + 'r', 'two'),
  key('name: ▌', 'Gone'),
  key('name: Gone▌', ESC),
  key(IN_THE_LIST, 'r', 'rename-left'),
  key('name: ▌', 'Workx' + BACKSPACE),
  key('name: Work▌', '\r'),
  key('2 · Work', BACKSPACE, 'renamed'),
  key('remove Work?', ESC, 'confirm'),
  key(IN_THE_LIST, BACKSPACE, 'remove-left-esc'),
  key('remove Work?', 'n'),
  key(IN_THE_LIST, BACKSPACE, 'remove-left-n'),
  key('remove Work?', 'y'),
]
const refusal = [...toThePage, key('1 · Profile 1', 'n')]
const stranger = (install: { bin: string }): void => writeFileSync(join(install.bin, 'mercury2'), 'not a profile command\n')

async function drive(cols: number, rows: number, scene: { name: string; sends: Array<ReturnType<typeof key>>; readyText: string; stage?: (install: { home: string; bin: string }) => void }): Promise<{ frame: (label: string) => string; home: string; bin: string }> {
  const userHome = realpathSync(mkdtempSync(join(tmpdir(), 'profiles-page-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'profiles-page-project-')))
  const install = stageInstall('source', userHome)
  seedFirstRun(install.home, [cwd])
  scene.stage?.(install)
  const output = join(userHome, 'capture.json')
  const config = join(userHome, 'capture-config.json')
  writeFileSync(config, JSON.stringify({ argv: [install.command], cwd, cols, rows, out: output, total: 600, sends: scene.sends, readyText: scene.readyText }))
  const env = {
    ...install.env,
    TERM: 'xterm-256color',
    MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()),
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: fixture.url,
  }
  const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
    const child = spawn(python, [engine, config], { cwd: root, env })
    let text = ''
    child.stdout.on('data', value => { text += value })
    child.stderr.on('data', value => { text += value })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150000))
    child.on('close', code => { clearTimeout(deadline); resolveRun({ code, text }) })
  })
  spawnSync(install.command, ['daemon', 'stop'], { env, timeout: 10000, stdio: 'pipe' })
  check(`${cols}x${rows} ${scene.name}: the drive ran to its end`, result.code === 0 && existsSync(output), `an awaited text in the sends list of this drive never painted; compare the last awaited text with the output tail and the words in ${PAGE}. ${result.text.trim().slice(-700)}`)
  const capture = (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {}) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
  for (const dir of [userHome, cwd]) removeScratch(dir)
  const marks = new Map([...(capture.marks ?? []).map(mark => [mark.label, textOf(mark.grid)] as const), [scene.name, textOf(capture.grid)] as const])
  if (framesDir !== undefined) {
    mkdirSync(framesDir, { recursive: true })
    for (const [label, text] of marks) writeFileSync(join(framesDir, `${label}-${cols}x${rows}.txt`), text + '\n')
  }
  check(`${cols}x${rows} ${scene.name}: every key reached its screen`, capture.sendReceipts?.length === scene.sends.length, `only ${String(capture.sendReceipts?.length)} of ${scene.sends.length} sends were delivered; the first send whose awaited text never painted names the screen that stopped`)
  return { frame: label => marks.get(label) ?? '', home: install.home, bin: install.bin }
}

try {
  for (const cols of [120, 80]) {
    const { frame, home } = await drive(cols, 40, { name: 'removed', sends: journey, readyText: 'Work removed' })
    const menu = frame('menu').split('\n')
    const agentsAt = menu.findIndex(line => /Agents\s+↵ open/.test(line))
    check(`${cols}: the Boot Menu shows Profiles (Beta) under Agents`, agentsAt >= 0 && /Profiles \(Beta\)\s+↵ open/.test(menu[agentsAt + 1] ?? ''), `put the profiles row after the agents row of settingsEditors in src/screen/boot-face/settings/menuModel.ts; the editor rows read: ${menu.filter(line => line.includes('↵ open')).map(line => line.trim()).join(' | ')}`)
    check(`${cols}: the page lists Profile 1 alone, marked as this one`, /mercury · this one/.test(rowOf(frame('one'), 1) ?? '') && rowOf(frame('one'), 2) === undefined, `the row of the profile this session runs in must read "1 · Profile 1" with "mercury · this one" (the entries of ${PAGE}); it reads: ${rowOf(frame('one'), 1)?.trim() ?? 'no row'}`)
    check(`${cols}: Profile 1 is offered no remove, and ⌫ on it opens no confirm (the n after it creates Profile 2)`, !frame('one').includes('⌫ remove') && /Profile 2\s+mercury2/.test(rowOf(frame('two'), 2) ?? ''), `the remove action must keep its when: removable and the legend must leave ⌫ remove out on Profile 1 and on this session's profile (${PAGE})`)
    check(`${cols}: create adds Profile 2 with mercury2 and says which command starts it`, /Profile 2\s+mercury2/.test(rowOf(frame('two'), 2) ?? '') && frame('two').includes('Profile 2 created — mercury2 starts it'), `n must call createProfile and print its command (the n action of ${PAGE}); the row reads: ${rowOf(frame('two'), 2)?.trim() ?? 'no row'}`)
    check(`${cols}: esc leaves the rename with the name as it was`, /Profile 2\s+mercury2/.test(rowOf(frame('rename-left'), 2) ?? '') && !frame('rename-left').includes('Gone'), `esc in the rename prompt must close it and call nothing (the rename keys of ${PAGE}); the row reads: ${rowOf(frame('rename-left'), 2)?.trim() ?? 'no row'}`)
    check(`${cols}: a rename shows the new name, a ⌫ in the prompt taken`, /Work\s+mercury2/.test(rowOf(frame('renamed'), 2) ?? ''), `r, a typed name and ↵ must call renameProfile and re-read the list, and ⌫ must shorten the typed name (the rename keys of ${PAGE}, src/screen/boot-face/typedName.ts); the row reads: ${rowOf(frame('renamed'), 2)?.trim() ?? 'no row'}`)
    check(`${cols}: remove asks first and says the folder and logins stay`, frame('confirm').includes('remove Work?') && frame('confirm').includes('its folder and logins stay at') && frame('confirm').includes('y / ↵ remove · n / esc cancel') && rowOf(frame('confirm'), 2) !== undefined, `⌫ on a profile that is neither Profile 1 nor this one must open the confirm and remove nothing yet (the remove keys and detailLinesOf of ${PAGE})`)
    check(`${cols}: esc and n each leave the remove with the profile still there`, /Work\s+mercury2/.test(rowOf(frame('remove-left-esc'), 2) ?? '') && /Work\s+mercury2/.test(rowOf(frame('remove-left-n'), 2) ?? ''), `esc and n in the confirm must close it and call nothing (the remove keys of ${PAGE}); after esc the row reads: ${rowOf(frame('remove-left-esc'), 2)?.trim() ?? 'no row'}; after n: ${rowOf(frame('remove-left-n'), 2)?.trim() ?? 'no row'}`)
    check(`${cols}: after the remove the list is Profile 1 alone again and the kept folder is named whole where the pane wraps`, rowOf(frame('removed'), 1) !== undefined && rowOf(frame('removed'), 2) === undefined && wholeWhereThePaneWraps(frame('removed'), `${home}2`), `y must call removeProfile, re-read the list and print keptHome in the detail pane, where it wraps (the remove keys and detailLinesOf of ${PAGE}); row 2 reads: ${rowOf(frame('removed'), 2)?.trim() ?? 'no row'}`)

    const refused = await drive(cols, 40, { name: 'refused', sends: refusal, readyText: 'again.', stage: stranger })
    check(`${cols}: a refusal from the door is on screen to its last word, its path whole where the pane wraps`, refused.frame('refused').includes('again.') && wholeWhereThePaneWraps(refused.frame('refused'), join(refused.bin, 'mercury2')) && rowOf(refused.frame('refused'), 2) === undefined, `a door reason must go to the detail pane, where it wraps, and never to the status row alone (settle and detailLinesOf of ${PAGE})`)

    const unread = await drive(cols, 40, { name: 'unread', sends: toThePage, readyText: 'again.', stage: install => writeFileSync(join(install.home, 'profiles.json'), '{') })
    check(`${cols}: a list that does not read says so, names the file, draws no row and offers only esc`, unread.frame('unread').includes('again.') && wholeWhereThePaneWraps(unread.frame('unread'), join(unread.home, 'profiles.json')) && rowOf(unread.frame('unread'), 1) === undefined && unread.frame('unread').includes('esc back') && !/n new|r rename|⌫ remove/.test(unread.frame('unread')), `when listProfiles answers ok: false the page must print its reason in the detail pane, pass no action to the list and show the legend esc back (${PAGE})`)
  }
  const short = await drive(120, 34, { name: 'refused', sends: refusal, readyText: 'again.', stage: stranger })
  check('120x34: a refusal from the door is whole in a short wide window', short.frame('refused').includes('SETTING DETAIL') && short.frame('refused').includes('again.') && wholeWhereThePaneWraps(short.frame('refused'), join(short.bin, 'mercury2')), `what the page says in the pane must be held as a confirm's lines are, never dropped for room: detailOverrideConfirms while a pane message shows (${PAGE})`)
  check('the page made no model call', fixture.messageRequests().length === 0, `a key of the profiles page reached the model API; the page must stay on the door in src/platform/profiles/profiles.ts`)
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
