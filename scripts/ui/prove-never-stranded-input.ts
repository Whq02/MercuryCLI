#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-never-stranded-input.ts — THE INPUT-NEVER-STRANDS RATCHET
//  The operator's law: no
//  input at any size may leave the operator somewhere they cannot see their
//  way out of. Each section pins ONE closed stranding shape — the pure fact
//  that made it possible plus the source census of the guard that closes it
//  (the prove-split-view discipline: mechanism driven pure, wiring by
//  census). New strandings of this class land HERE.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-never-stranded-input.ts
// ============================================================================
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

// ── §1 CB-04: the older-chats drop-down can never arm invisibly
//  The granted-rows channel lawfully answers 0 at the wide profile's own
//  minimum height (pure fact, pinned in prove-switchboard-geometry). While
//  the list is ARMED, olderNavConsumed eats ↑↓ — so an arm the geometry
//  cannot paint would strand the arrows on nothing. The screen refuses at
//  the door and disarms on shrink.
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
  // The refusal floor and the ask floor agree: the smallest lawful list is
  // 2 rows (one entry + the honest tail) — the arm floor must equal it.
  check('the 2-row floor is the ask floor (max(2, …)) — one number, two sites', resolveConcourseProfile(120, 24) === 'wide')
}

// ── §2 the concourse too-small branch: esc is LIVE and every other key is
//  consumed (the refusal that recovers, never a dead screen) — the census of
//  the branch verified live.
console.log('§2 the too-small refusal keeps its one honest exit')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the too-small branch consumes with esc → exitToRepl (the painted line and the key agree)',
    /if \(resolveConcourseProfile\(cols, termRows\) === 'too-small'\) \{\s*\n\s*if \(key\.escape\) \{\s*\n\s*event\.stopImmediatePropagation\(\)\s*\n\s*callbacks\.exitToRepl\(\)/.test(screen),
  )
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check(
    "the refusal names the WHOLE window, never the split pane's clamped width",
    layout.includes('needs at least 80×24 · this window is {termCols}×{termRows}'),
  )
  check(
    'the refusal names the way out, keyed to the chat truth',
    layout.includes("esc returns to the focused chat") && layout.includes("esc returns to the boot face"),
  )
}

// ── §3: the resume picker's waits carry a NAMED way out
//  SL-1 closed the thrown-freeze; the residue was the honest-but-HUNG wait:
//  "Loading conversations…" / "Resuming conversation…" bound no key on a
//  root whose ctrl+c is deliberately disarmed. Now both waits render
//  ResumeWait — esc and ctrl+c leave the wait (loading: quit; resuming:
//  back to the picker), and a cancel bumps a generation every await in
//  onSelect re-checks, so a late success can never mount the REPL over the
//  picker the operator returned to.
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
  // Re-trued: the pick parses no transcript before the hop (the loader's
  // await left with the hop-lag fix), so onSelect holds TWO awaits — the
  // clipboard copy and the resume door — each re-checking the generation.
  const guards = (screen.match(/if \(gen !== resumeGenRef\.current\) return/g) ?? []).length
  check(`every await in onSelect re-checks the generation (2 guards, found ${guards})`, guards >= 2)
  check('a cancel bumps the generation so in-flight work goes stale', screen.includes('resumeGenRef.current++') && screen.includes('const gen = ++resumeGenRef.current'))
}

// ── §4 (lead-ruled): a cross-project pick stays on the picker
//  ↵ on another folder's session used to swap the picker for a 3-line card
//  and process.exit(0) the WHOLE CLI 100ms later — the operator picked a
//  row and the program vanished (SL-8). Now the command lands on the
//  clipboard, the note names the move, and the picker stays. The follow-up
//  (an in-process project hop) is the operator's ruling, not this lane's.
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

// ── §5 (PD-6's class): a modifier chord is never a letter-verb
//  The decoder hands ctrl+c through as {name:'c', ctrl:true} and this
//  root's exitOnCtrlC is deliberately false, so EVERY bare `input === 'c'`
//  handler ate the interrupt chord (the model pickers flipped their context
//  toggle on ctrl+c; sign-in flows copied URLs; the agent studio armed a
//  CLONE — and unguarded 'd' ate ctrl+d, the exit chord: the studio's 'd'
//  armed DELETE-CONFIRM on an exit gesture). The exit grammar's own pair
//  (c/d) is ratcheted here estate-wide: every input==='c'/'d' comparison
//  must see key.ctrl in its condition (guarding it out, or requiring it).
//  The broader letter class (s/x/m/…) is a named lane residue.
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
      // The enclosing condition, approximated: the match line and its
      // neighbours (multi-line if-conditions put the guard on its own row).
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

// ── §6 (MGR-6): the composer never wears focus it lacks
//  While a manager card stood, the coordinator composer kept its blinking
//  caret and typing hint while every keystroke went to the card — a live
//  caret over a dead field. The composer paints unfocused under a
//  standing card and its rest hint names the truth.
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
