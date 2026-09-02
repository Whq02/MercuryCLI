#!/usr/bin/env bun
// ============================================================================
//  repro-projection — reproducer (EXPECT-RED until
//  M2).
//
//  The gap this repro pins: no shared teammate projection joins identity, session,
//  presence, lifecycle, focus, attention, unread, worktree and latest
//  activity. The Workbench projection (the engine precedent this pin follows)
//  derives thread/lane rows; presence lives in room frames; attention in its
//  own store — no single directory feeds cockpit, Console, Minerva target
//  selection, Workbench, ACP and VS Code. And no owner separates presence
//  (online|away|offline|unknown) from lifecycle (starting..failed) from
//  attention — the classifier snapshots are one content-derived status.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-05 — the teammate projection exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/projection.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/projection.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no shared teammate projection',
)
t.check('a subscribe seam exists (subscribeCrew)', typeof mod?.subscribeCrew === 'function')
t.check('a cached snapshot read exists (cachedCrewSnapshot)', typeof mod?.cachedCrewSnapshot === 'function')
t.check(
  'dormancy is observable (isCrewProjectionArmed — no subscriber ⇒ no timer/watcher)',
  typeof mod?.isCrewProjectionArmed === 'function',
)

t.section('CS-06 — presence, lifecycle and attention are distinct vocabularies')
t.check(
  'PRESENCE_STATES is exactly online|away|offline|unknown',
  Array.isArray(mod?.PRESENCE_STATES) &&
    JSON.stringify([...(mod!.PRESENCE_STATES as string[])].sort()) ===
      JSON.stringify(['away', 'offline', 'online', 'unknown']),
)
t.check(
  'LIFECYCLE_STATES carries starting|working|waiting|held|finishing|completed|failed',
  Array.isArray(mod?.LIFECYCLE_STATES) &&
    ['starting', 'working', 'waiting', 'held', 'finishing', 'completed', 'failed'].every(s =>
      (mod!.LIFECYCLE_STATES as string[]).includes(s),
    ),
)

t.section('CS-05 — the projection FEEDS every surface (the journey-final pins)')
{
  const { readFileSync } = await import('node:fs')
  // ACP/VS Code: the crew directory crosses the wire as an extension method.
  const acp = readFileSync('src/services/acp/acpServer.ts', 'utf8')
  t.check(
    'the ACP server registers the `_mercury/crew` wire (M8)',
    /_mercury\/crew/.test(acp),
    'no crew wire on the editor bridge yet',
  )
  // Cockpit: the WORK/workbench board (a former consumer of the crew
  // projection) retired in place with the WORK panel;
  // the projection keeps its /crew and resource
  // consumers.
  const crewCmd = readFileSync('src/commands/crew/index.ts', 'utf8')
  t.check(
    'the crew projection keeps a production consumer after the board retired (/crew)',
    /resolveCrewSnapshot/.test(crewCmd),
    'the crew projection lost its surface',
  )
  // Console/Minerva: the shared target picker resolves teammates from it.
  let picker = false
  try {
    picker = /crew\/projection|useCrew|resolveCrewSnapshot|cachedCrewSnapshot/.test(
      readFileSync('src/services/crew/targetPicker.ts', 'utf8'),
    )
  } catch {
    picker = false
  }
  t.check(
    'the shared target picker rides the crew projection (M6)',
    picker,
    'no shared target picker owner yet',
  )
}

t.finish('repro-projection')
