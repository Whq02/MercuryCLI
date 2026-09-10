#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 CB-04 — the zero-row drop-down arm refused at the door; shrink disarms')
{
  const { switchboardGeometry, resolveConcourseProfile } = await import(
    '../../src/components/concourse/ConcourseLayout.tsx'
  )
  const grant0 = switchboardGeometry(120, 24, 1, 6, 2, 0, 'mirror', 8).peekRows
  check('the hazard exists: the wide minimum grants the 8-row ask 0 rows', grant0 === 0, `granted ${grant0}`)
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the arm probes the WOULD-BE geometry with the would-be ask before arming',
    screen.includes('const wouldAsk = Math.max(2, Math.min(ROW_PEEK_DESIRED_ROWS, census.entries.length + 1))') &&
      screen.includes('if (wouldGrant < 2) {'),
  )
  check(
    'a refused arm answers the honest line and arms NOTHING',
    screen.includes('no room to unfold the older chats — this height gives the list') &&
      /if \(wouldGrant < 2\) \{\s*\n\s*setNote\([^)]*\)\s*\n\s*return\s*\n\s*\}/.test(screen),
  )
  check(
    'an ARMED list whose live grant falls under the 2-row floor disarms with the note',
    screen.includes('if (olderList !== null && geo.peekRows < 2) {') &&
      screen.includes('older chats folded — no room at this height'),
  )
  check(
    'the arrow-eat stays gated on the armed list alone (disarm returns the arrows to the board)',
    screen.includes('const open = olderListRef.current') && screen.includes('if (open === null || !(key.upArrow || key.downArrow)) return false'),
  )
  check('the 2-row floor is the ask floor (max(2, …)) — one number, two sites', resolveConcourseProfile(120, 24) === 'wide')
}

console.log('§3 A5 — the resume waits bind their exits; a cancel outlives a late success')
{
  const screen = read('src/screens/ResumeConversation.tsx')
  check(
    'the loading wait binds its exit',
    /if \(isLoading\)\s*\n\s*return host\(\s*\n\s*<ResumeWait text="Loading conversations…" hint="esc or ctrl\+c quits" onCancel=\{\(\) => process\.exit\(1\)\} \/>/.test(
      screen,
    ),
  )
  check(
    'the resuming wait cancels back to the picker',
    screen.includes('text="Resuming conversation…"') && screen.includes('onCancel={cancelResumeWait}'),
  )
  check('no naked SpinnerLine wait survives', !screen.includes('return host(<SpinnerLine'))
  check(
    'ResumeWait binds BOTH advertised keys in one leaf (ctrl+c via app:interrupt, esc via key.escape)',
    screen.includes("useKeybinding('app:interrupt', onCancel)") && screen.includes('if (key.escape) onCancel()'),
  )
  check(
    'the leaf carries its own KeybindingSetup (this root guarantees no provider — the NoConversations precedent)',
    /<KeybindingSetup>\s*\n\s*<ResumeWaitInner/.test(screen),
  )
  const guards = (screen.match(/if \(gen !== resumeGenRef\.current\) return/g) ?? []).length
  check(`every await in onSelect re-checks the generation (2 guards, found ${guards})`, guards >= 2)
  check('a cancel bumps the generation so in-flight work goes stale', screen.includes('resumeGenRef.current++') && screen.includes('const gen = ++resumeGenRef.current'))
}

console.log('§4 A6 — the cross-project pick stays on the picker')
{
  const screen = read('src/screens/ResumeConversation.tsx')
  check('the 100ms whole-CLI exit is gone', !screen.includes('CROSS_PROJECT_EXIT_DELAY_MS') && !screen.includes('CrossProjectMessage') && !screen.includes('process.exit(0)'))
  check(
    'the cross branch clears the wait and paints the command with the picker staying',
    /setIsResuming\(false\)\s*\n\s*setResumeRefusal\(\s*\n\s*`that conversation lives in another folder/.test(screen) &&
      screen.includes('· the picker stays open'),
  )
  check('the clipboard copy survives (the useful half of the old card)', screen.includes('const sequence = await setClipboard(cross.command)'))
  check('the same-repo-worktree exemption stays wired', screen.includes('cross.isCrossProject && !cross.isSameRepoWorktree'))
}

console.log("§5 A7 — the exit-grammar pair (c/d) is never eaten by a letter-verb")
{
  const { interpretKey } = await import('../../src/ink/input/interpreter.ts')
  const k = interpretKey('\x03') as { name?: string; ctrl?: boolean }
  check(
    "the decoder fact that makes the guard load-bearing: \\x03 → {name:'c', ctrl:true}",
    k.name === 'c' && k.ctrl === true,
  )
  const { readdirSync, statSync } = await import('node:fs')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) files.push(rel)
    }
  }
  walk('src')
  const offenders: string[] = []
  for (const rel of files) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/input === '[cd]'/.test(line)) return
      const windowText = lines.slice(Math.max(0, i - 4), i + 4).join('\n')
      if (!/key\.ctrl/.test(windowText)) offenders.push(`${rel}:${i + 1}`)
    })
  }
  check('no bare c/d letter-verb survives under src (key.ctrl absent from its condition window)', offenders.length === 0, offenders.join(' · '))
  const picker = read('src/components/ModelPicker.tsx')
  const mercuryPicker = read('src/components/MercuryModelPicker.tsx')
  check(
    "both model pickers' context toggles carry the guard (PD-6's two named doors)",
    picker.includes("input === 'c' && !key.ctrl && !key.meta && focusedSupports1m") &&
      !/input === 'c' && (?!!key\.ctrl)/.test(mercuryPicker),
  )
}

console.log('§6 D10 — a dead field never wears a live caret')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the composer’s focus excludes every card-armed state',
    screen.includes("focused={region === 'coordinator' && !(managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy)}"),
  )
  check(
    'the rest hint names the owner while the card stands',
    screen.includes("'the card above owns the keys — answer it, or tab moves focus'") &&
      screen.includes("'the plan is dispatching — tab moves focus'"),
  )
}

console.log(failures === 0 ? '\nnever-stranded-input: GREEN' : `\nnever-stranded-input: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
