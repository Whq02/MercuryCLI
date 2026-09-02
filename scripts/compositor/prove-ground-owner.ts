#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-ground-owner.ts — MERCURY Fill law: ONE terminal-
//  ground lifecycle owner (OSC 11), single saved original, exactly-once
//  restoration.
//
//  Previously the default-background channel had THREE independent writers
//  (oasisBg NIGHT/111 · warmBackground query→paint→restore-exact · the
//  launcher splash's own #070D12) and three recorded failure rows:
//    B  splash → oasis-disabled session: nobody restores → stranded #070D12;
//    D  splash → light theme + warm: warm "restores" the SPLASH's ground;
//    E  dark→light switch + warm: exit re-paints NIGHT over the profile.
//  utils/cockpit/oasisBg.ts is now the one owner; warmBackground.ts is a
//  facade. Each case below runs in its OWN bun subprocess (the
//  launcherHeldAtBoot latch and module state are boot facts — per-case
//  process isolation is the honest harness).
// ============================================================================
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BUN = process.execPath

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** Run a snippet in a fresh bun process; returns stdout. The snippet imports
 *  the owner fresh, drives it with an in-memory writer, prints JSON. */
function inProc(snippet: string, env: Record<string, string | undefined> = {}): unknown {
  const code = `
    // The owner's gates read the REAL stdout TTY state; the subprocess pipes
    // stdout, so stub the boot fact the gates key on (the proof drives the
    // lifecycle, not the gate — the gate matrix is pinned by
    // scripts/ui/prove-appearance-system.ts).
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    process.env.TERM = 'xterm-256color'
    const out = []
    const w = (s) => out.push(s)
    const mod = await import(${JSON.stringify(join(REPO, 'src/utils/cockpit/oasisBg.ts'))})
    const warm = await import(${JSON.stringify(join(REPO, 'src/utils/cockpit/warmBackground.ts'))})
    ${snippet}
    console.log('%%%' + JSON.stringify(result) + '%%%')
  `
  const stdout = execFileSync(BUN, ['-e', code], {
    cwd: REPO,
    env: { ...process.env, MERCURY_OASIS_BG: undefined, MERCURY_WARM_BG: undefined, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  }).toString()
  const m = stdout.match(/%%%(.*)%%%/s)
  if (!m) throw new Error(`no result marker in: ${stdout.slice(-300)}`)
  // A default-writer call inside the snippet (e.g. the warm facade's exit
  // seam) would bypass the injected writer and land OSC bytes on the real
  // stdout — that is a LEAK the in-memory `out` assertions cannot see.
  const outside = stdout.replace(/%%%.*%%%/s, '')
  if (outside.includes('\x1b]1')) {
    throw new Error(`ground bytes leaked outside the injected writer: ${JSON.stringify(outside.slice(0, 120))}`)
  }
  return JSON.parse(m[1]!)
}

const SET_NIGHT_RE = /^\x1b\]11;#[0-9A-Fa-f]{6}\x07$/
const RESET_111 = '\x1b]111\x07'

console.log('the ONE terminal-ground lifecycle owner')

// Case 1 — dark boot + warm query: the reply arrives after our paint and is
// DISCARDED (it is our own canvas); exit restores 111 exactly once across
// BOTH exit seams (cleanupTerminalModes' facade call + the exit hook).
{
  const r = inProc(`
    mod.syncOasisBgToTheme('dark', w)          // boot paint (dark family)
    mod.markOriginalGroundQuerySent()          // App sends the OSC 11 query
    mod.noteOriginalGroundReply('#0d181b', w)  // reply = our own canvas
    mod.exitOasisBg(w)                         // seam 1 (cleanupTerminalModes)
    mod.exitOasisBg(w)                         // seam 2 (process-exit hook)
    const result = out
  `) as string[]
  check('C1 dark+warm: boot paints NIGHT once', r.length >= 1 && SET_NIGHT_RE.test(r[0]!))
  check('C1 dark+warm: post-paint reply is discarded (exit = 111, not a re-set)', r[1] === RESET_111)
  check('C1 exit restoration is exactly-once across both seams', r.length === 2, JSON.stringify(r))
}

