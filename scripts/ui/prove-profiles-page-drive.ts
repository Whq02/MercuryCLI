#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { key, stagedPageDrive } from '../lib/stagedPageDrive.ts'

const framesDir = process.argv[2]
const fixture = await startFixtureApi([])
const PAGE = 'src/screen/boot-face/BootProfilesScreen.tsx'
const UP = '\u001b[A'
const DOWN = '\u001b[B'
const END = '\u001b[F'
const ESC = '\u001b'
const BACKSPACE = '\u007f'
const IN_THE_LIST = 'r rename · ⌫ remove · esc back'
const SMALL = { cols: 40, rows: 10 }
const WIDE = { cols: 120, rows: 40 }
let failures = 0
const check = (label: string, ok: boolean, fix: string): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ': ' + fix}`)
}
const rowOf = (frame: string, id: number): string | undefined => frame.split('\n').find(line => new RegExp(`^[│❯\\s]*${id} · `).test(line))
const squash = (text: string): string => text.replace(/\s+/g, '')
function paneOf(frame: string): string | null {
  const rows = frame.split('\n')
  const head = rows.findIndex(row => row.includes('SETTING DETAIL'))
  if (head < 0) return null
  const right = rows[head]!.lastIndexOf('│')
  const left = rows[head]!.lastIndexOf('│', right - 1)
  return squash(rows.slice(head + 1).map(row => row.slice(left + 1, right)).join(''))
}
const wholeWhereThePaneWraps = (frame: string, path: string): boolean => paneOf(frame)?.includes(squash(path)) ?? true
const says = (frame: string, words: string): boolean => (paneOf(frame) ?? squash(frame)).includes(squash(words))

const toThePage = [key('New Session', END + '\r', 'face')]
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
const oneSkill = (install: { home: string }): void => {
  mkdirSync(join(install.home, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(install.home, 'skills', 'alpha', 'SKILL.md'), '---\ndescription: a skill of the first profile\n---\nits body\n')
}

const drive = stagedPageDrive({ name: 'profiles-page', page: PAGE, framesDir, fixtureUrl: fixture.url, check })
if (drive === null) {
  console.log('The profiles page drive requires the POSIX capture driver.')
  await fixture.close()
  process.exit(0)
}

try {
  for (const cols of [120, 80]) {
    const { frame, home } = await drive(cols, 40, { name: 'removed', sends: journey, readyText: 'Work removed' })
    const face = frame('face').split('\n')
    const menuAt = face.findIndex(line => line.includes('Boot Menu'))
    check(`${cols}: the Boot face shows Profiles directly under Boot Menu`, menuAt >= 0 && /Profiles\b/.test(face[menuAt + 1] ?? '') && !frame('face').includes('(Beta)'), `the row joins the face through withProfilesRow in assets/splash/splash-core.mjs, called where src/screen/boot-face/BootSplashScreen.tsx builds its rows; the face's rows read: ${face.filter(line => /New Session|Logins|Concourse|Boot Menu|Profiles/.test(line)).map(line => line.trim()).join(' | ')}`)
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

    const kept = await drive(cols, 40, {
      name: 'kept',
      sends: [...toThePage, key('2 · Profile 2', DOWN + BACKSPACE), key('remove Profile 2?', 'y')],
      readyText: 'Profile 2 removed',
      stage: install => {
        writeFileSync(join(install.home, 'profiles.json'), JSON.stringify({ profiles: [{ id: 2 }] }))
        stranger(install)
      },
    })
    check(`${cols}: a file at the command's path that is not the profile's command is left and named after the remove`, squash(kept.frame('kept')).includes(squash('left in place, not its command')) && wholeWhereThePaneWraps(kept.frame('kept'), join(kept.bin, 'mercury2')) && rowOf(kept.frame('kept'), 2) === undefined, `after a remove the page must print the door's keptFiles on a line after the folder line (the remove keys of ${PAGE})`)

    const skilled = await drive(cols, 40, {
      name: 'skills',
      sends: [...toThePage, key('1 · Profile 1', 'n')],
      readyText: 'skill copied',
      stage: oneSkill,
    })
    check(`${cols}: a create says how many skills it copied, switched off, and keeps the create line`, says(skilled.frame('skills'), '1 skill copied from Profile 1, switched off') && says(skilled.frame('skills'), 'Profile 2 created — mercury2 starts it') && rowOf(skilled.frame('skills'), 2) !== undefined, `after a createProfile that answers ok the n action must call inheritSkills with the new home and print its answer in the pane, under the create line (${PAGE})`)
  }
  const late = await drive(120, 40, {
    name: 'late',
    sends: [...toThePage, key('1 · Profile 1', 'n' + UP + 'r'), key('name: ▌', ESC)],
    readyText: ['2 · Profile 2', 'r rename · esc back'],
    stage: oneSkill,
    after: install => existsSync(join(`${install.home}2`, 'skills', 'alpha', 'SKILL.md')),
  })
  check('120: a rename opened before the skills answer came is not answered with the skills line when it is left', late.after && rowOf(late.frame('late'), 2) !== undefined && !says(late.frame('late'), 'skill copied') && !says(late.frame('late'), 'Profile 2 created'), `the n action must add the skills line only while the page still says that create's own line: one functional update of said that leaves anything else as it stands (${PAGE}); the skill was copied: ${String(late.after)}; the pane reads: ${paneOf(late.frame('late')) ?? 'no pane'}`)
  const linked = await drive(120, 40, { name: 'linked', linked: true, sends: [...toThePage, key('1 · Profile 1', 'n'), key('2 · Profile 2', DOWN)], readyText: IN_THE_LIST })
  check('started through a link, with the command folder off PATH, the page names the new command by its full path, and the row keeps its name', says(linked.frame('linked'), `${join(linked.bin, 'mercury2')} starts it`) && /Profile 2\s+mercury2/.test(rowOf(linked.frame('linked'), 2) ?? ''), `startWords must print the row's offPath where the door gives one (${PAGE}); the pane reads: ${paneOf(linked.frame('linked')) ?? 'no pane'}`)
  const small = await drive(120, 40, {
    name: 'small',
    sends: [
      ...toThePage,
      key('1 · Profile 1', 'n'),
      key('Profile 2 created', DOWN + BACKSPACE),
      key('remove Profile 2?', '', 'confirm-wide'),
      key('remove Profile 2? y ↵ · n esc', 'n', 'confirm-small'),
      key(IN_THE_LIST, 'n' + UP + DOWN + 'r', 'list-small'),
      key('name: ▌ ↵ · esc', 'Zed', 'rename-small'),
      key('name: Zed▌ ↵ · esc', '\r'),
      key('2 · Zed · mercury2', BACKSPACE, 'renamed-small'),
      key('remove Zed? y ↵ · n esc', 'y'),
    ],
    resizes: [{ afterMark: 'confirm-wide', ...SMALL }],
    readyText: '↑↓ · r rename · esc back',
    after: install => !existsSync(join(install.bin, 'mercury2')) && !existsSync(join(install.bin, 'mercury3')),
  })
  check('at 40 by 10 an open confirm and an open rename are drawn on the legend\'s line, and their keys act: cancelled, renamed, removed, and n made no profile', small.after && small.frame('confirm-small').includes('2 · Profile 2 · mercury2') && small.frame('renamed-small').includes('2 · Zed · mercury2') && rowOf(small.frame('small'), 2) === undefined && rowOf(small.frame('small'), 3) === undefined, `the page must hand the layout its open prompt as one line (asking in ${PAGE}; bootMenuAsks in assets/splash/splash-core.mjs says whether it is drawn); mercury2 removed and no mercury3: ${String(small.after)}; the last screen reads: ${small.frame('small').split('\n').map(line => line.trim()).filter(Boolean).join(' | ')}`)
  check('at 40 by 10 the legend at rest names the keys that work there and no other', small.frame('list-small').includes(`↑↓ · ${IN_THE_LIST}`) && !/cycles|n new/.test(small.frame('list-small')) && small.frame('small').includes('↑↓ · r rename · esc back'), `the page must hand composeBootMenuMicro its own legend for that layout (legendMicro in ${PAGE}); the screen reads: ${small.frame('list-small').split('\n').map(line => line.trim()).filter(Boolean).join(' | ')}`)
  const slim = await drive(120, 40, {
    name: 'slim',
    sends: [...toThePage, key('1 · Profile 1', 'n'), key('Profile 2 created', DOWN + BACKSPACE), key('remove Profile 2?', '', 'confirm-wide'), key('(>_) profiles', '\ry' + ESC, 'confirm-slim'), key('↑↓ · r rename · esc back', BACKSPACE + 'y' + UP, 'closed'), key('❯ 1 · Profile 1', '', 'entered')],
    resizes: [{ afterMark: 'confirm-wide', cols: 24, rows: 10 }, { afterMark: 'entered', ...WIDE }],
    readyText: 'SETTING DETAIL',
    after: install => existsSync(join(install.bin, 'mercury2')),
  })
  check('at 24 columns the confirm\'s line cannot be drawn whole, so ↵ and y remove nothing, esc closes it, and ⌫ then opens none: wide again the profile and its command stand, no confirm open', slim.after && rowOf(slim.frame('slim'), 2) !== undefined && !slim.frame('slim').includes('remove Profile 2?') && !slim.frame('entered').includes('⌫ remove'), `where bootMenuAsks (assets/splash/splash-core.mjs) answers that the line is not drawn, the keys of the open prompt must not act, esc and n excepted, and no prompt opens (${PAGE}); the command still stands: ${String(slim.after)}; wide again row 2 reads: ${rowOf(slim.frame('slim'), 2)?.trim() ?? 'no row'}`)
  const narrow = await drive(60, 20, { name: 'refused', sends: refusal, readyText: 'again.', stage: stranger })
  check('60x20: a refusal names its file whole, wrapped over the notice\'s lines', squash(narrow.frame('refused')).includes(squash(join(narrow.bin, 'mercury2'))), `below 110 columns a notice word longer than the line must wrap, not be cut: the notice lines of composeBootMenuClassic in assets/splash/splash-core.mjs; the screen reads: ${narrow.frame('refused').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8).join(' | ')}`)
  const short = await drive(120, 34, { name: 'refused', sends: refusal, readyText: 'again.', stage: stranger })
  check('120x34: a refusal from the door is whole in the pane of a short wide window, the count in the status row', short.frame('refused').includes('SETTING DETAIL') && short.frame('refused').includes('again.') && wholeWhereThePaneWraps(short.frame('refused'), join(short.bin, 'mercury2')) && /System ready\s+│\s+1 profile\b/.test(short.frame('refused')), `what the page says in the pane must be held as a confirm's lines are, never dropped for room, and the status row keeps the count: detailOverrideConfirms and statusRight while a pane message shows (${PAGE})`)
  check('the page made no model call', fixture.messageRequests().length === 0, `a key of the profiles page reached the model API; the page must stay on the door in src/platform/profiles/profiles.ts`)
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
