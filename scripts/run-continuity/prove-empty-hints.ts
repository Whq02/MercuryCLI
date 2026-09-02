#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

console.log('empty-state hint honesty (hints-fire law) ──')

{
  const s = src('src/commands/run/run.tsx')
  check(
    '/run: row verbs gated on a snapshot with rows',
    /snap && rows\.length > 0 \? \['↑↓ select', '↵ evidence', 'g reconcile'\] : \['g reconcile'\]/.test(s),
  )
  check('/run: no unconditional row-verb array survives', !s.includes("controls: string[] = ['↑↓ select'"))
}
{
  const s = src('src/components/mercury-ui/PaletteView.tsx')
  check(
    'PaletteView: footer composes from results.length',
    s.includes("results.length > 0 ? '↑↓ select · ↵ run · type to filter'"),
  )
}
{
  const s = src('src/components/MercuryQuickOpen.tsx')
  check(
    'MercuryQuickOpen: footer composes from filtered.length',
    s.includes("filtered.length > 0 ? 'type · ↑↓ move · ↵ open'"),
  )
}
{
  const s = src('src/components/MercurySearch.tsx')
  check(
    'MercurySearch: footer composes from filtered.length',
    s.includes("filtered.length > 0 ? 'type · ↑↓ move · ↵ open'"),
  )
}
{
  const s = src('src/components/MercuryResume.tsx')
  const emptyBranch = s.slice(s.indexOf('no resumable sessions') - 400, s.indexOf('no resumable sessions'))
  check('MercuryResume empty branch stays footer-less', !emptyBranch.includes('footer='))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
