#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '')

console.log('============================================================')
console.log(' the teams dialog is gone; the crew view is the one roster screen')
console.log('============================================================')

console.log('\n§1 the dialog and its footer pill no longer exist')
check('src/components/teams/ is gone', !existsSync(join(ROOT, 'src/components/teams')), 'the folder is present')
check('the dialog module is gone', !existsSync(join(ROOT, 'src/components/teams/TeamsDialog.tsx')), 'src/components/teams/TeamsDialog.tsx is present')
check('the footer pill module is gone', !existsSync(join(ROOT, 'src/components/teams/TeamStatus.tsx')), 'src/components/teams/TeamStatus.tsx is present')

console.log('\n§2 the composer mounts no dialog and its footer has no teams door')
const composer = read('src/components/PromptInput/PromptInput.tsx')
const footer = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
check('the composer imports no dialog from a teams folder', !/from '\.\.\/teams\//.test(composer), (composer.match(/from '\.\.\/teams\/[^']*'/) ?? [''])[0])
check('the composer keeps no dialog flag', !/showTeamsDialog/.test(composer), 'showTeamsDialog is still declared')
check("the footer's enter road has no teams branch", !/footerSelection === 'teams'/.test(composer), "footerSelection === 'teams' is still a branch")
check('the footer renders no teams pill', !/TeamStatus/.test(footer) && !/teamsPresent/.test(footer), 'TeamStatus/teamsPresent still in the footer')
const store = read('src/state/AppStateStore.ts')
const footerItem = /export type FooterItem = ([^\n]+)/.exec(store)?.[1] ?? ''
check("the footer selection vocabulary no longer names 'teams'", footerItem !== '' && !/'teams'/.test(footerItem), footerItem)

console.log('\n§3 no overlay registers under the dialog\'s name anywhere in src')
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out) }
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
}
const files: string[] = []
walk(join(ROOT, 'src'), files)
const registrants: string[] = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('teams-dialog')) continue
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text === 'teams-dialog') registrants.push(file.slice(ROOT.length + 1))
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
check("no source registers the 'teams-dialog' overlay", registrants.length === 0, registrants.join(', '))

console.log('\n§4 the crew view is the roster screen: it lists the crewmates the dialog listed')
const crewView = read('src/components/mercury-ui/screens/CrewView.tsx')
check('the crew view exists and renders sub-agent and named-agent rows', crewView.includes('Sub-agents') && crewView.includes('Named agents'), 'CrewView.tsx lacks its two sections')
check('its named rows carry the model the dialog showed', crewView.includes('member.model'), 'no model on the named rows')

console.log(`\nprove-teams-dialog-gone: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
