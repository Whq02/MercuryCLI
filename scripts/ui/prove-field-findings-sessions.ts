#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-sessions.ts
// TASK-017 SUPPLEMENT 3 fixes — the session pickers.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-sessions.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · SL-1: a failed resume is a refusal line, never a frozen spinner ────
// Finding SL-1 (important): onSelect set isResuming and cleared it only on the
// typed refusal paths; every other failure THREW (the `if (!loaded) throw`
// and loadConversationForResume's own rethrow) into a call-site catch that
// rethrew again — an unhandled rejection under a spinner branch that binds
// no key, with ctrl+c disarmed on this root. The picker stays open with the
// refusal painted. POISON: the throw and the rethrow.
console.log('§1 SL-1 — every resume failure lands as a refusal on the picker')
{
  const screen = read('src/screens/ResumeConversation.tsx')
  check('POISON: the not-loaded throw is gone', !screen.includes("if (!loaded) throw new Error('Failed to load the selected conversation')"))
  check('a not-loaded conversation clears the spinner and paints the refusal', /if \(!loaded\) \{\s*\n(?:.*\n){0,6}?\s*setIsResuming\(false\)\s*\n\s*setResumeRefusal\(/.test(screen))
  check('POISON: the call-site rethrow is gone', !/void onSelect\(log\)\.catch\(error => \{\s*\n\s*logError\(error\)\s*\n\s*throw error/.test(screen))
  check('the call-site catch logs, clears the spinner and paints the refusal (the picker stays open)', /void onSelect\(log\)\.catch\(error => \{\s*\n(?:.*\n){0,6}?\s*logError\(error\)\s*\n\s*setIsResuming\(false\)\s*\n\s*setResumeRefusal\(/.test(screen) && screen.includes('the picker stays open; the file was left untouched'))
  check('the spinner branch still binds no key of its own (why the refusal path must exist)', screen.includes('text="Resuming conversation…"') && screen.includes('onCancel={cancelResumeWait}'))
  check('the refusal line paints above the picker', screen.includes('{resumeRefusal !== null ? (') && screen.includes('✕ {resumeRefusal}'))
}
// NEEDS-REAL-BOX: with the picker open, make the selected transcript
// unreadable (a write lock from another process), press ↵ — the refusal
// line paints and esc/↵/↑↓ still work.

// ── §2 · SL-2: /sessions and argless /resume see the whole store ────────────
// Finding SL-2 (important): the manager loaded loadAllProjectsMessageLogs()
// once — the progressive loader's first fifty ENRICHED rows across every
// project — and discarded the stat listing and its continuation cursor, so
// a busy week in another repo pushed this project's chats off the list while
// the header read "Full history — every project, cleared included" and the
// empty state "No other sessions in this project". The panel now walks the
// rest of the listing in batches after the first paint, says how many are
// still loading, and never claims emptiness while they are.
console.log('§2 SL-2 — the manager walks the whole stat listing')
{
  const view = read('src/components/mercury-ui/screens/SessionManagerView.tsx')
  check('POISON: the capped one-shot load is gone', !view.includes('const all = await loadAllProjectsMessageLogs()'))
  check('the first paint comes from the progressive loader and keeps its cursor + listing', view.includes('const first = await loadAllProjectsMessageLogsProgressive()') && view.includes('let next = first.nextIndex'))
  check('the rest of the listing is enriched batch by batch until the cursor reaches the end', view.includes('while (alive && next < first.allStatLogs.length) {') && view.includes('const batch = await enrichLogs(first.allStatLogs, next, ENRICH_BATCH)') && view.includes('next = batch.nextIndex'))
  check('every batch republishes the resumable, substantive, newest-first list', view.includes('const publish = (all: LogOption[]): void => {') && view.includes('acc = [...acc, ...batch.logs]\n          publish(acc)'))
  check('the header says how many are still loading', view.includes('pendingMore > 0 ? ` · loading ${pendingMore} more…` : \'\''))
  check('the empty state waits while sessions are still loading (no "No other sessions" over a half-read store)', view.includes('{logs === null || (flat.length === 0 && pendingMore > 0) ? ('))
  check('an unmount stops the walk (alive gate on the loop)', view.includes('while (alive && next < first.allStatLogs.length)'))
  const logs = read('src/utils/sessionStorage/logs.ts')
  check('the loader exposes the listing and cursor the manager now consumes', logs.includes('return { logs, allStatLogs: sorted, nextIndex }') && logs.includes('export async function enrichLogs('))
}
// NEEDS-REAL-BOX: >50 session files across ~/.mercury/projects, open /resume,
// press `a` — the header counts up past 50 with "loading N more…" until the
// whole store is listed; this project's chats appear regardless of the
// other repos' traffic.

// ── §3 · SL-7 — the resume hint quotes by the HOST's rules ──────
// The finder: the exit hint taught a resume command quoted by bash rules,
// which resolves to a DIFFERENT session title where Windows operators
// paste it (backslash is not a PowerShell escape). The argument builder is
// pure and platform-injectable; POSIX spelling is byte-identical to what
// it always was.
console.log('§3 SL-7 — resume-hint quoting: bash on POSIX, PS single-quote on win32')
{
  const { resumeHintArgument } = await import('../../src/utils/shutdownRestoration.ts')
  const title = `the "big" plan\\refit`
  check('POSIX keeps the exact bash-family escapes (byte-identical)', resumeHintArgument(title, 'sid', 'darwin') === `"the \\"big\\" plan\\\\refit"`)
  check("win32 speaks PowerShell's literal (single quotes, '' doubling)", resumeHintArgument(`it's here`, 'sid', 'win32') === `'it''s here'`)
  check('win32 never emits the bash escapes', !resumeHintArgument(title, 'sid', 'win32').includes('\\"'))
  check('no title ⇒ the session id, every host', resumeHintArgument(null, 'sid-9', 'win32') === 'sid-9' && resumeHintArgument('', 'sid-9', 'darwin') === 'sid-9')
}
// NEEDS-REAL-BOX (win32): end a titled session ("it's here") in pwsh7; paste
// the printed `mercury --resume '…'` line back — the SAME session resumes.

process.exit(failures === 0 ? 0 : 1)
