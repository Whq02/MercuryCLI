#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-managed-precedence.ts — the Mercury
//  managed policy root outranks the compat policy root, on the PURE
//  resolution core (fixture-injected existence — no machine state read).
//
//    §A both roots exist ⇒ Mercury wins (native managed path first);
//    §B only the compat root exists ⇒ it is honored as bounded compat INPUT;
//    §C neither exists ⇒ the Mercury path is documented (fresh machine);
//    §D an unreadable Mercury probe degrades to the next candidate, never
//       a throw;
//    §E the candidate tables put Mercury first on EVERY platform.
// ============================================================================
import {
  managedRootCandidates,
  resolveManagedRoot,
} from '../../src/utils/settings/managedPath.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

// The pure-resolution legs run on a synthetic two-root table (the live
// tables are single-candidate; a fixture second root keeps the ordering laws
// under real tension instead of comparing against undefined).
const [mercuryRoot] = managedRootCandidates('macos')
const fixtureSecondRoot = '/etc/fixture-policy-root'

console.log('§A both exist ⇒ the first candidate outranks the second')
check('the first root wins when both exist', resolveManagedRoot([mercuryRoot, fixtureSecondRoot], () => true) === mercuryRoot)

console.log('§B only the second root exists ⇒ it is honored')
check('the second root is honored when it is the only one', resolveManagedRoot([mercuryRoot, fixtureSecondRoot], p => p === fixtureSecondRoot) === fixtureSecondRoot)

console.log('§C neither exists ⇒ the first (Mercury) path is documented')
check('a fresh machine documents the Mercury path', resolveManagedRoot([mercuryRoot, fixtureSecondRoot], () => false) === mercuryRoot)

console.log('§D an unreadable probe degrades, never throws')
check(
  'a throwing first probe falls through to the next candidate',
  resolveManagedRoot([mercuryRoot, fixtureSecondRoot], p => {
    if (p === mercuryRoot) throw new Error('EPERM')
    return true
  }) === fixtureSecondRoot,
)

console.log('§E every platform table is Mercury-named, one spelling each')
for (const platform of ['macos', 'windows', 'linux'] as const) {
  const candidates = managedRootCandidates(platform)
  check(
    `${platform}: at least one candidate, every one Mercury-named`,
    candidates.length >= 1 && candidates.every(c => /mercury/i.test(c)),
    candidates.join(' | '),
  )
}
{
  const windows = managedRootCandidates('windows')
  check(
    'windows: the machine-policy root is the %ProgramData% spelling, never Program Files',
    /ProgramData/i.test(windows[0] ?? '') && (windows[0] ?? '').endsWith('\\Mercury') && windows.every(c => !/Program Files/i.test(c)),
    windows.join(' | '),
  )
}

console.log(failures === 0 ? '\n ✅ MANAGED PRECEDENCE PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
