#!/usr/bin/env bun
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

console.log('§2 SL-2 — the manager walks the whole stat listing')
{
  const view = read('src/components/mercury-ui/screens/SessionManagerView.tsx')
  const core = read('src/components/mercury-ui/screens/sessionPickerModel.ts')
  check('POISON: the capped one-shot load is gone', !view.includes('const all = await loadAllProjectsMessageLogs()') && !core.includes('const all = await loadAllProjectsMessageLogs()'))
  check('the view never loads on its own (one picker core)', !view.includes('loadAllProjectsMessageLogs') && view.includes('useSessionPickerModel(scope)'))
  check('the first paint comes from the progressive loader and keeps its cursor + listing', core.includes('const first = await loadAllProjectsMessageLogsProgressive()') && core.includes('let next = first.nextIndex'))
  check('the rest of the listing is enriched batch by batch until the cursor reaches the end', core.includes('while (alive && next < first.allStatLogs.length) {') && core.includes('const batch = await enrichLogs(first.allStatLogs, next, ENRICH_BATCH)') && core.includes('next = batch.nextIndex'))
  check('every batch republishes the resumable, substantive, newest-first list', core.includes('const publish = (all: LogOption[]): void => {') && core.includes('acc = [...acc, ...batch.logs]\n          publish(acc)'))
  check('the header says how many are still loading', view.includes('pendingMore > 0 ? ` · loading ${pendingMore} more…` : \'\''))
  check('the empty state waits while sessions are still loading (no "No other sessions" over a half-read store)', view.includes('{logs === null || (flat.length === 0 && pendingMore > 0) ? ('))
  check('an unmount stops the walk (alive gate on the loop)', core.includes('while (alive && next < first.allStatLogs.length)'))
  const logs = read('src/utils/sessionStorage/logs.ts')
  check('the loader exposes the listing and cursor the manager now consumes', logs.includes('return { logs, allStatLogs: sorted, nextIndex }') && logs.includes('export async function enrichLogs('))
}

console.log('§3 SL-7 — resume-hint quoting: bash on POSIX, PS single-quote on win32')
{
  const { resumeHintArgument } = await import('../../src/utils/shutdownRestoration.ts')
  const title = `the "big" plan\\refit`
  check('POSIX keeps the exact bash-family escapes (byte-identical)', resumeHintArgument(title, 'sid', 'darwin') === `"the \\"big\\" plan\\\\refit"`)
  check("win32 speaks PowerShell's literal (single quotes, '' doubling)", resumeHintArgument(`it's here`, 'sid', 'win32') === `'it''s here'`)
  check('win32 never emits the bash escapes', !resumeHintArgument(title, 'sid', 'win32').includes('\\"'))
  check('no title ⇒ the session id, every host', resumeHintArgument(null, 'sid-9', 'win32') === 'sid-9' && resumeHintArgument('', 'sid-9', 'darwin') === 'sid-9')
}

process.exit(failures === 0 ? 0 : 1)
