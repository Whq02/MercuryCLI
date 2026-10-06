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
console.log(' the crews dialog is gone; the crew view is the one roster screen')
console.log('============================================================')

console.log('\n§1 the dialog and its footer pill no longer exist')
check('src/components/crews/ is gone', !existsSync(join(ROOT, 'src/components/crews')), 'the folder is present')
check('the dialog module is gone', !existsSync(join(ROOT, 'src/components/crews/CrewsDialog.tsx')), 'src/components/crews/CrewsDialog.tsx is present')
check('the footer pill module is gone', !existsSync(join(ROOT, 'src/components/crews/CrewStatus.tsx')), 'src/components/crews/CrewStatus.tsx is present')

console.log('\n§2 the composer mounts no dialog and its footer has no crews door')
const composer = read('src/components/PromptInput/PromptInput.tsx')
const footer = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
check('the composer imports no dialog from a crews folder', !/from '\.\.\/crews\//.test(composer), (composer.match(/from '\.\.\/crews\/[^']*'/) ?? [''])[0])
check('the composer keeps no dialog flag', !/showCrewsDialog/.test(composer), 'showCrewsDialog is still declared')
check("the footer's enter road has no crews branch", !/footerSelection === 'crews'/.test(composer), "footerSelection === 'crews' is still a branch")
check('the footer renders no crews pill', !/CrewStatus/.test(footer) && !/crewsPresent/.test(footer), 'CrewStatus/crewsPresent still in the footer')
const store = read('src/state/AppStateStore.ts')
const footerItem = /export type FooterItem = ([^\n]+)/.exec(store)?.[1] ?? ''
check("the footer selection vocabulary no longer names 'crews'", footerItem !== '' && !/'crews'/.test(footerItem), footerItem)

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
  if (!text.includes('crews-dialog')) continue
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text === 'crews-dialog') registrants.push(file.slice(ROOT.length + 1))
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
check("no source registers the 'crews-dialog' overlay", registrants.length === 0, registrants.join(', '))

console.log('\n§4 the crew view is the one screen: it lists the crewmates the dialog listed')
const crewView = read('src/components/mercury-ui/screens/CrewView.tsx')
check('the crew view exists and lists the crewmates in ONE list, with no second kind of row', crewView.includes('Crewmates') && !crewView.includes("kind === 'seat'") && !crewView.includes('crewRosterOf'), 'CrewView.tsx does not build its one list')
check('its rows carry the model the dialog showed', crewView.includes('crewModelLabel(facts)'), 'no model on the rows')

console.log(`\nprove-crews-dialog-gone: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