// Case 2 — unpainted boot (light family / oasis off) + warm: the reply IS the
// user's ground — warm paints, and exit restores the exact original.
{
  const r = inProc(`
    mod.markOriginalGroundQuerySent()
    mod.noteOriginalGroundReply('rgb:1313/1212/1010', w)
    mod.exitOasisBg(w)
    mod.exitOasisBg(w)
    const result = out
  `) as string[]
  check('C2 unpainted+warm: warm paints the canvas', r.length >= 1 && SET_NIGHT_RE.test(r[0]!))
  check('C2 unpainted+warm: exit restores the EXACT saved original', r[1] === '\x1b]11;rgb:1313/1212/1010\x07')
  check('C2 exactly-once', r.length === 2, JSON.stringify(r))
}

// Case 3 — matrix row E: dark boot + warm, live switch to a light family,
// then exit. The switch hands the ground back; exit must write NOTHING MORE
// (the old warm path re-painted NIGHT here — the "left recoloured" leak).
{
  const r = inProc(`
    mod.syncOasisBgToTheme('dark', w)
    mod.markOriginalGroundQuerySent()
    mod.noteOriginalGroundReply('#0d181b', w)
    mod.syncOasisBgToTheme('light', w)
    warm.restoreOriginalBackground()           // the facade exit seam
    mod.exitOasisBg(w)
    const result = out
  `) as string[]
  check('C3 row E: light switch releases with 111', r[1] === RESET_111)
  check('C3 row E: exit writes NOTHING after the release (terminal stays the user’s)', r.length === 2, JSON.stringify(r))
}

// Case 4 — matrix rows B/D: a launcher handoff (MERCURY_ALT_HELD=1 at boot)
// on a session that never paints (light family). The splash recoloured the
// ground before this process existed: the query reply is the SPLASH's
// ground (never saved as "the user's"), and exit heals with 111 even though
// this process never painted.
{
  const r = inProc(
    `
    mod.markOriginalGroundQuerySent()
    mod.noteOriginalGroundReply('#070d12', w)  // the splash's ground, not the user's
    mod.syncOasisBgToTheme('light', w)         // stays unpainted-released
    mod.exitOasisBg(w)
    mod.exitOasisBg(w)
    const result = out
  `,
    { MERCURY_ALT_HELD: '1' },
  ) as string[]
  // The reply still paints the warm canvas (the journey already recoloured
  // the terminal), then the light-family release + exit collapse to exactly
  // one 111 — never a re-set of the splash's spec.
  check('C4 rows B/D: the splash-era reply is never saved as the user’s ground', !r.includes('\x1b]11;#070d12\x07'), JSON.stringify(r))
  check('C4 rows B/D: the launcher handoff is healed with 111', r.filter(s => s === RESET_111).length === 1, JSON.stringify(r))
}

// Case 5 — launcher handoff + oasis disabled entirely (row B exactly):
// nothing ever painted, no query — exit still heals the splash's set.
{
  const r = inProc(
    `
    mod.exitOasisBg(w)
    mod.exitOasisBg(w)
    const result = out
  `,
    { MERCURY_ALT_HELD: '1' },
  ) as string[]
  check('C5 row B: unpainted launcher session heals the splash ground once', r.length === 1 && r[0] === RESET_111, JSON.stringify(r))
}

// Case 5b — launcher handoff but the splash COULDN'T have recoloured: no
// spurious OSC 111 — an externally-set dynamic ground must survive
// Round 7: the splash's OSC-11 predicate is
// TRUECOLOR + the OASIS_BG opt-out, so the suppressing envs are the
// truecolor-off spellings (canonical + legacy) and NO_COLOR.
{
  const r = inProc(
    `
    mod.exitOasisBg(w)
    const result = out
  `,
    { MERCURY_ALT_HELD: '1', MERCURY_TRUECOLOR: '0' },
  ) as string[]
  check('C5b truecolor-off handoff writes nothing at exit', r.length === 0, JSON.stringify(r))
  const r2 = inProc(
    `
    mod.exitOasisBg(w)
    const result = out
  `,
    { MERCURY_ALT_HELD: '1', MERCURY_TRUECOLOR: '0' },
  ) as string[]
  check('C5b legacy truecolor-off spelling suppresses identically', r2.length === 0, JSON.stringify(r2))
  const r3 = inProc(
    `
    mod.exitOasisBg(w)
    const result = out
  `,
    { MERCURY_ALT_HELD: '1', NO_COLOR: '1' },
  ) as string[]
  check('C5b NO_COLOR handoff writes nothing at exit (the splash never recoloured)', r3.length === 0, JSON.stringify(r3))
}

