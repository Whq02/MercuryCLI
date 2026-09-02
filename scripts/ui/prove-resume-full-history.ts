#!/usr/bin/env bun
// ============================================================================
//  prove-resume-full-history — session continuity matches the UI's promise
//
//
//  The promise: /sessions is the QUICK project-scoped open-session switcher;
//  argless /resume is the REAL full-history surface — cross-project,
//  older-than-the-grid, and deliberately /clear'ed sessions all reachable
//  in-session, with no invisible cap. Before this fix the argless /resume
//  mounted the project-scoped grid (cleared dropped, hard 8-card cap) while
//  its own copy claimed "/resume reaches the full history".
//
//  Also: a stale /sessiontab <id> target now produces a NOTICE instead of
//  silently flipping to a different session, and resuming a cleared session
//  un-clears it (the deliberate reopen re-enters the switcher surfaces).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, '../../', ...p), 'utf8')

console.log('============================================================')
console.log(' /resume full-history surface — proof')
console.log('============================================================')

// ── 1. the sliding window: every index reachable, no invisible cap ──────────
{
  const { computeSessionWindow } = await import(
    '../../src/components/mercury-ui/screens/SessionManagerView.tsx'
  )
  const win = computeSessionWindow as (
    sel: number,
    total: number,
    size: number,
  ) => { start: number; end: number }
  check('small list ⇒ whole list', JSON.stringify(win(0, 5, 8)) === '{"start":0,"end":5}')
  check('cursor at top ⇒ window at top', win(0, 100, 8).start === 0)
  const atEnd = win(99, 100, 8)
  check('cursor at index 99 of 100 is REACHABLE (window slides)', atEnd.end === 100 && atEnd.start === 92)
  // Every index in a large history is inside its own window.
  let allReachable = true
  for (let i = 0; i < 500; i++) {
    const w = win(i, 500, 8)
    if (!(i >= w.start && i < w.end)) allReachable = false
  }
  check('every index of a 500-session history is inside its window', allReachable)
  check('window size stays fixed', win(250, 500, 8).end - win(250, 500, 8).start === 8)
}

// ── 2. scope modes: /resume = all, /sessions = project ──────────────────────
{
  const view = src('src', 'components', 'mercury-ui', 'screens', 'SessionManagerView.tsx')
  // The scope mechanism moved WHOLE into the one picker core
  // (sessionPickerModel.ts — the Boot face's resume entrance presents the
  // same rows); these needles follow it there. The laws are unchanged; the
  // '· cleared' paint stays the skin's.
  const model = src('src', 'components', 'mercury-ui', 'screens', 'sessionPickerModel.ts')
  const resume = src('src', 'commands', 'resume', 'resume.tsx')
  const sessions = src('src', 'commands', 'sessions', 'sessions.tsx')
  check('argless /resume mounts the FULL-history scope', resume.includes('initialScope="all"'))
  check('/sessions stays the quick project scope (no all override)', !sessions.includes('initialScope'))
  check(
    "the core keeps cleared sessions in 'all' scope",
    /facts\.scope === 'project'\s*\?\s*partitionByProject\(/.test(model) &&
      model.includes("{ inProject: operatorLogs, elsewhere: [] as LogOption[] }"),
  )
  check(
    "'all' scope marks cleared sessions instead of hiding them (the hook binds the live cleared cache; the skin paints the mark)",
    model.includes("facts.scope === 'all' ? facts.isCleared(getSessionIdFromLog(log)) : undefined") &&
      model.includes('isCleared: id => isSessionCleared(id)') &&
      view.includes('· cleared'),
  )
  check("the `a` control flips scope in-view", view.includes("input === 'a'") && view.includes("s === 'project' ? 'all' : 'project'"))
  check(
    'no misleading "+N older — /resume reaches the full history" copy remains',
    !view.includes('/resume reaches the full history'),
  )
  check(
    'overflow rows are honest, live scroll indicators',
    view.includes('newer — ↑ scrolls') && view.includes('older — ↓ scrolls'),
  )
  check(
    'the cursor space is the FULL list, not the visible slice',
    view.includes('const navLen = flat.length + crewShown.length'),
  )
}

// ── 3. stale /sessiontab target notices, never a silent misflip ─────────────
{
  const flip = src('src', 'commands', 'sessiontab', 'sessiontab.tsx')
  check(
    'a stale/vanished id produces an explicit notice',
    flip.includes("no longer in this project's flip ring"),
  )
  check(
    'a stale id can NEVER fall back to a different session',
    !flip.includes('?? resumable[0]'),
  )
}

// ── 4. resuming a cleared session is the deliberate reopen ──────────────────
{
  const { markSessionCleared, unmarkSessionCleared, isSessionCleared, resetClearedSessionsMemo } =
    await import('../../src/utils/sessionStorage/clearedSessions.ts')
  // Hermetic: point the config home at a scratch dir.
  const os = await import('node:os')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cleared-proof-'))
  process.env.MERCURY_CONFIG_DIR = dir
  resetClearedSessionsMemo()
  markSessionCleared('sess-reopen')
  resetClearedSessionsMemo()
  check('marked session reads cleared', isSessionCleared('sess-reopen') === true)
  unmarkSessionCleared('sess-reopen')
  resetClearedSessionsMemo()
  check('unmark (the resume reopen) makes it visible again', isSessionCleared('sess-reopen') === false)
  unmarkSessionCleared('never-marked') // zero-io no-op — must not throw
  check('unmark of an unknown id is a safe no-op', true)
  delete process.env.MERCURY_CONFIG_DIR
  fs.rmSync(dir, { recursive: true, force: true })

  // A resume is a HOP onto a managed session: the cleared mark belonged to
  // the in-process clear path; the session's runner holds one id for its
  // life, so nothing is marked cleared and nothing needs un-clearing.
  const repl = src('src', 'screens', 'REPL.tsx')
  check(
    'REPL resume() hops through the one resume door (no cleared-mark bookkeeping on the face)',
    repl.includes('await focusResumedSession(String(sessionId)') && !repl.includes('unmarkSessionCleared'),
  )
}

// ── 5. the atomic-switch + invocation-time deps stay held (regression pins) ─
{
  const repl = src('src', 'screens', 'REPL.tsx')
  check(
    'resume() deps carry the live setters it closes over (stale-closure fix held)',
    /\}, \[addNotification, removeNotification, setToolJSX\]\);/.test(repl),
  )
  check(
    'the staged switch shows a truthful opening status',
    repl.includes('text: `opening ${label}…`'),
  )
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} RESUME-FULL-HISTORY CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL RESUME-FULL-HISTORY PROOFS PASS')
