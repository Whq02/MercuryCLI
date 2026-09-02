#!/usr/bin/env bun
// ============================================================================
//  scripts/run-continuity/prove-empty-hints.ts — R5: the hints-fire law
//  on emptiable static-footer views.
//
//  The law (interaction grammar): a rendered key hint FIRES — a footer must
//  not advertise ↑↓/↵ row verbs when the view has zero rows a cursor can act
//  on. NavigablePanes and useInteractiveList compose hints live; the R5 sweep
//  found four static-footer CommandCenter views that could render empty (or
//  filter-to-zero) while still advertising row verbs:
//
//    · /run inspector (commands/run/run.tsx) — no-snapshot view lists plain
//      lines with no cursor; the old static ['↑↓ select','↵ evidence',…] lied
//    · PaletteView — fuzzy filter-to-zero kept '↑↓ select · ↵ run'
//    · MercuryQuickOpen — filter-to-zero kept '↑↓ move · ↵ open'
//    · MercurySearch — filter-to-zero kept the same
//
//  These are SOURCE LOCKS on the conditional composition (the render truth is
//  carried by the ui suite's scenario captures; run-inspector's empty frame is
//  the standing exhibit). MercuryResume already omits its footer on the empty
//  early-return — the in-estate honest pattern the sweep matched against.
//
//  Run:  ~/.bun/bin/bun run scripts/run-continuity/prove-empty-hints.ts
// ============================================================================
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
  // The honest precedent stays honest: MercuryResume's empty branch renders NO
  // footer (the early return carries no footer prop).
  const s = src('src/components/MercuryResume.tsx')
  const emptyBranch = s.slice(s.indexOf('no resumable sessions') - 400, s.indexOf('no resumable sessions'))
  check('MercuryResume empty branch stays footer-less', !emptyBranch.includes('footer='))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
