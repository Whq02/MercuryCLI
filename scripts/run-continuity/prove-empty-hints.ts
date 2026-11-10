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
    /snap && rows\.length > 0 \? \['↑↓ select', 'pgup\/pgdn page', '↵ evidence', 'g reconcile'\] : \['g reconcile'\]/.test(s),
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
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