// Case 5c — launcher handoff under MERCURY_OASIS_BG=0: the splash honors the
// same opt-out for its OWN set,
// so the heal stays silent and =0 remains byte-identical.
{
  const r = inProc(
    `
    mod.exitOasisBg(w)
    const result = out
  `,
    { MERCURY_ALT_HELD: '1', MERCURY_OASIS_BG: '0' },
  ) as string[]
  check('C5c OASIS_BG=0 handoff writes nothing at exit', r.length === 0, JSON.stringify(r))
  const splashSrc = (await import('node:fs')).readFileSync(join(REPO, 'assets/splash/mercury-splash.mjs'), 'utf8')
  check(
    // The gate reads the ONE opt-out spelling — the same flag the runtime
    // registry names (MERCURY_OASIS_BG, no alias rung). Round 7: the
    // splash's whole OSC-11 predicate is OSC11_GROUND (TRUECOLOR + the
    // opt-out) — the mirror above must track it.
    'C5c the splash gates its own OSC 11 on the same flag (the one spelling)',
    /TRUECOLOR && process\.env\.MERCURY_OASIS_BG !== '0'/.test(splashSrc),
  )
}

// Case 8 — the warm canvas is FAMILY-AGNOSTIC by contract: a light-theme
// sync must not revert it (only the OASIS acquisition follows the theme);
// it releases at exit with the exact original (verify-wave drift note).
{
  const r = inProc(`
    mod.markOriginalGroundQuerySent()
    mod.noteOriginalGroundReply('rgb:1111/2222/3333', w)  // warm paints on a light family
    mod.syncOasisBgToTheme('light', w)                    // e.g. opening /appearance
    mod.exitOasisBg(w)
    const result = out
  `) as string[]
  check('C8 warm canvas survives a light-family sync', r.length >= 1 && SET_NIGHT_RE.test(r[0]!) && r[1] !== RESET_111)
  check('C8 …and exits with the EXACT original', r[1] === '\x1b]11;rgb:1111/2222/3333\x07', JSON.stringify(r))
}

// Case 6 — no launcher, never painted: exit writes NOTHING (a terminal we
// never recoloured is untouched).
{
  const r = inProc(`
    mod.exitOasisBg(w)
    const result = out
  `) as string[]
  check('C6 untouched terminal stays untouched', r.length === 0, JSON.stringify(r))
}

// Case 7 — the splash restores its own ground on the NO-HOLD exit path and
// stays SILENT on the hold branch (the child owns the channel there).
// Anchored to restoreAndBrand's actual branch split, not a whole-file grep
//
{
  const src = (await import('node:fs')).readFileSync(join(REPO, 'assets/splash/mercury-splash.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('function restoreAndBrand()'))
  // The strengthened guard: a CANCELLED boot takes the restore
  // path (no child is coming to own the channel) — the hold-silent law now
  // applies only to a real handoff.
  const holdSplit = fn.indexOf('if (HOLD_ALT_FOR_HANDOFF && !cancelled) {')
  const elseAt = fn.indexOf('} else {', holdSplit)
  const holdBranch = holdSplit >= 0 && elseAt > holdSplit ? fn.slice(holdSplit, elseAt) : ''
  const elseBranch = elseAt >= 0 ? fn.slice(elseAt, elseAt + 700) : ''
  check('C7 splash no-hold exit hands the profile ground back (OSC 111 in the else branch)', /\\x1b\]111\\x07/.test(elseBranch))
  check('C7 splash hold branch never restores (the child owns the channel)', holdBranch !== '' && !/\]111/.test(holdBranch))
}

if (failures > 0) {
  console.error(`\n❌ ${failures} GROUND-OWNER PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL GROUND-OWNER PROOFS PASS')
