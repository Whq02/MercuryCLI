#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('popup-body-rests-at-top')
const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { Box, Text } = await import('../../src/ink.ts')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.tsx')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const ROOT = join(import.meta.dir, '..', '..')
const COLUMNS = 60
const ROWS = 16
const VIEWPORT = 8
const row = (n: number): string => `row ${String(n).padStart(2, '0')}`
const body = (count: number, restsAtTop: boolean): unknown =>
  h(
    Box,
    { flexDirection: 'column', width: COLUMNS, height: ROWS },
    h(
      ScrollBox as never,
      { flexDirection: 'column', maxHeight: VIEWPORT, ...(restsAtTop ? { restsAtTop: true } : {}) } as never,
      Array.from({ length: count }, (_, i) => h(Text, { key: i }, row(i + 1))),
    ),
  )
const shown = (lines: string[]): string[] => lines.map(line => line.trim()).filter(line => /^row \d\d$/.test(line))

async function grown(restsAtTop: boolean): Promise<{ before: string[]; after: string[] }> {
  const m = await mountOffscreen(body(5, restsAtTop), COLUMNS, ROWS)
  await waitFor(() => shown(m.lines()).length === 5, 5_000)
  const before = shown(m.lines())
  m.resize(body(30, restsAtTop), COLUMNS, ROWS)
  await waitFor(() => shown(m.lines()).length === VIEWPORT, 5_000)
  await settle(200)
  const after = shown(m.lines())
  m.unmount()
  await settle(50)
  return { before, after }
}

console.log('a pop-up body that says it rests at its top stays there when its content grows past the viewport')

section('the scroll box: content that fits, then grows past the viewport')
{
  const follows = await grown(false)
  check('control: all five rows show while the content fits', follows.before.join(',') === [1, 2, 3, 4, 5].map(row).join(','), follows.before.join(','))
  check('control: a box that says nothing follows its end when the content grows, as a transcript does', follows.after.length === VIEWPORT && follows.after[follows.after.length - 1] === row(30) && !follows.after.includes(row(1)), follows.after.join(','))
  const rests = await grown(true)
  check('a box that rests at its top shows its first rows after the same growth', rests.after.join(',') === Array.from({ length: VIEWPORT }, (_, i) => row(i + 1)).join(','), rests.after.join(','))
}

section('the help pop-up asks for it')
{
  const help = readFileSync(join(ROOT, 'src', 'components', 'HelpV2', 'HelpV2.tsx'), 'utf8')
  const centre = readFileSync(join(ROOT, 'src', 'components', 'mercury-ui', 'components.tsx'), 'utf8')
  check('the help pop-up tells its shell the body rests at its top', /<CommandCenter[^>]*\bbodyRestsAtTop\b/s.test(help))
  check('the shell hands that to its body in both of its layouts', (centre.match(/<ScrollBox key="body"[^>]*restsAtTop=\{bodyRestsAtTop\}/g) ?? []).length === 2)
}

await releaseScratchHome(home)
console.log(failures === 0 ? `\n✅ pop-up body rests at its top: ${checks} checks, 0 failures` : `\n❌ pop-up body rests at its top: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
