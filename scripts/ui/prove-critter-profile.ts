#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-critter-profile.ts — the persistent companion PROFILE
//  oracle (mercury-feel; DoD: "a selected critter retains one local
//  profile across sessions").
//
//    §1 first creation assigns ONE seed; relaunch (fresh import/memo) keeps it
//    §2 the seen-tip memory and the opened-surface memory persist across a
//       relaunch; an already-opened surface never re-writes the profile
//    §3 corrupt profile → fresh seed with the honest recoveredAt stamp
//    §4 milestones accumulate real events; quiet round-trips
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-critter-profile.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'critter-profile-'))
process.env.MERCURY_CONFIG_DIR = home

const {
  critterProfile,
  recordCompanionMilestone,
  resetCritterProfileForTests,
  setCompanionQuiet,
  companionQuietPreference,
  markTipSeen,
  seenTipStamps,
  noteCompanionSurfaceOpened,
  openedSurfaceSet,
} = await import('../../src/utils/cockpit/critterProfile.js')
const { statSync } = await import('node:fs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-critter-profile')

// §1 — seed assigned once, survives a "relaunch" (memo reset = new process read)
const first = critterProfile()
check('§1 a fresh home creates a profile with a seed', typeof first.seed === 'string' && first.seed.length > 10)
check('§1 fresh profile carries no recovery stamp', first.recoveredAt === undefined)
resetCritterProfileForTests() // simulate a relaunch (re-read from disk)
const second = critterProfile()
check('§1 relaunch keeps the SAME seed (no reroll, ever)', second.seed === first.seed)

// §2 — the seen-tip memory and the opened-surface memory persist
{
  markTipSeen('context.compact', 1_700_000_000_000)
  noteCompanionSurfaceOpened('mcp')
  noteCompanionSurfaceOpened('context')
  resetCritterProfileForTests() // relaunch
  check('§2 a shown tip is remembered across a relaunch', seenTipStamps()['context.compact'] === 1_700_000_000_000)
  check('§2 opened surfaces are remembered across a relaunch (sorted, unique)', [...openedSurfaceSet()].join(',') === 'context,mcp')
  const path = join(home, 'critter-profile.json')
  const before = statSync(path).mtimeMs
  noteCompanionSurfaceOpened('mcp')
  check('§2 an already-opened surface never re-writes the profile', statSync(path).mtimeMs === before)
  check('§2 the seed is untouched by the memories', critterProfile().seed === second.seed)
}

// §3 — corrupt profile: honest recovery
{
  writeFileSync(join(home, 'critter-profile.json'), '{ not json')
  resetCritterProfileForTests()
  const recovered = critterProfile()
  check('§3 corrupt profile recovers with a FRESH seed', recovered.seed !== first.seed)
  check('§3 the recovery is honestly stamped (recoveredAt)', typeof recovered.recoveredAt === 'number')
  resetCritterProfileForTests()
  check('§3 the recovered profile persists (no repeated reroll)', critterProfile().seed === recovered.seed)
}

// §4 — milestones + quiet
{
  const before = critterProfile().milestones.settles
  recordCompanionMilestone('settle')
  recordCompanionMilestone('recovery')
  const m = critterProfile().milestones
  check('§4 settle + recovery both count as settles', m.settles === before + 2, `${m.settles}`)
  check('§4 recovery counted once', m.recoveries === 1)
  recordCompanionMilestone('firstVerified')
  const t1 = critterProfile().milestones.firstVerifiedAt
  recordCompanionMilestone('firstVerified')
  check('§4 firstVerified stamps exactly once', critterProfile().milestones.firstVerifiedAt === t1 && typeof t1 === 'number')
  setCompanionQuiet(true)
  resetCritterProfileForTests()
  check('§4 quiet preference survives a relaunch', companionQuietPreference() === true)
  setCompanionQuiet(false)
  // Disk round-trip sanity: the file is real JSON with the same seed.
  const onDisk = JSON.parse(readFileSync(join(home, 'critter-profile.json'), 'utf8')) as { seed?: string }
  check('§4 the on-disk profile matches the memo', onDisk.seed === critterProfile().seed)
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ prove-critter-profile: all green' : `\n✗ prove-critter-profile: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
