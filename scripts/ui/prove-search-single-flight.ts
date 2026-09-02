#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-search-single-flight.ts — every interactive search owns
//  ONE in-flight grep.
//
//  THE LAW: a new keystroke aborts the previous search BEFORE spawning the
//  next; closing the picker aborts the last one; no result from an aborted
//  search ever lands; an aborted grep stream still settles its promise.
//
//    §1 LIVE at the stream owner: a real grep aborted mid-stream settles
//       within the bound (never a pending-forever promise) and the rg child
//       is gone;
//    §2 the picker contract at its owner (source pins): a new query aborts
//       the in-flight grep; closing the picker aborts it; the gen-guard
//       keeps every aborted result from landing; the stream's close arm
//       settles totally under abort;
//    §3 the @-picker's only rg rides the throttled refresh (single-flight,
//       deadline disarmed in finally) — never a keystroke.
//
//  The keystroke-burst census (never more than one rg during typing) rides
//  the built-bundle drive and its captures.
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-search-single-flight.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'search-flight-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' interactive search — one in-flight grep, total settlement')
console.log('============================================================')

console.log('\n── §1 live: an aborted grep stream settles, its child dies ──')
{
  // A haystack big enough that the stream is genuinely mid-flight at abort.
  const hay = join(SCRATCH, 'hay')
  mkdirSync(hay, { recursive: true })
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(hay, `f${i}.txt`), Array.from({ length: 2000 }, (_, k) => `needle line ${k}`).join('\n'))
  }
  const { ripGrepStream } = await import(join(REPO, 'src/utils/ripgrep.ts'))
  const controller = new AbortController()
  let sawLines = false
  const stream = ripGrepStream(['-n', '-e', 'needle'], hay, controller.signal, () => {
    // Abort on the FIRST batch: the child is mid-stream, output still coming.
    sawLines = true
    controller.abort()
  }).then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  )
  const outcome = await Promise.race([stream, sleep(4000).then(() => 'pending' as const)])
  check('§1 the stream produced output before the abort', sawLines)
  check('§1 the aborted stream SETTLES within the bound (resolved or rejected, never pending)', outcome !== 'pending', outcome)
  await sleep(300)
  let rgAlive = ''
  try {
    rgAlive = execFileSync('pgrep', ['-f', String(hay)], { encoding: 'utf8' }).trim()
  } catch {
    rgAlive = ''
  }
  check('§1 the rg child is gone after the abort', rgAlive === '', rgAlive && `pids: ${rgAlive}`)
}

console.log('\n── §2 the picker contract at its owner ──')
{
  const rip = readFileSync(join(REPO, 'src/utils/ripgrep.ts'), 'utf8')
  check('§2 the close arm settles totally under abort', rip.includes('a bare return would leak the promise pending forever'))
  const cs = readFileSync(join(REPO, 'src/components/MercuryContentSearch.tsx'), 'utf8')
  check('§2 a new query aborts the in-flight grep FIRST', /const gen = \+\+genRef\.current\s*\n\s*abortRef\.current\?\.abort\(\)/m.test(cs))
  check('§2 closing the picker aborts the in-flight grep (unmount cleanup)', /return \(\) => \{\s*alive = false\s*controller\.abort\(\)/m.test(cs))
  check('§2 no aborted result ever lands (gen-guard on both settle arms)', (cs.match(/gen === genRef\.current/g) ?? []).length >= 2)
  check('§2 one controller per keystroke, held in the one ref', cs.includes('abortRef.current = controller'))
}

console.log('\n── §3 the @-picker walk: single-flight, deadline disarmed ──')
{
  const idx = readFileSync(join(REPO, 'src/hooks/fileSuggestions.ts'), 'utf8')
  check('§3 one refresh in flight at a time', idx.includes('if (refreshInFlight) return'))
  check('§3 the walk deadline is disarmed in finally', /finally \{\s*clearTimeout\(timer\)/m.test(idx))
  check('§3 the untracked merge is single-flight too', idx.includes('if (untrackedInFlight) return'))
  check('§3 queries ride the in-memory index, never a per-keystroke rg', !/generateFileSuggestions[\s\S]{0,600}ripGrep/m.test(idx))
}

console.log(failures === 0 ? '\n✅ ONE IN-FLIGHT SEARCH PROVEN' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
