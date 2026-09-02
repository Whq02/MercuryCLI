#!/usr/bin/env bun
// ============================================================================
//  scripts/terminal-boundary/prove-crash-surface.ts — §7: render failures project
//  product truth, never the raw ink dump. BOTH journeys run on the SHIPPED
//  dist in a hermetic PTY (the flux arena) — no source mocks:
//
//  B1  app-root crash (MERCURY_RENDER_FAULT=repl): the final frame is the
//      Mercury crash card — what happened · what survived · the crash-report
//      reference · the next action; the process exits via the loud stderr
//      consequence line; a crash report with origin app-root is retained
//      under the hermetic profile; NO bundle file:line:col and NO raw stack
//      frames appear anywhere in the PTY bytes (the raw ink screen dumped
//      both).
//
//  B2  per-message crash (MERCURY_RENDER_FAULT=message): a completed tool
//      result's renderer dies; the transcript shows ONE quiet product line
//      naming the retained crash report (not the silent null that hid
//      content); the SESSION SURVIVES — the next model turn still renders;
//      a crash report with origin message-boundary is retained; the raw
//      fault text never paints.
//
//  (In-process staticRender legs were tried first and hang under bun's
//  prover context — the artifact journeys are the stronger proof anyway.)
//
//  Run:  ~/.bun/bin/bun run scripts/terminal-boundary/prove-crash-surface.ts
//  Requires the prebuilt dist (the pooled gate prebuilds it).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireDist, runArtifactArena, visibleText, type ArenaRun } from '../streaming/artifactArena.ts'

/** The FULL PTY byte truth: decode the drive.jsonl {ts,b64} records and
 *  strip ANSI. driverOut is only ptydrive's own stderr log — never assert on
 *  it (the first cut of this prover did, and read teardown lines). */
function ptyText(run: ArenaRun): string {
  const raw = readFileSync(run.paths.drive, 'utf8')
  let bytes = ''
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as { b64?: string }
      if (rec.b64) bytes += Buffer.from(rec.b64, 'base64').toString('utf8')
    } catch {
      // driver preamble lines are not part of the byte stream
    }
  }
  return visibleText(bytes)
}

/** The PTY differ positions words with cursor moves, not literal spaces —
 *  every text needle matches on the whitespace-stripped stream. */
const flat = (x: string): string => x.replace(/\s+/g, '')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — crash-surface proofs exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

requireDist()

function crashReports(home: string): Array<{ file: string; origin?: string; message?: string }> {
  const dir = join(home, '.claude', 'crashes')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.startsWith('crash-'))
    .map(f => {
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { origin?: string; message?: string }
        return { file: f, origin: rec.origin, message: rec.message }
      } catch {
        return { file: f }
      }
    })
}

// ── B1 app-root crash: the whole journey on the shipped dist ────────────────
section('B1 — app-root crash: product card · loud exit · retained report · no dump')
{
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 10,
    cols: 100,
    rows: 30,
    keep: true,
    extraEnv: { MERCURY_RENDER_FAULT: 'repl' },
  })
  try {
    const all = flat(ptyText(run))
    check('the crash card paints (product headline)', all.includes(flat('Mercury hit a render error')), all.slice(-500))
    check('the card states what survived', all.includes('preserved'))
    check('the card references the retained crash report', all.includes(flat('crash report')))
    check('the card offers the next action', all.includes(flat('Restart Mercury')))
    check('the loud exit line lands (consequence + next action)', all.includes(flat('Mercury exited on an error')), all.slice(-500))
    check('the health next-action lands', all.includes(flat('health for diagnostics')))
    check('NO bundle positions anywhere in the PTY bytes', !/mercury\.mjs:\d+/.test(all), (all.match(/.{0,60}mercury\.mjs:\d+.{0,20}/) ?? [''])[0])

    const reports = crashReports(run.paths.home)
    check('a crash report was retained under the hermetic profile', reports.length > 0)
    check(
      'the report records origin app-root + the injected fault',
      reports.some(r => r.origin === 'app-root' && (r.message ?? '').includes('MERCURY_RENDER_FAULT')),
      JSON.stringify(reports),
    )
  } finally {
    run.cleanup()
  }
}

// ── B2 per-message crash: visible degradation, session survives ─────────────
section('B2 — per-message crash: one quiet line · session survives · retained report')
{
  const run = await runArtifactArena({
    turns: [
      { kind: 'tool_use', name: 'Glob', input: { pattern: '*.zzz-none' } },
      { kind: 'text', text: 'PROOF-AFTER-FAULT still alive.' },
    ],
    sends: ['5500:run the glob probe', '6200:\\r'],
    seconds: 25,
    cols: 100,
    rows: 30,
    keep: true,
    extraEnv: { MERCURY_RENDER_FAULT: 'message' },
  })
  try {
    const all = flat(ptyText(run))
    check('the boundary degrades VISIBLY in product language', all.includes(flat('a part of this view could not be rendered')), all.slice(-700))
    check('the note references the retained crash report', all.includes(flat('crash report')))
    check('the SESSION SURVIVES — the next model turn renders', all.includes(flat('PROOF-AFTER-FAULT still alive.')), all.slice(-700))
    check('the raw fault text never paints', !all.includes(flat('deliberate render fault (message)')))

    const reports = crashReports(run.paths.home)
    check(
      'a message-boundary crash report was retained',
      reports.some(r => r.origin === 'message-boundary' && (r.message ?? '').includes('MERCURY_RENDER_FAULT')),
      JSON.stringify(reports),
    )
  } finally {
    run.cleanup()
  }
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ crash-surface proofs: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ crash-surface proofs: all legs green')
process.exit(0)
